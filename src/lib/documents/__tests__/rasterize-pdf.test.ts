import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { RASTER_MAX_PAGES, rasterizePdf } from "../rasterize-pdf";

/**
 * Rasterization renders a PDF's pages to bounded JPEG images. Pins: a text-layer
 * PDF and a synthetic image-only (graphics-only, no text layer) PDF both render
 * to JPEG page images; the page cap is honoured; malformed input degrades to
 * `{ ok: false }` and never throws.
 *
 * The fixtures are built inline (a tiny hand-assembled PDF with a correct xref)
 * so the test carries no binary blobs.
 */
function buildPdf(pageCount: number, withText: boolean): Buffer {
  const pageNums: number[] = [];
  const perPage: { pageNum: number; contentNum: number; content: string }[] =
    [];
  let n = 4;
  for (let p = 0; p < pageCount; p++) {
    const pageNum = n++;
    const contentNum = n++;
    pageNums.push(pageNum);
    const content = withText
      ? `BT /F1 24 Tf 40 120 Td (Page ${p + 1} lab report glucose creatinine) Tj ET`
      : `0 0 1 rg 40 40 120 120 re f`;
    perPage.push({ pageNum, contentNum, content });
  }

  const bodies: string[] = [];
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${pageNums
    .map((x) => `${x} 0 R`)
    .join(" ")}] /Count ${pageCount} >>`;
  bodies[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  for (const { pageNum, contentNum, content } of perPage) {
    bodies[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    bodies[contentNum] =
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
  }

  const total = n - 1;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= total; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** JPEG magic bytes. */
function isJpeg(base64: string): boolean {
  const head = Buffer.from(base64, "base64").subarray(0, 2).toString("hex");
  return head === "ffd8";
}

describe("rasterizePdf", () => {
  it("renders a text-layer PDF's pages to JPEG images", async () => {
    const result = await rasterizePdf(buildPdf(3, true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(3);
    for (const img of result.images) {
      expect(img.mediaType).toBe("image/jpeg");
      expect(isJpeg(img.dataBase64)).toBe(true);
    }
  });

  it("renders a synthetic image-only (no text layer) PDF", async () => {
    const result = await rasterizePdf(buildPdf(1, false));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    expect(isJpeg(result.images[0]!.dataBase64)).toBe(true);
  });

  it("caps the number of rendered pages at RASTER_MAX_PAGES", async () => {
    const result = await rasterizePdf(buildPdf(RASTER_MAX_PAGES + 4, true));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(RASTER_MAX_PAGES);
    // The page count travels with the result, so a caller can say the
    // reading stopped short.
    expect(result.pageCount).toBe(RASTER_MAX_PAGES + 4);
  });

  it("honours a caller maxPages bound (thumbnail path renders page 1 only)", async () => {
    const result = await rasterizePdf(buildPdf(5, true), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
  });

  it("returns { ok: false } and never throws on malformed input", async () => {
    await expect(
      rasterizePdf(Buffer.from("this is not a pdf")),
    ).resolves.toEqual({ ok: false, reason: "render-failed" });
  });

  it("returns { ok: false } on an empty buffer", async () => {
    await expect(rasterizePdf(Buffer.alloc(0))).resolves.toEqual({
      ok: false,
      reason: "render-failed",
    });
  });
});
