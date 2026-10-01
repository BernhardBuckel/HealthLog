"use client";

/**
 * v1.18.9 — the Lab-OCR "Scan a report" dialog.
 *
 * Flow: pick a photo / PDF → extract (vision provider) → MANDATORY human review
 * (per-row confirm/edit/discard, duplicate + new-biomarker + low-confidence
 * hints) → commit only the confirmed rows. Nothing writes until the user
 * confirms. Reuses the labs design language via `ResponsiveSheet` + the labs
 * row editor.
 */
import { DocumentReadingConsentPrompt } from "@/components/ai/document-reading-consent-prompt";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { AlertCircle, Loader2, ScanLine, Upload } from "lucide-react";
import { toast } from "sonner";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ApiError } from "@/lib/api/api-fetch";
import { EncounterSuggestionField } from "@/components/encounters/encounter-suggestion-field";
import { useTranslations } from "@/lib/i18n/context";

import { OcrRowEditor } from "./ocr-row-editor";
import { seedReviewRows, type OcrReviewRow } from "./ocr-review-types";
import { collectRowErrors, planSave } from "./ocr-review-validation";
import {
  useOcrCommit,
  useOcrExtract,
  useOcrTextExtract,
} from "./use-ocr-extract";

type Stage = "pick" | "review";

/** How the scan runs: native vision vs in-browser (local) OCR. */
export type OcrMode = "vision" | "text";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const ACCEPT_IMAGE_ONLY = "image/jpeg,image/png,image/webp";
type FilePickerInput = {
  files: ArrayLike<File> | null;
  value: string;
};

export function handleFilePickerChange(
  input: FilePickerInput,
  onFilePicked: (file: File) => void,
) {
  const file = input.files?.[0];
  // Reset so re-picking the same file fires `change` again.
  input.value = "";
  if (file) onFilePicked(file);
}

/**
 * Translate an extract failure into a friendly, error-code-aware message.
 * Refusals are read by `meta.errorCode`: a 403 is a missing consent only when
 * the code says so, never by its status alone.
 */
export function extractErrorMessage(
  err: unknown,
  t: (key: string) => string,
): string {
  if (err instanceof ApiError) {
    const code =
      typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;
    switch (code) {
      case "labs.ocr.providerUnsupported":
        return t("labs.ocr.providerUnsupported");
      case "labs.ocr.rateLimited":
        return t("labs.ocr.rateLimited");
      case "labs.ocr.budgetExceeded":
        return t("labs.ocr.budgetExceeded");
      case "labs.ocr.fileTooLarge":
        return t("labs.ocr.fileTooLarge");
      case "labs.ocr.fileType":
        return t("labs.ocr.fileType");
      case "labs.ocr.pdfNeedsAnthropic":
        return t("labs.ocr.pdfNeedsAnthropic");
      case "consent.ai.required":
        return t("labs.ocr.consentRequired");
      case "ai.provider.none":
        return t("labs.ocr.providerUnsupported");
      default:
        break;
    }
    // The operator's switch, the module, somebody else's record: scanning is
    // not available here right now, whatever the exact layer.
    if (
      code !== null &&
      (code.startsWith("assistant.disabled.") ||
        code === "ai.record.notPermitted" ||
        code === "module.disabled")
    ) {
      return t("labs.ocr.aiUnavailable");
    }
  }
  return t("labs.ocr.extractFailed");
}

