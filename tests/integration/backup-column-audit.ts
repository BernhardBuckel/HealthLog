/**
 * Column-level bookkeeping for the backup round trip.
 *
 * The round-trip test proves that a row of every two-ended model comes back.
 * It does not prove the row comes back WHOLE: a restore that writes the row
 * with a column defaulted returns the right count and loses the value. That is
 * how the medication category went missing, and how the aggregation
 * provenance did before it.
 *
 * So this reads every column of every two-ended model from the client's own
 * data model (the generated DMMF projection Prisma ships inside the client),
 * fills the ones the fixture left empty with a value that cannot be mistaken
 * for a default, and compares each column before the export with the same
 * column after the restore. A column added to a model tomorrow is in that list
 * automatically, so it is compared automatically: it either comes back, or it
 * is named in the exclusions with the reason it should not.
 *
 * Attributes the runtime data model does not carry (optional, list, default,
 * id, foreign key) are read from `schema.prisma`, and the two field lists are
 * required to agree, so neither source can quietly drift from the other.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encrypt } from "@/lib/crypto";
import { readDeclaredSchema } from "@/__tests__/helpers/prisma-schema-names";

const SCHEMA_PATH = resolve(__dirname, "../../prisma/schema.prisma");

export interface AuditColumn {
  model: string;
  name: string;
  kind: "scalar" | "enum";
  type: string;
  isList: boolean;
  isOptional: boolean;
  isId: boolean;
  isUpdatedAt: boolean;
  /** Named in an `@relation(fields: [...])` on this model. */
  isForeignKey: boolean;
  /** The `@default(...)` argument as written, or null. */
  defaultText: string | null;
}

export interface AuditModel {
  name: string;
  delegate: string;
  columns: AuditColumn[];
  /** Fields of the primary key, `@id` or `@@id([...])`. */
  primaryKey: string[];
  /** To-one relations: field name -> target model. */
  parents: Record<string, string>;
}

interface RuntimeField {
  name: string;
  kind: "scalar" | "enum" | "object";
  type: string;
}

interface RuntimeDataModel {
  models: Record<string, { fields: RuntimeField[] }>;
}

function runtimeDataModel(prisma: PrismaClient): RuntimeDataModel {
  const rdm = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })
    ._runtimeDataModel;
  if (!rdm?.models) {
    throw new Error(
      "the Prisma client no longer exposes its data model; the column audit " +
        "cannot list columns and must not pass on an empty list",
    );
  }
  return rdm;
}

interface SchemaFieldAttrs {
  isList: boolean;
  isOptional: boolean;
  isId: boolean;
  isUpdatedAt: boolean;
  defaultText: string | null;
}

/** Field attributes and block attributes of one `model` block. */
function schemaModelAttrs(source: string, model: string) {
  const start = source.search(new RegExp(`^model ${model} \\{`, "m"));
  if (start === -1) throw new Error(`model ${model} not in schema.prisma`);
  const end = source.indexOf("\n}", start);
  const lines = source
    .slice(start, end)
    .split("\n")
    .slice(1)
    .filter((line) => !/^\s*\/\//.test(line));

  const fields = new Map<string, SchemaFieldAttrs>();
  const foreignKeys = new Set<string>();
  let compoundId: string[] | null = null;

  for (const line of lines) {
    const block = /^\s*@@id\(\[([^\]]+)\]/.exec(line);
    if (block) {
      compoundId = block[1].split(",").map((s) => s.trim());
      continue;
    }
    const m = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, , list, optional, rest] = m;
    const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(rest);
    if (rel) {
      for (const fk of rel[1].split(",")) foreignKeys.add(fk.trim());
    }
    const def = /@default\(((?:[^()]|\([^()]*\))*)\)/.exec(rest);
    fields.set(name, {
      isList: Boolean(list),
      isOptional: Boolean(optional),
      isId: /(^|\s)@id\b/.test(rest),
      isUpdatedAt: /@updatedAt\b/.test(rest),
      defaultText: def ? def[1].trim() : null,
    });
  }
  return { fields, foreignKeys, compoundId };
}

