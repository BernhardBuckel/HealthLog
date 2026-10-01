"use client";

/**
 * Owner document picker for the clinician-share create flow. A
 * `ResponsiveSheet` (bottom sheet on phones) with a debounced search over the
 * user's own vault — the SAME recall path as the vault page — and one
 * multi-select toggle row per document. Selection is client-only state; the
 * chosen ids POST with the share link, which freezes them write-once. The set
 * is bounded at `max` (mirrors `SHARE_LINK_MAX_DOCUMENTS`): once the cap is
 * reached, unselected rows disable so the client never posts an oversized set.
 *
 * Reuses the vault list endpoint + the `inboundDocumentPicker` query key from
 * the central factory; reads unwrap `(await res.json()).data` via `apiGet`.
 * No write happens here — attaching is the create mutation's job.
 */
import { useDocumentDate } from "@/components/documents/use-document-date";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { DOCUMENT_KIND_ICONS } from "@/components/documents/document-kind-meta";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

/** A picked document, carried by id + a display title (for the owner chips). */
export interface PickedDocument {
  id: string;
  title: string;
}

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function ShareDocumentPicker({
  open,
  onOpenChange,
  selected,
  onSelectedChange,
  max,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: PickedDocument[];
  onSelectedChange: (next: PickedDocument[]) => void;
  max: number;
}) {
  const { t } = useTranslations();
  const documentDate = useDocumentDate();

  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");

  // 200 ms debounce, matching the vault's search feel.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  const onSearchChange = (value: string) => {
    setSearchDraft(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value.trim()), 200);
  };

  const list = useQuery({
    queryKey: queryKeys.inboundDocumentPicker(query),
    enabled: open,
    queryFn: () => {
      const sp = new URLSearchParams();
      if (query) sp.set("q", query);
      sp.set("sort", "documentDate");
      sp.set("order", "desc");
      sp.set("limit", "50");
      return apiGet<ListPage>(`/api/documents/inbound?${sp.toString()}`);
    },
  });

  const selectedIds = new Set(selected.map((s) => s.id));
  const atCap = selected.length >= max;

  function toggle(doc: InboundDocumentDto, title: string) {
    if (selectedIds.has(doc.id)) {
      onSelectedChange(selected.filter((s) => s.id !== doc.id));
      return;
    }
    if (atCap) return;
    onSelectedChange([...selected, { id: doc.id, title }]);
  }

  const documents = list.data?.documents ?? [];

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.sharing.pickerTitle")}
      description={t("settings.sharing.pickerDescription", { max })}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {t("settings.sharing.pickerSelectedCount", {
              count: selected.length,
              max,
            })}
          </span>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("settings.sharing.pickerDone")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={searchDraft}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("settings.sharing.pickerSearch")}
            aria-label={t("settings.sharing.pickerSearch")}
            className="pl-9"
          />
        </div>

        {atCap ? (
          <p
            className="text-warning bg-warning/10 rounded-md px-3 py-2 text-xs"
            role="status"
          >
            {t("settings.sharing.pickerMaxReached", { max })}
          </p>
        ) : null}

        {list.isPending && open ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : list.isError ? (
          <QueryErrorRow
            message={t("documents.list.loadError")}
            onRetry={() => list.refetch()}
          />
        ) : documents.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            {t("settings.sharing.pickerEmpty")}
          </p>
        ) : (
          <ul
            className="max-h-[50vh] space-y-1.5 overflow-y-auto overscroll-contain"
            data-testid="share-doc-picker-list"
          >
            {documents.map((doc) => {
              const picked = selectedIds.has(doc.id);
              const title =
                doc.title ?? doc.filename ?? t("documents.card.untitled");
              const Icon = DOCUMENT_KIND_ICONS[doc.kind];
              const disabled = !picked && atCap;
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    aria-pressed={picked}
                    disabled={disabled}
                    onClick={() => toggle(doc, title)}
                    className={cn(
                      "border-border hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg border p-3 text-left",
                      "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                      picked && "border-primary/40 bg-primary/5",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <Icon
                      className="text-foreground size-5 shrink-0"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {title}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {documentDate(doc)}
                      </span>
                    </span>
                    <Check
                      className={cn(
                        "text-primary size-4 shrink-0",
                        picked ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ResponsiveSheet>
  );
}
