"use client";

/**
 * The "Read with AI" block of the document detail sheet — one coherent, inviting
 * home for every AI reading action, lifted out of the sheet so the availability
 * gate and the review-first wiring render without the sheet's dialog portal and
 * are pinned by static-render tests.
 *
 * Indexing is AUTOMATIC on upload, so this block never nags a "please index"
 * chore. It carries NO header or status chrome (the AI-read provenance marker
 * lives on the vault card's meta row) and offers AI reading as a capability the
 * user reaches for when they want more:
 *
 *   - "Read with AI" (prominent) runs a provider read of the document — the
 *     richer pass that also refreshes the searchable index. Labelled "Read
 *     again" once a provider has already read it.
 *   - "Suggest details" drafts a title / type / date to review before saving.
 *   - "Summarise" / "Show text" surface a transient, session-only read-out.
 *
 * With auto-read ON, the document already read, and nothing pending to review
 * the block collapses entirely — the sheet content starts straight with the
 * document fields under the preview. An UNREAD document keeps the read action
 * visible whatever the preference says: auto-read is a promise that reading
 * happens on upload, and a document the automatic pass never reached (it may
 * predate the preference, or the pass did not complete) would otherwise have
 * no path to a read at all.
 *
 * Presentational: the sheet owns the mutations + capability probe and passes
 * their state + handlers down. When `aiEnabled` is false the actions collapse to
 * the calm "set up an AI provider" pointer (never an error) and the manual form
 * below stays fully usable.
 */
import { FileText, ScanText, WandSparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AiRunPhase } from "@/hooks/use-ai-run";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  isAiReadSource,
  type DocumentContentIndexSourceValue,
  type DocumentIndexOutcomeValue,
  type DocumentSuggestionDto,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

import {
  AiUnavailableHint,
  AssistSuggestionReview,
  DocumentSummaryPanel,
} from "./document-ai-panels";
import type { DocumentDescribeResult } from "./use-document-assist";