export function readAuditModels(
  prisma: PrismaClient,
  models: readonly string[],
): AuditModel[] {
  const rdm = runtimeDataModel(prisma);
  const source = readFileSync(SCHEMA_PATH, "utf8");

  return models.map((name) => {
    const runtime = rdm.models[name];
    if (!runtime) throw new Error(`${name} is not in the client data model`);
    const attrs = schemaModelAttrs(source, name);

    const columns: AuditColumn[] = [];
    const parents: Record<string, string> = {};
    for (const field of runtime.fields) {
      const a = attrs.fields.get(field.name);
      if (!a) {
        throw new Error(
          `${name}.${field.name} is in the client data model but not in ` +
            `schema.prisma; regenerate the client`,
        );
      }
      if (field.kind === "object") {
        if (!a.isList) parents[field.name] = field.type;
        continue;
      }
      columns.push({
        model: name,
        name: field.name,
        kind: field.kind,
        type: field.type,
        isList: a.isList,
        isOptional: a.isOptional,
        isId: a.isId,
        isUpdatedAt: a.isUpdatedAt,
        isForeignKey: attrs.foreignKeys.has(field.name),
        defaultText: a.defaultText,
      });
    }

    const primaryKey =
      attrs.compoundId ?? columns.filter((c) => c.isId).map((c) => c.name);
    if (primaryKey.length === 0) throw new Error(`${name} has no primary key`);

    return {
      name,
      delegate: name.charAt(0).toLowerCase() + name.slice(1),
      columns,
      primaryKey,
      parents,
    };
  });
}

/**
 * The `where` that selects the rows one account owns: its own `userId` when
 * the model has one, otherwise through the nearest to-one parent that does.
 */
export function ownerWhere(
  models: ReadonlyMap<string, AuditModel>,
  prisma: PrismaClient,
  model: string,
  userId: string,
  depth = 0,
): Record<string, unknown> {
  const rdm = runtimeDataModel(prisma);
  const fields = rdm.models[model].fields;
  if (fields.some((f) => f.name === "userId" && f.kind === "scalar")) {
    return { userId };
  }
  if (depth > 3) throw new Error(`no owner path for ${model}`);
  const parents =
    models.get(model)?.parents ??
    Object.fromEntries(
      fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type]),
    );
  for (const [field, target] of Object.entries(parents)) {
    try {
      return {
        [field]: ownerWhere(models, prisma, target, userId, depth + 1),
      };
    } catch {
      continue;
    }
  }
  throw new Error(`no owner path for ${model}`);
}

/** A comparable, order-independent rendering of one value. */
export function normalise(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value instanceof Uint8Array) {
    return `bytes:${Buffer.from(value).toString("base64")}`;
  }
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "object" && "toFixed" in (value as object)) {
    return `decimal:${String(value)}`;
  }
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** Is this value the column's declared default (or its empty state)? */
export function isDefaultValue(column: AuditColumn, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (column.isList && Array.isArray(value) && value.length === 0) return true;
  const d = column.defaultText;
  if (d === null) return false;
  if (/^(now|uuid|cuid|autoincrement|dbgenerated)\(/.test(d)) return false;
  const literal = d.replace(/^"(.*)"$/, "$1");
  if (column.type === "Json") {
    try {
      return normalise(value) === normalise(JSON.parse(literal));
    } catch {
      return false;
    }
  }
  if (column.isList && Array.isArray(value)) {
    const items = d
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
      .filter((item) => item.length > 0);
    return normalise(value.map(String)) === normalise(items);
  }
  return String(value) === literal;
}

/**
 * A value of the column's type that is not its default, for a column the
 * fixture left empty. `overrides` supplies one where the type alone does not
 * produce something the export and the restore accept.
 */
export function syntheticValue(
  column: AuditColumn,
  enumValues: ReadonlyMap<string, string[]>,
  overrides: Readonly<Record<string, unknown>>,
): unknown {
  const key = `${column.model}.${column.name}`;
  if (key in overrides) {
    const v = overrides[key];
    return typeof v === "function" ? (v as () => unknown)() : v;
  }
  const tag = `rt-${column.model}-${column.name}`;
  const sealed = /Encrypted$/.test(column.name);
  let one: unknown;
  if (column.kind === "enum") {
    const values = enumValues.get(column.type) ?? [];
    const literal = column.defaultText;
    one = values.find((v) => v !== literal) ?? values[0];
  } else {
    switch (column.type) {
      case "String":
        one = sealed ? encrypt(tag) : tag;
        break;
      case "Int":
        one = column.defaultText === "3" ? 4 : 3;
        break;
      case "BigInt":
        one = BigInt(5);
        break;
      case "Float":
      case "Decimal":
        one = column.defaultText === "2.5" ? 3.5 : 2.5;
        break;
      case "Boolean":
        one = column.defaultText !== "true";
        break;
      case "DateTime":
        one = new Date("2026-06-30T12:34:56.789Z");
        break;
      case "Json":
        one = { roundTrip: tag };
        break;
      case "Bytes":
        // The codec most sealed byte columns share; a column on another one
        // names its own in the overrides.
        one = encryptToBytes(tag);
        break;
      default:
        throw new Error(`no synthetic value for ${key} (${column.type})`);
    }
  }
  return column.isList ? [one] : one;
}

export function enumValuesFromSchema(): Map<string, string[]> {
  return new Map(
    readDeclaredSchema(SCHEMA_PATH).enums.map((e) => [e.name, e.values]),
  );
}
