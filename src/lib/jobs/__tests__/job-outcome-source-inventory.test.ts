/**
 * Production success-fact inventory.
 *
 * `runJob` now serializes every successful handler result before pg-boss
 * completes the row. A newly introduced fact key that is not deliberately
 * reviewed would therefore fail the job at runtime. This source-level guard
 * keeps the fixed vocabulary and every production `jobDone({...})` call in
 * lockstep while the serializer's negative tests keep credentials, URLs,
 * identifiers, free text, nested payloads, and health values outside it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { requireFloor } from "@/__tests__/helpers/source-files";
import { JOB_FACT_ALLOWLIST } from "@/lib/jobs/job-outcome";

const JOBS_ROOT = join(process.cwd(), "src/lib/jobs");

function productionJobFiles(directory = JOBS_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionJobFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function objectFactKeys(
  object: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
): string[] {
  return object.properties.map((property) => {
    if (ts.isSpreadAssignment(property) || !property.name) {
      throw new Error(
        `jobDone facts must have explicit keys at ${source.fileName}:${
          source.getLineAndCharacterOfPosition(property.getStart()).line + 1
        }`,
      );
    }
    return property.name.getText(source).replace(/^["']|["']$/g, "");
  });
}

function declaredObject(
  source: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function successFactKeys(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const keys: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "jobDone" &&
      node.arguments.length > 0
    ) {
      const facts = node.arguments[0]!;
      if (ts.isObjectLiteralExpression(facts)) {
        keys.push(...objectFactKeys(facts, source));
      } else if (ts.isIdentifier(facts)) {
        const object = declaredObject(source, facts.text);
        if (!object) {
          throw new Error(
            `jobDone facts must resolve to a local object at ${file}:${
              source.getLineAndCharacterOfPosition(facts.getStart()).line + 1
            }`,
          );
        }
        keys.push(...objectFactKeys(object, source));
      } else {
        throw new Error(
          `jobDone facts must be an auditable object at ${file}:${
            source.getLineAndCharacterOfPosition(facts.getStart()).line + 1
          }`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

describe("durable production job-outcome fact inventory", () => {
  it("allows every explicit production success-fact key", () => {
    const facts = requireFloor(
      "jobDone fact keys",
      requireFloor("production job files", productionJobFiles(), 120).flatMap(
        (file) =>
          successFactKeys(file).map((key) => ({
            file: file.replace(`${process.cwd()}/`, ""),
            key,
          })),
      ),
      350,
    );
    const unknown = facts.filter(({ key }) => !JOB_FACT_ALLOWLIST.has(key));

    expect(unknown).toEqual([]);
  });

  it("keeps location, credential, capability, and health identifiers out", () => {
    for (const forbidden of [
      "rotate_active_key_id",
      "offhost_backup_endpoint",
      "offhost_backup_bucket",
      "restore_drill_object_key",
      "tls_pin_monitor_host",
      "intake_auto_skip_cutoff",
      "user_id",
      "access_token",
      "refresh_token",
      "health_value",
    ]) {
      expect(JOB_FACT_ALLOWLIST.has(forbidden), forbidden).toBe(false);
    }
  });
});
