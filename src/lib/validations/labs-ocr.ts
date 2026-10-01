/**
 * v1.18.9 — Lab-OCR ingestion contract.
 *
 * A self-hoster with a vision-capable AI provider uploads a photo / PDF of a
 * paper lab report; the provider transcribes the readings as structured JSON;
 * the rows land on a MANDATORY human-review screen; only the user-confirmed
 * rows write to `lab_results` (+ a biomarker create/link).
 *
 * This module holds:
 *   - `extractedLabsSchema` — the schema the provider's JSON is validated
 *     against in the extract route (UNTRUSTED model output).
 *   - `ocrCommitSchema` — the request body of the commit route (the rows the
 *     human confirmed). No `userId` field — it is always narrowed from the
 *     session.
 *
 * The DTO types the routes return + the UI consumes are derived here so the
 * three layers agree on one shape.
 */
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
import { z } from "zod/v4";

import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

import { validateEntryInstant } from "@/lib/validations/entry-instant";

/** Max rows a single scan / commit may carry — a dense panel is ~30 analytes. */
export const OCR_MAX_ROWS = 100;

/**
 * Far-past floor for a lab sample, mirroring `createLabResultSchema`'s
 * `takenAtField` (a self-hoster legitimately backdates an old paper report).
 */
const LAB_TAKEN_AT_MAX_AGE_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;

/** Shared committed-row `takenAt`: ISO string → Date, plausibility-bounded. */
const takenAtField = validateEntryInstant(
  z
    .string()
    .datetime({ message: "takenAt must be an ISO 8601 datetime" })
    .transform((s) => new Date(s)),
  {
    maxAgeMs: LAB_TAKEN_AT_MAX_AGE_MS,
    pastMessage: "Sample date is too far in the past",
  },
);

/**
 * Per-field extraction confidence (0..1). The model self-reports how legible
 * each field was; the review screen pre-flags any field below the threshold
 * so the human double-checks it. Bounded + coerced defensively because this is
 * untrusted model output.
 */
const confidenceScore = z.number().min(0).max(1).catch(0);

const extractedConfidenceSchema = z
  .object({
    analyte: confidenceScore.default(0),
    value: confidenceScore.default(0),
    unit: confidenceScore.default(0),
    range: confidenceScore.default(0),
  })
  // The model may omit the block entirely — default every field to 0 (treated
  // as "flag for review") rather than rejecting the whole row.
  .default({ analyte: 0, value: 0, unit: 0, range: 0 });

/**
 * One row as the PROVIDER returns it (untrusted). Liberal on shape: a missing
 * field is null, a date may be absent. The review step is the safety boundary —
 * the server never acts on this beyond mapping it to the DTO.
 *
 * `value` XOR `valueText`: a reading is numeric OR qualitative. The model is
 * instructed to set exactly one, but a malformed pair is tolerated here and
 * resolved on the review screen rather than 422-ing the whole extraction.
 */
export const extractedRowSchema = z.object({
  analyte: z.string().trim().min(1).max(200),
  value: z.number().finite().nullable().catch(null),
  valueText: z.string().trim().min(1).max(200).nullable().catch(null),
  unit: z.string().trim().max(80).nullable().catch(null),
  referenceLow: z.number().finite().nullable().catch(null),
  referenceHigh: z.number().finite().nullable().catch(null),
  /**
   * The reference range EXACTLY as printed, verbatim. The two numeric bounds
   * above can only carry a window that reduces to two numbers; a report that
   * prints "bis 5,0" or "negativ" states a window all the same, and this is
   * what keeps it instead of dropping it.
   */
  referenceText: z.string().trim().max(120).nullable().catch(null),
  takenAt: z.string().nullable().catch(null),
  confidence: extractedConfidenceSchema,
});

/** The full JSON envelope the provider returns. */
export const extractedLabsSchema = z.object({
  reportDate: z.string().nullable().catch(null),
  rows: z.array(extractedRowSchema).max(OCR_MAX_ROWS),
});

export type ExtractedLabs = z.infer<typeof extractedLabsSchema>;
export type ExtractedRow = z.infer<typeof extractedRowSchema>;

/**
 * The per-row DTO the EXTRACT route returns to the client. Carries the model's
 * extracted fields plus server-computed annotations:
 *   - `biomarkerMatch`: whether the analyte links an existing catalog marker
 *     or will mint a new one.
 *   - `duplicateOf`: the id of an existing live `lab_results` row that already
 *     records this analyte+date+value (the review row defaults to unchecked).
 *   - `takenAt`: normalised to the row date ?? reportDate (ISO) when present.
 */
export interface OcrExtractedRowDto {
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The reference range as printed on the report, verbatim. */
  referenceText: string | null;
  takenAt: string | null;
  confidence: {
    analyte: number;
    value: number;
    unit: number;
    range: number;
  };
  biomarkerMatch: "new" | "existing";
  duplicateOf: string | null;
}

export interface OcrExtractResponseDto {
  reportDate: string | null;
  providerType: string;
  rows: OcrExtractedRowDto[];
  /**
   * Present only when a PDF was longer than the pages the scan reads
   * (`RASTER_MAX_PAGES`): the rows come from the first `read` of `total`
   * pages, and the review screen says so.
   */
  pageCoverage?: { read: number; total: number };
}

