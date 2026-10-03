import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Static-render pins for the timeline's accessibility contract: the
 * virtualized container is a labelled list, and the transient upload queue
 * is a polite live region. (The windowed rows themselves only mount
 * client-side once the virtualizer measures the scroll container — the
 * keyboard path is covered by the e2e battery.)
 */
import { I18nProvider } from "@/lib/i18n/context";
import { DocumentTimeline } from "../document-timeline";
import type { UploadQueueItem } from "../use-document-upload";

function render(uploadItems: UploadQueueItem[]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentTimeline
        timezone="UTC"
        documents={[]}
        uploadItems={uploadItems}
        onDismissUpload={() => {}}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={() => {}}
        selectedIds={new Set()}
        onToggleSelected={() => {}}
        onOpen={() => {}}
        highlightId={null}
      />
    </I18nProvider>,
  );
}

describe("<DocumentTimeline> semantics", () => {
  it("renders the virtualized container as a labelled list", () => {
    const html = render([]);
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="Documents timeline"');
  });

  it("announces the upload queue through a polite live region", () => {
    const html = render([
      {
        localId: "l1",
        fileName: "scan.pdf",
        byteSize: 1024,
        status: "uploading",
        progress: 0.4,
      },
    ]);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("scan.pdf");
  });
});