export function DocumentAiSection({
  aiEnabled,
  autoReadEnabled = false,
  indexEnabled,
  unavailableReason,
  actionsDisabled,
  onSuggest,
  suggestPending,
  suggestErrorKey,
  onSummarise,
  summaryPending,
  suggestion,
  suggestionKindLabel,
  suggestionDateLabel,
  appliedFields,
  onUseTitle,
  onUseKind,
  onUseDate,
  onDismissSuggestion,
  summaryOutput,
  summaryResult,
  summaryErrorKey,
  onCloseSummary,
  hasContentIndex,
  contentIndexSource,
  lastIndexOutcome = null,
  indexPending,
  indexRunPhase = "idle",
  onIndex,
}: {
  aiEnabled: boolean;
  /**
   * Whether "read documents automatically with AI" is ON. When true, reading +
   * indexing happen on upload, so the manual per-document action row (Read /
   * Suggest / Summarise) is hidden — only the header + searchable status +
   * content-search chat remain. Defaults to false so an omitting caller keeps
   * the manual controls.
   */
  autoReadEnabled?: boolean;
  indexEnabled: boolean;
  unavailableReason: "no-provider" | "enable-local-ocr" | null;
  /** Capability still resolving — the transport mode isn't known yet. */
  actionsDisabled: boolean;
  onSuggest: () => void;
  suggestPending: boolean;
  /** Resolved user-facing error sentence (already translated), or null. */
  suggestErrorKey: string | null;
  onSummarise: (output: DocumentSummaryMode) => void;
  summaryPending: boolean;
  suggestion: DocumentSuggestionDto | null;
  suggestionKindLabel: string | null;
  suggestionDateLabel: string | null;
  appliedFields: { title: boolean; kind: boolean; date: boolean };
  onUseTitle: () => void;
  onUseKind: () => void;
  onUseDate: () => void;
  onDismissSuggestion: () => void;
  summaryOutput: DocumentSummaryMode | null;
  summaryResult: DocumentDescribeResult | null;
  /** Resolved user-facing error sentence (already translated), or null. */
  summaryErrorKey: string | null;
  onCloseSummary: () => void;
  hasContentIndex: boolean;
  contentIndexSource: DocumentContentIndexSourceValue | null;
  /**
   * Refs #776 — why the last index attempt produced no index (null: never
   * tried, or the document IS indexed). Rendered as a muted plain-words line
   * beside the read action so a failed read is explainable, not a mystery.
   */
  lastIndexOutcome?: DocumentIndexOutcomeValue | null;
  indexPending: boolean;
  /** v1.40 — where a background read stands, for the calm line under it. */
  indexRunPhase?: AiRunPhase;
  onIndex: () => void;
}) {
  const { t } = useTranslations();
  const aiRead = hasContentIndex && isAiReadSource(contentIndexSource);
  // Refs #776 — only an un-indexed document explains itself; once an index
  // exists the last failure is history. Muted per the text-colour rule: this
  // is meta about the document, not content.
  const indexOutcomeText =
    !hasContentIndex && lastIndexOutcome
      ? t(`documents.detail.index.outcome.${lastIndexOutcome}`)
      : null;
  const readLabel = indexPending
    ? t("documents.ai.reading")
    : aiRead
      ? t("documents.ai.reread")
      : t("documents.ai.read");

  // v1.28.22 — the block carries NO header/status chrome any more (the
  // provenance pill moved to the vault card's meta row; auto-read makes an
  // in-sheet "read by AI" banner redundant). With auto-read ON, the document
  // read, and nothing pending to review, nothing below would render —
  // collapse the whole box so the content under the preview starts straight
  // with the fields. An unindexed document does NOT collapse (unless indexing
  // is unavailable on this transport): it still needs its read, and this
  // section is the only place that action lives.
  if (
    aiEnabled &&
    autoReadEnabled &&
    (hasContentIndex || !indexEnabled) &&
    !suggestErrorKey &&
    !suggestion &&
    !summaryOutput
  ) {
    return null;
  }

  return (
    <div
      data-slot="document-ai-section"
      className="border-border bg-muted/30 space-y-3 rounded-lg border p-3 md:p-4"
    >
      {aiEnabled ? (
        <>
          {!autoReadEnabled ? (
            <div className="flex flex-wrap items-center gap-2">
              {indexEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  data-slot="document-read-ai"
                  onClick={onIndex}
                  disabled={indexPending || actionsDisabled}
                >
                  <ScanText
                    className={cn(
                      "size-4",
                      indexPending &&
                        "animate-pulse motion-reduce:animate-none",
                    )}
                    aria-hidden
                  />
                  {readLabel}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-slot="assist-suggest"
                onClick={onSuggest}
                disabled={suggestPending || actionsDisabled}
              >
                <WandSparkles className="size-4" aria-hidden />
                {suggestPending
                  ? t("documents.assist.suggesting")
                  : t("documents.assist.suggest")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSummarise("summary")}
                disabled={summaryPending || actionsDisabled}
              >
                <FileText className="size-4" aria-hidden />
                {t("documents.summary.summarise")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSummarise("text")}
                disabled={summaryPending || actionsDisabled}
              >
                {t("documents.summary.showText")}
              </Button>
            </div>
          ) : !hasContentIndex && indexEnabled ? (
            // Auto-read is ON but this document has no content index: the
            // automatic pass never reached it or did not complete. The
            // suggest / summarise extras stay hidden (auto-read's promise
            // covers them), but the read itself must stay reachable.
            <div className="space-y-2">
              <p
                data-slot="document-unread-note"
                className="text-muted-foreground text-xs"
              >
                {t("documents.ai.notReadYet")}
              </p>
              <Button
                type="button"
                size="sm"
                data-slot="document-read-ai"
                onClick={onIndex}
                disabled={indexPending || actionsDisabled}
              >
                <ScanText
                  className={cn(
                    "size-4",
                    indexPending && "animate-pulse motion-reduce:animate-none",
                  )}
                  aria-hidden
                />
                {readLabel}
              </Button>
            </div>
          ) : null}

          {indexRunPhase !== "idle" ? (
            <p
              role="status"
              data-slot="document-index-run-phase"
              className="text-muted-foreground text-xs"
            >
              {indexRunPhase === "waitingForWorker"
                ? t("aiRuns.waitingForWorker")
                : t("aiRuns.backgroundDocument")}
            </p>
          ) : null}

          {indexOutcomeText ? (
            <p
              data-slot="document-index-outcome"
              className="text-muted-foreground text-xs"
            >
              {indexOutcomeText}
            </p>
          ) : null}

          {suggestErrorKey ? (
            <p role="alert" className="text-destructive text-sm">
              {suggestErrorKey}
            </p>
          ) : null}

          {suggestion ? (
            <AssistSuggestionReview
              suggestion={suggestion}
              kindLabel={suggestionKindLabel}
              dateLabel={suggestionDateLabel}
              applied={appliedFields}
              onUseTitle={onUseTitle}
              onUseKind={onUseKind}
              onUseDate={onUseDate}
              onDismiss={onDismissSuggestion}
            />
          ) : null}

          {summaryOutput ? (
            <DocumentSummaryPanel
              output={summaryOutput}
              result={summaryResult}
              isPending={summaryPending}
              errorText={summaryErrorKey}
              onClose={onCloseSummary}
            />
          ) : null}
        </>
      ) : (
        <AiUnavailableHint reason={unavailableReason} />
      )}
    </div>
  );
}