/**
 * One row the human CONFIRMED on the review screen, sent to the commit route.
 * Reuses the `createLabResultSchema` field discipline: numeric XOR qualitative,
 * a unit required for a numeric reading, sane reference bounds. `analyte` is
 * always present (the review screen requires a name); the commit route always
 * resolves-or-mints a biomarker by `(userId, lower(analyte))`.
 */
const requiredAnalyte = z.string().trim().min(1).max(120);
const referenceLow = z.number().finite().optional();
const referenceHigh = z.number().finite().optional();

export const ocrCommitRowSchema = z
  .object({
    analyte: requiredAnalyte,
    panel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    value: z.number().finite().optional(),
    valueText: z.string().trim().min(1).max(120).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    referenceLow,
    referenceHigh,
    /**
     * The window the scanned report printed for this row. Confirmed by the
     * human on the review screen alongside everything else, and written onto
     * the reading rather than only used to seed a new catalog marker.
     */
    referenceText: z
      .string()
      .trim()
      .max(120)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    takenAt: takenAtField,
  })
  // Numeric XOR qualitative: exactly one of value / valueText.
  .refine((d) => (d.value !== undefined) !== (d.valueText !== undefined), {
    message:
      "Provide exactly one of value (numeric) or valueText (qualitative)",
    path: ["value"],
  })
  // A numeric reading needs a unit (the catalog otherwise has nothing to mint
  // it with); a qualitative reading needs none.
  .refine((d) => d.valueText !== undefined || d.unit !== undefined, {
    message: "unit is required for a numeric reading",
    path: ["unit"],
  })
  // Reference bounds apply to the numeric path only; reject a transposed range.
  .refine(
    (d) =>
      d.valueText !== undefined ||
      d.referenceLow === undefined ||
      d.referenceHigh === undefined ||
      d.referenceLow <= d.referenceHigh,
    {
      message: "referenceLow must not exceed referenceHigh",
      path: ["referenceLow"],
    },
  );

export type OcrCommitRow = z.infer<typeof ocrCommitRowSchema>;

export const ocrCommitSchema = z.object({
  rows: z.array(ocrCommitRowSchema).min(1).max(OCR_MAX_ROWS),
  /**
   * S9 — the vault document the client filed the scanned bytes into (kind
   * LAB_RESULT), so the committed labs can be cross-linked back to their source
   * (`inboundDocuments` module on). Optional: text-mode scans keep the image
   * on-device and file nothing, and a module-off account never files. Ownership
   * is verified server-side before any link is written.
   */
  documentId: z.string().trim().min(1).max(64).optional(),
  /**
   * The visit this panel came out of, when the review step offered one.
   *
   * Optional, always. A panel commits with no visit named and the commit
   * succeeds unchanged — the link is the by-the-way half of the flow, never
   * a condition of the write. Ownership is verified server-side, and one link
   * is written PER RESULT ROW rather than one for the panel: a re-run panel on
   * a different day links to its own visit, which is why the join is m:n and
   * not a scalar column on the result.
   */
  encounterId: z.string().trim().min(1).max(40).optional(),
});

export type OcrCommitInput = z.infer<typeof ocrCommitSchema>;

/** A row the commit route skipped (a re-checked duplicate at commit time). */
export interface OcrSkippedRowDto {
  analyte: string;
  reason: "duplicate";
}

export interface OcrCommitResponseDto {
  inserted: unknown[];
  skipped: OcrSkippedRowDto[];
  /**
   * How the commit reads, resolved server-side from the two lists. The dialog
   * renders this rather than assuming a 200 means readings were saved — a
   * re-scan in which every confirmed row turned out to be a duplicate writes
   * nothing and must not report a green toast.
   */
  outcome: WrittenOutcome;
}

/** The capability-probe response (drives whether the UI shows the scan entry). */
export interface OcrCapabilityDto {
  available: boolean;
  /**
   * How the scan runs when available:
   *   - "vision": the provider reads the image directly (higher accuracy).
   *   - "text": the image is OCR'd in the browser (tesseract.js) and only the
   *     extracted text is sent to a text-only provider (less accurate; opt-in
   *     via `labsLocalOcrEnabled`). The UI loads the WASM only for this mode.
   *   - null: scanning is unavailable (see `reason`).
   */
  mode: "vision" | "text" | null;
  /** Why scanning is unavailable, when it is. */
  reason: "no-provider" | "enable-local-ocr" | null;
  /** Whether PDF uploads are accepted (Anthropic vision provider only). */
  pdfSupported: boolean;
  /**
   * The `labsOcr` capability for this record. When it is closed by anything
   * other than a missing provider or a missing consent receipt, `available`
   * is false with a null `reason`, and this says why.
   */
  ai: AiCapabilityState;
}

/**
 * The body of a TEXT-mode extract call. The browser OCR's the image and POSTs
 * the extracted text here (no image bytes ever reach the server). The route
 * forwards the text to the text-only provider for structuring, reusing the
 * exact review + commit flow the vision path uses.
 */
const OCR_TEXT_MAX_CHARS = 200_000;

export const ocrTextExtractSchema = z.object({
  mode: z.literal("text"),
  text: z.string().trim().min(1).max(OCR_TEXT_MAX_CHARS),
});

export type OcrTextExtractInput = z.infer<typeof ocrTextExtractSchema>;
