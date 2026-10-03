import { z } from "zod/v4";

import { CUSTOM_SYMPTOM_ICON_ALLOWLIST } from "@/lib/cycle/custom-symptoms-shared";
import { validateEntryInstant } from "@/lib/validations/entry-instant";

/**
 * Person-defined symptoms (v1.40): client-safe constants, wire types and the
 * request schemas. Server-only helpers (label crypto, DTO mappers) live in
 * `./server.ts`, so the quick-entry sheet can import this file without pulling
 * `node:crypto` into the browser bundle.
 *
 * A definition is the person's own name for a symptom ("aura", "headache"); an
 * event is one occurrence of it with a 0-10 intensity, the same numeric rating
 * scale the pain score uses. Both ride the `illness` module.
 */

/**
 * Active definitions per account. The same eight the custom-metric channels
 * are capped at, and for the same reason: every active definition is its own
 * correlation channel, so the cap bounds the discovery matrix as well as the
 * chip row. A hidden definition does not count.
 */
export const MAX_ACTIVE_SYMPTOM_DEFINITIONS = 8;

/** The intensity scale: 0 none, 10 the worst imaginable (NRS). */
export const SYMPTOM_INTENSITY_MIN = 0;
export const SYMPTOM_INTENSITY_MAX = 10;

/** Upper bound on one events page. */
export const MAX_SYMPTOM_EVENTS_PAGE = 500;

/**
 * Icon names a definition may carry: the cycle custom-symptom allowlist, which
 * the iOS client already maps to SF Symbols.
 */
export const SYMPTOM_ICON_ALLOWLIST = CUSTOM_SYMPTOM_ICON_ALLOWLIST;
export type SymptomIconName = (typeof SYMPTOM_ICON_ALLOWLIST)[number];

const ICON_SET = new Set<string>(SYMPTOM_ICON_ALLOWLIST);

/** Correlation channel key prefix: `SYMPTOM:<definitionId>`. */
export const SYMPTOM_CHANNEL_PREFIX = "SYMPTOM:";

/** Wire shape of one definition. */
export interface SymptomDefinitionDTO {
  id: string;
  /** Decrypted; null only when the stored label cannot be read. */
  label: string | null;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  /** Server-computed over the last 30 days, for the section header line. */
  recent: {
    count30d: number;
    maxIntensity30d: number | null;
    lastOccurredAt: string | null;
  };
}

/** Wire shape of one event. */
export interface SymptomEventDTO {
  id: string;
  definitionId: string;
  occurredAt: string;
  intensity: number;
  note: string | null;
  episodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

const labelSchema = z
  .string()
  .trim()
  .min(1, "Label must not be empty")
  .max(40, "Label must be at most 40 characters");

const iconSchema = z
  .string()
  .refine((v) => ICON_SET.has(v), "Unknown icon")
  .nullish();

export const symptomDefinitionCreateSchema = z.object({
  label: labelSchema,
  icon: iconSchema,
});

export const symptomDefinitionUpdateSchema = z
  .object({
    label: labelSchema.optional(),
    icon: iconSchema,
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .refine(
    (v) =>
      v.label !== undefined ||
      v.icon !== undefined ||
      v.isActive !== undefined ||
      v.sortOrder !== undefined,
    "At least one field is required",
  );

const intensitySchema = z
  .number()
  .int()
  .min(SYMPTOM_INTENSITY_MIN)
  .max(SYMPTOM_INTENSITY_MAX);

const occurredAtSchema = validateEntryInstant(
  z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .pipe(z.date()),
);

export const symptomEventCreateSchema = z.object({
  definitionId: z.string().min(1).max(40),
  /** Defaults to now. Not in the future beyond the shared 5-minute skew. */
  occurredAt: occurredAtSchema.optional(),
  intensity: intensitySchema,
  note: z.string().trim().max(500).nullish(),
  /** Must be one of the caller's own episodes that is still open. */
  episodeId: z.string().min(1).max(40).nullish(),
});

export const symptomEventUpdateSchema = z
  .object({
    occurredAt: occurredAtSchema.optional(),
    intensity: intensitySchema.optional(),
    note: z.string().trim().max(500).nullish(),
    episodeId: z.string().min(1).max(40).nullish(),
  })
  .refine(
    (v) =>
      v.occurredAt !== undefined ||
      v.intensity !== undefined ||
      v.note !== undefined ||
      v.episodeId !== undefined,
    "At least one field is required",
  );

export const symptomEventListQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  definitionId: z.string().min(1).max(40).optional(),
  episodeId: z.string().min(1).max(40).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SYMPTOM_EVENTS_PAGE)
    .default(200),
});
