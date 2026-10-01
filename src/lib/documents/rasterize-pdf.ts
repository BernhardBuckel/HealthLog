/**
 * Server-side PDF rasterization for the document vault.
 *
 * The OAuth/subscription wire (codex) — and every other image-only-wire provider
 * — cannot receive a native PDF `document` block; only Anthropic accepts one.
 * This module renders a PDF's pages to raster JPEG images so those providers can
 * still READ a scanned/image-only PDF: each page image goes out as an ordinary
 * `input_image` part the codex client already handles, with no client-interface
 * change. Only invoked (on the auto-read path) when the toggle authorises the
 * external egress and the picked provider is NOT Anthropic (Anthropic keeps its
 * higher-fidelity native PDF block; a text-layer PDF is still read locally for
 * free before we ever rasterize).
 *
 * pdfjs is loaded LAZILY via a runtime `import()` — its module top-level
 * references the browser-only `DOMMatrix` global, so a STATIC import would make
 * the Turbopack server chunk evaluate that reference at instantiation and throw
 * `DOMMatrix is not defined`, taking down every route/worker sharing the chunk.
 * The lazy import (the exact pattern `local-extract.ts` documents) keeps pdfjs +
 * `@napi-rs/canvas` (its Node canvas backend) out of the eager chunk. Rendering
 * is pure local compute — no network, nothing written to disk.
 *
 * Bounds (denial-of-service + vision token cost): render at most the first
 * `RASTER_MAX_PAGES` pages, each capped to `RASTER_TARGET_LONG_EDGE` on its long
 * edge (never upscaled), JPEG at `RASTER_JPEG_QUALITY`. A discharge letter / lab
 * is 1-4 pages; the cap keeps a pathological 200-page PDF from draining the
 * subscription allowance in one job.
 *
 * NEVER throws: a malformed / encrypted / unrenderable PDF, a missing native
 * binary, or any render error resolves to `{ ok: false }`, and the caller falls
 * back to the local text-layer path or leaves the document un-indexed. This
 * preserves the "a bad document never aborts an upload/batch" contract.
 */
import { Buffer } from "node:buffer";

import { annotate } from "@/lib/logging/context";

import { nativeCanvasSupported } from "./native-canvas-support";

/**
 * Whether the PDF rasterizer is available in this build. The native
 * `@napi-rs/canvas` binary is compiled in and traced into the standalone image
 * (see `next.config.ts`), so rasterization is a standing capability — every
 * vision provider can read a PDF (Anthropic natively, all others via raster).
 * The document capability DTO reads this so the UI offers a PDF read for a
 * non-Anthropic provider; a runtime render failure still degrades gracefully
 * (`prepareVisionInput` → `pdfNeedsAnthropic` → local text or un-indexed).
 */
export const RASTERIZATION_AVAILABLE = true;

/** Render at most the first N pages — the token-cost / DoS governor. */
export const RASTER_MAX_PAGES = 10;

/**
 * Longest-edge pixel cap per page. Tighter than the client upload downscale
 * ceiling because these feed a token-metered vision model; ~1600px is legible
 * for a document read without blowing up the tile count.
 */
export const RASTER_TARGET_LONG_EDGE = 1600;

/** JPEG quality (0-100). ~80 keeps text legible at a fraction of PNG's bytes. */
export const RASTER_JPEG_QUALITY = 80;

/** One rasterized page, shaped as a vision `input_image` part. */
export interface RasterImage {
  mediaType: "image/jpeg";
  dataBase64: string;
}

/**
 * Best-effort rasterization outcome — never an exception. Refs #776: a
 * failure names its class so the caller can tell "this build cannot raster
 * at all" (`unsupported` — the native canvas binary is unusable, a capability
 * gap Anthropic's native PDF path would cover) from "this particular PDF
 * would not render" (`render-failed` — malformed / encrypted / zero pages).
 */
export type RasterResult =
  | {
      ok: true;
      images: RasterImage[];
      /**
       * Pages in the PDF. Above `images.length` when the page cap cut the
       * render short, which a caller showing the result has to say: the
       * reading covers the first pages only.
       */
      pageCount: number;
    }
  | { ok: false; reason: "unsupported" | "render-failed" };