export function OcrReviewDialog({
  open,
  onOpenChange,
  mode,
  pdfSupported,
  consentRequired = false,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Native vision vs in-browser local OCR. Text mode is image-only. */
  mode: OcrMode;
  pdfSupported: boolean;
  /**
   * The `labsOcr` capability is missing only the document-reading consent.
   * The pick step asks for it instead of offering the file picker; once it is
   * granted `/api/auth/me` refreshes and the picker appears.
   */
  consentRequired?: boolean;
  onCommitted: () => void;
}) {
  const { t } = useTranslations();
  const pickerId = useId();
  const [stage, setStage] = useState<Stage>("pick");
  const [rows, setRows] = useState<OcrReviewRow[]>([]);
  // S9 — in vision mode the picked file is retained so, on commit, it can be
  // filed into the Documents vault and cross-linked to the committed labs. Text
  // mode keeps the image on-device, so nothing is retained there.
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  /**
   * The visit this panel came out of, if the review step offered one and the
   * person took the offer. Never blocks the save and never pre-fills anything
   * else: the panel commits with it unset exactly as before.
   */
  const [visitId, setVisitId] = useState<string | null>(null);
  // Errors stay hidden until a save is attempted: a row is not "wrong" just
  // because the person has not filled it in yet. Once shown they follow the
  // edits, so fixing a field clears its mark at once.
  const [showErrors, setShowErrors] = useState(false);
  // Set when the server read only the first pages of a long PDF.
  const [pageCoverage, setPageCoverage] = useState<{
    read: number;
    total: number;
  } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const reviewListRef = useRef<HTMLDivElement>(null);

  // Text mode OCR's the image in the browser then POSTs the text; vision mode
  // uploads the image. Both resolve with the same proposed-rows DTO.
  const visionExtract = useOcrExtract();
  const textExtract = useOcrTextExtract();
  const extract = mode === "text" ? textExtract : visionExtract;
  const commit = useOcrCommit();
  // Text mode never accepts PDFs (tesseract.js can't read them).
  const allowPdf = mode === "vision" && pdfSupported;

  const confirmedCount = useMemo(
    () => rows.filter((r) => r.confirmed).length,
    [rows],
  );

  /**
   * The draw date the whole panel hangs off — the earliest `takenAt` the scan
   * read. A panel is one draw; asking the suggestion about each row separately
   * would ask the same question a dozen times and could answer it a dozen ways.
   */
  const panelAnchor = useMemo(() => {
    const dates = rows
      .map((row) => row.takenAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return dates.length > 0 ? `${dates[0]}T12:00:00.000Z` : null;
  }, [rows]);

  /** Blocking fields per confirmed row; rows that are writable are absent. */
  const rowErrors = useMemo(() => collectRowErrors(rows), [rows]);

  // Move focus to the first marked field once the marks have rendered.
  useEffect(() => {
    if (focusRequest === 0) return;
    const first = reviewListRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    );
    first?.focus();
    first?.scrollIntoView({ block: "center" });
  }, [focusRequest]);

  function reset() {
    setStage("pick");
    setShowErrors(false);
    setPageCoverage(null);
    setRows([]);
    setPickedFile(null);
    setVisitId(null);
    extract.reset();
    commit.reset();
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function onFilePicked(file: File) {
    // Retain the source only for vision mode (text mode never sends the image).
    setPickedFile(mode === "vision" ? file : null);
    extract.mutate(file, {
      onSuccess: (data) => {
        const seeded = seedReviewRows(data.rows, data.reportDate);
        if (seeded.length === 0) {
          toast.error(t("labs.ocr.noRows"));
          return;
        }
        setRows(seeded);
        setPageCoverage(data.pageCoverage ?? null);
        setStage("review");
      },
      onError: (err) => toast.error(extractErrorMessage(err, t)),
    });
  }

  function onSave() {
    const plan = planSave(rows);
    if (plan.kind === "nothing-selected") {
      toast.error(t("labs.ocr.nothingToSave"));
      return;
    }
    if (plan.kind === "blocked") {
      setShowErrors(true);
      setFocusRequest((n) => n + 1);
      return;
    }
    const { payload } = plan;
    commit.mutate(
      { rows: payload, file: pickedFile, encounterId: visitId },
      {
        onSuccess: (result) => {
          // The commit re-checks each confirmed row against what is already
          // stored, so a re-scan can legitimately write nothing. The toast
          // used to be green on any 200 and print the count regardless; the
          // server resolves the outcome from the two lists and the dialog
          // renders it.
          toastWrittenOutcome(
            result.outcome,
            result.outcome === "success"
              ? t("labs.ocr.savedToast", { count: result.inserted.length })
              : result.outcome === "partial"
                ? t("labs.ocr.savedPartialToast", {
                    count: result.inserted.length,
                    skipped: result.skipped.length,
                  })
                : result.outcome === "failed"
                  ? t("labs.ocr.savedNothingToast", {
                      skipped: result.skipped.length,
                    })
                  : t("labs.ocr.savedEmptyToast"),
          );
          onCommitted();
          handleClose(false);
        },
        onError: () => toast.error(t("labs.ocr.saveFailed")),
      },
    );
  }

  const busy = extract.isPending || commit.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={handleClose}
      title={t("labs.ocr.reviewTitle")}
      description={
        stage === "pick" ? t("labs.ocr.uploadHint") : t("labs.ocr.reviewHint")
      }
      footer={
        stage === "review" ? (
          <div className="flex w-full justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={busy}
              className="min-h-11 sm:min-h-9"
            >
              {t("labs.ocr.discardAll")}
            </Button>
            <Button
              onClick={onSave}
              disabled={busy || confirmedCount === 0}
              className="min-h-11 sm:min-h-9"
            >
              {commit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("labs.ocr.saveSelected", { count: confirmedCount })}
            </Button>
          </div>
        ) : undefined
      }
    >
      {stage === "pick" && consentRequired ? (
        <DocumentReadingConsentPrompt />
      ) : stage === "pick" ? (
        <div className="relative py-2">
          <input
            id={pickerId}
            type="file"
            accept={allowPdf ? ACCEPT : ACCEPT_IMAGE_ONLY}
            disabled={extract.isPending}
            className="peer absolute inset-0 z-10 h-full w-full cursor-pointer rounded-lg opacity-0 disabled:cursor-not-allowed"
            onChange={(event) =>
              handleFilePickerChange(event.currentTarget, onFilePicked)
            }
          />
          <label
            htmlFor={pickerId}
            className="border-muted-foreground/25 hover:bg-muted/50 peer-focus-visible:ring-ring flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center whitespace-normal peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
          >
            {extract.isPending ? (
              <>
                <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
                <span className="text-muted-foreground text-sm">
                  {/* Text mode runs OCR on-device first, then structures it —
                      the first run also downloads the OCR engine, so the copy
                      sets the "this is reading on your device" expectation. */}
                  {mode === "text"
                    ? t("labs.ocr.readingOnDevice")
                    : t("labs.ocr.extracting")}
                </span>
              </>
            ) : (
              <>
                <ScanLine
                  className="text-muted-foreground h-8 w-8"
                  aria-hidden
                />
                <span className="text-sm font-medium">
                  {t("labs.ocr.scanButton")}
                </span>
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Upload className="h-3.5 w-3.5" aria-hidden />
                  {allowPdf
                    ? t("labs.ocr.acceptWithPdf")
                    : t("labs.ocr.acceptImageOnly")}
                </span>
                {/* Honest accuracy caveat for the local-OCR fallback. */}
                {mode === "text" ? (
                  <span className="text-muted-foreground max-w-xs text-xs">
                    {t("labs.ocr.localModeHint")}
                  </span>
                ) : null}
              </>
            )}
          </label>
        </div>
      ) : (
        <div ref={reviewListRef} className="space-y-3 py-2">
          <p className="text-muted-foreground text-sm">
            {t("labs.ocr.foundCount", { count: rows.length })}
          </p>

          <OcrPageCoverageNote coverage={pageCoverage} />

          {showErrors && rowErrors.size > 0 ? (
            <p
              role="alert"
              className="text-destructive flex items-start gap-2 text-sm"
            >
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t("labs.ocr.validationSummary", { count: rowErrors.size })}
            </p>
          ) : null}

          {/* Anchored on the draw date the scan read, so the offer is about
              the panel rather than about today. */}
          <EncounterSuggestionField
            anchor={panelAnchor}
            value={visitId}
            onChange={setVisitId}
            slot="labs-ocr-encounter-suggestion"
          />

          {rows.map((row) => (
            <OcrRowEditor
              key={row.key}
              row={row}
              errors={showErrors ? rowErrors.get(row.key) : undefined}
              onChange={(next) =>
                setRows((prev) =>
                  prev.map((r) => (r.key === next.key ? next : r)),
                )
              }
            />
          ))}
        </div>
      )}
    </ResponsiveSheet>
  );
}

/**
 * The server read only the first pages of a long PDF (`pageCoverage` on the
 * extract response). Said on the review screen, beside the rows, because the
 * person checking the list is the one who would otherwise assume the whole
 * report was read. Renders nothing when the whole document was read.
 */
export function OcrPageCoverageNote({
  coverage,
}: {
  coverage: { read: number; total: number } | null;
}) {
  const { t } = useTranslations();
  if (!coverage) return null;
  return (
    <p data-slot="ocr-page-coverage" className="text-warning text-sm">
      {t("labs.ocr.pagesCapped", {
        read: coverage.read,
        total: coverage.total,
      })}
    </p>
  );
}
