"use client";

/**
 * "Verknüpfen" — link existing vault documents to an illness episode from
 * the episode's detail page. A `ResponsiveSheet` with a debounced search
 * over the vault (title/filename, same recall path as the vault page) and
 * one toggle row per document; toggling fires the bulk link/unlink action
 * for that single id (idempotent by contract, no-op-success on
 * already-in-state rows) and refreshes every document read through the
 * `["documents"]` prefix.
 *
 * Shows one page (50) of matches — the search input is the way to reach an
 * older document, mirroring the vault's own recall model.
 */
import { useDocumentDate } from "@/components/documents/use-document-date";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type {
  DocumentBulkResultDto,
  InboundDocumentDto,
} from "@/lib/validations/inbound-documents";
import { DOCUMENT_KIND_ICONS } from "./document-kind-meta";

interface ListPage {
  documents: InboundDocumentDto[];
  nextCursor: string | null;
}

export function DocumentLinkPicker({
  episodeId,
  open,
  onOpenChange,
}: {
  episodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const documentDate = useDocumentDate();
  const queryClient = useQueryClient();

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

  const toggle = useMutation({
    mutationFn: (input: { documentId: string; linked: boolean }) =>
      apiPost<{ results: DocumentBulkResultDto[] }>(
        "/api/documents/inbound/bulk",
        {
          ids: [input.documentId],
          action: input.linked ? "unlinkEpisode" : "linkEpisode",
          episodeId,
        },
      ),
    onSuccess: (data) => {
      if (data.results.some((r) => !r.ok)) {
        toast.error(t("documents.bulk.failed"));
      }
    },
    onError: () => toast.error(t("documents.bulk.failed")),
    onSettled: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });

  const documents = list.data?.documents ?? [];

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("documents.linkPicker.title")}
      description={t("documents.linkPicker.description")}
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
            placeholder={t("documents.linkPicker.searchPlaceholder")}
            aria-label={t("documents.linkPicker.searchPlaceholder")}
            className="pl-9"
          />
        </div>

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
            {t("documents.linkPicker.empty")}
          </p>
        ) : (
          <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto overscroll-contain">
            {documents.map((doc) => {
              const linked = doc.conditionLinks.some(
                (l) => l.episodeId === episodeId,
              );
              const title =
                doc.title ?? doc.filename ?? t("documents.card.untitled");
              const Icon = DOCUMENT_KIND_ICONS[doc.kind];
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    aria-pressed={linked}
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate({ documentId: doc.id, linked })
                    }
                    className={cn(
                      "border-border hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg border p-3 text-left",
                      "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                      linked && "border-primary/40 bg-primary/5",
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
                        linked ? "opacity-100" : "opacity-0",
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