// Minimal structural types for the slice of the pdfjs API this module uses. A
// type-only shape (erased at build) so we never eagerly evaluate the pdfjs
// module for its types; the real module is pulled at runtime via `import()`.
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfCanvas {
  width: number;
  height: number;
  toBuffer(mime: "image/jpeg", quality?: number): Buffer;
}
interface PdfCanvasAndContext {
  canvas: PdfCanvas;
  context: unknown;
}
interface PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasAndContext;
  destroy?(target: PdfCanvasAndContext): void;
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfViewport;
  render(opts: {
    canvasContext: unknown;
    viewport: PdfViewport;
    canvas: unknown;
  }): { promise: Promise<void> };
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  canvasFactory: PdfCanvasFactory;
  getPage(pageNumber: number): Promise<PdfPage>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfjsModule {
  getDocument(opts: {
    data: Uint8Array;
    verbosity?: number;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
  }): PdfLoadingTask;
}

/**
 * Render the first `RASTER_MAX_PAGES` pages of a PDF to bounded JPEG images
 * (or fewer when `maxPages` is passed — the thumbnail path renders page 1
 * only). Returns `{ ok: false }` on any failure (malformed PDF, render throw,
 * missing binary, or zero renderable pages) — the caller degrades to local
 * text or un-indexed. Never throws.
 */
export async function rasterizePdf(
  buffer: Buffer,
  maxPages: number = RASTER_MAX_PAGES,
): Promise<RasterResult> {
  let doc: PdfDocument | null = null;
  let task: PdfLoadingTask | null = null;
  // CPU-feature gate: pdfjs renders through @napi-rs/canvas (Skia), whose x64
  // build uses AVX2 — an unsupported CPU dies with an uncatchable SIGILL on
  // the first render. Degrade to the existing no-raster path instead (scanned
  // PDFs stay unreadable for image-only providers; everything else works).
  if (!nativeCanvasSupported()) {
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: { reason: "native_canvas_unsupported" },
    });
    return { ok: false, reason: "unsupported" };
  }
  try {
    // Lazy import: keeps pdfjs (DOMMatrix) + @napi-rs/canvas out of the eager
    // server chunk. Resolved at first rasterization, then module-cached.
    const pdfjs =
      (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;

    task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0, // VerbosityLevel.ERRORS — no console spam on odd PDFs.
      isEvalSupported: false, // never eval font programs (defence in depth).
      useSystemFonts: true,
    });
    doc = await task.promise;

    // Never exceed the standing DoS ceiling, even if a caller asks for more.
    const cap = Math.min(Math.max(1, maxPages), RASTER_MAX_PAGES);
    const pageCount = Math.min(doc.numPages, cap);
    const images: RasterImage[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const longEdge = Math.max(base.width, base.height);
        // Cap the long edge, never upscale (scale ≤ 1).
        const scale =
          longEdge > 0 ? Math.min(1, RASTER_TARGET_LONG_EDGE / longEdge) : 1;
        const viewport = page.getViewport({ scale });

        const factory = doc.canvasFactory;
        const cc = factory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: cc.context,
          viewport,
          canvas: cc.canvas,
        }).promise;
        const jpeg = cc.canvas.toBuffer("image/jpeg", RASTER_JPEG_QUALITY);
        images.push({
          mediaType: "image/jpeg",
          dataBase64: jpeg.toString("base64"),
        });
        factory.destroy?.(cc);
      } finally {
        page.cleanup();
      }
    }

    if (images.length === 0) {
      // Refs #776 — the zero-pages shape must be as loud as a throw: a
      // document that "rendered" nothing is a failed rasterization, and the
      // wide event is what lets an operator see WHY a scan stayed unread.
      annotate({
        action: { name: "documents.rasterize.failed" },
        meta: { reason: "zero_pages", pageCount: doc.numPages },
      });
      return { ok: false, reason: "render-failed" };
    }
    annotate({
      action: { name: "documents.rasterize.ok" },
      meta: { pages: images.length, cappedFrom: doc.numPages },
    });
    return { ok: true, images, pageCount: doc.numPages };
  } catch (err) {
    annotate({
      action: { name: "documents.rasterize.failed" },
      meta: {
        reason: err instanceof Error ? err.name : "unknown",
        // The message pins WHY a render failed (bundled-module mismatch, an
        // encrypted/odd PDF, a font issue) — the name alone is opaque. Bounded
        // so a pathological message can't bloat the wide event.
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
      },
    });
    return { ok: false, reason: "render-failed" };
  } finally {
    if (task) {
      try {
        await task.destroy();
      } catch {
        // Best-effort teardown; a destroy failure must not mask the result.
      }
    }
  }
}
