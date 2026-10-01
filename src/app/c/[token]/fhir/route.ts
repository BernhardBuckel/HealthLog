/**
 * GET /c/{token}/fhir — the share link's record as an HL7 FHIR R4 document
 * Bundle, as a download.
 *
 * Behind the same unlock cookie the page and the document route use, serving
 * exactly the link's frozen selection. The insurance number is never carried:
 * the insurance leaf is refused at share-link creation, so there is nothing to
 * decrypt here and the identity block is built without it.
 *
 * The gate itself lives in `@/lib/clinician-share/report-download` so this
 * route and the PDF beside it cannot drift apart.
 */
import { NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { resolveShareReportDownload } from "@/lib/clinician-share/report-download";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { token } = await params;
    const resolved = await resolveShareReportDownload(request, token, "fhir");
    if (!resolved.ok) return resolved.response;

    // No structured records ride a share bundle: allergies and family history
    // reach the owner's own export through a separate read that this surface
    // does not perform, so the bundle carries exactly the aggregated payload
    // the page renders and nothing beside it.
    const bundle = buildFhirDocumentBundle(resolved.report, {
      insuranceNumber: null,
    });
    // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(bundle), {
      status: 200,
      headers: {
        "Content-Type": "application/fhir+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="healthlog-fhir-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  },
);
