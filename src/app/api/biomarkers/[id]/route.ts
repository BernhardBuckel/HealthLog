import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import {
  decryptContextFromBytes,
  encryptContextToBytes,
} from "@/lib/labs/biomarker-store";
import { annotate } from "@/lib/logging/context";
import { updateBiomarkerSchema } from "@/lib/validations/biomarkers";
import { effectiveBound, isInvertedRange } from "@/lib/validations/labs";

/**
 * v1.18.1 — single Biomarker resource (`/api/biomarkers/{id}`).
 *
 * PUT applies a partial edit (`data` built field-by-field; an explicit `null`
 * clears `context` / `panel` / a bound, an omitted key leaves it untouched).
 * DELETE hard-deletes the catalog definition together with every reading it
 * owns, in one userId-narrowed transaction — removing a biomarker is a
 * deliberate "drop this and its values" action. Cross-user rows surface as
 * 404 (existence sealed).
 */

type RouteParams = { params: Promise<{ id: string }> };

function serialiseBiomarker(row: {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hidden: boolean;
  contextEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    lowerBound: row.lowerBound,
    upperBound: row.upperBound,
    panel: row.panel,
    hasContext: row.contextEncrypted !== null,
    context: row.contextEncrypted
      ? decryptContextFromBytes(row.contextEncrypted)
      : null,
    hidden: row.hidden,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "labs");
    const { id } = await params;

    const row = await prisma.biomarker.findFirst({ where: { id } });
    if (!row || row.userId !== user.id) {
      return apiError("Biomarker not found", 404);
    }

    annotate({
      action: { name: "labs.biomarker.get" },
      meta: { biomarkerId: id },
    });

    return apiSuccess(serialiseBiomarker(row));
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and the closest call in this domain: a reference range
    // recolours every reading under it, so this is the one admitted edit whose
    // error is silent rather than visible. C4 on the audit row is what puts it
    // in the owner's feed. The DELETE below stays refused — it takes the
    // readings with it and files an id.
    const { user } = await requireRecordAuth("manage", "labs");
    const { id } = await params;

    const existing = await prisma.biomarker.findFirst({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
      });
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateBiomarkerSchema.safeParse(body);
    if (!parsed.success) {
      annotate({
        action: { name: "labs.biomarker.update.validation-failed" },
        meta: { issue_count: parsed.error.issues.length, biomarkerId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("labs.biomarker.update.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues, biomarkerId: id },
      }).catch(() => {
        /* swallow — the 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "labs.biomarker.update.invalid",
      });
    }

    const d = parsed.data;

    // A rename must not collide with another of the caller's markers.
    if (d.name !== undefined && d.name !== existing.name) {
      const clash = await prisma.biomarker.findFirst({
        where: { userId: user.id, name: d.name },
        select: { id: true },
      });
      if (clash) {
        return apiError("A biomarker with this name already exists", 409, {
          errorCode: "labs.biomarker.duplicate",
        });
      }
    }

    // A marker's unit labels every reading linked to it: readers resolve the
    // unit from the marker, and the stored numbers are in the old unit. A
    // change while readings exist would relabel history without converting a
    // single value, so it is refused. Tombstoned readings count too, since an
    // undo brings them back under the new label.
    if (d.unit !== undefined && d.unit !== existing.unit) {
      const readingCount = await prisma.labResult.count({
        where: { userId: user.id, biomarkerId: id },
      });
      if (readingCount > 0) {
        annotate({
          action: { name: "labs.biomarker.update.unit-locked" },
          meta: { biomarkerId: id, readingCount },
        });
        return apiError(
          "The unit of a biomarker with readings cannot be changed",
          422,
          { errorCode: "biomarkers.unit.locked", readingCount },
        );
      }
    }

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on `context` / `panel` / a bound clears it.
    const data: Record<string, unknown> = {};
    if (d.name !== undefined) data.name = d.name;
    if (d.unit !== undefined) data.unit = d.unit;
    if (d.lowerBound !== undefined) data.lowerBound = d.lowerBound;
    if (d.upperBound !== undefined) data.upperBound = d.upperBound;
    if (d.panel !== undefined) data.panel = d.panel;
    if (d.hidden !== undefined) data.hidden = d.hidden;

    // Inverted-range guard for a PARTIAL bound update. The schema refine only
    // fires when both bounds arrive together; moving a single bound past the
    // row's existing other bound would otherwise persist an inverted window.
    // Merge effective bounds (parsed when present, else stored) and 422 when
    // both resolve to concrete numbers with low > high.
    if (
      isInvertedRange(
        effectiveBound(d.lowerBound, existing.lowerBound),
        effectiveBound(d.upperBound, existing.upperBound),
      )
    ) {
      return apiError("lowerBound must not exceed upperBound", 422, {
        errorCode: "labs.biomarker.update.referenceRangeInvalid",
      });
    }
    if (d.context !== undefined) {
      data.contextEncrypted = d.context
        ? encryptContextToBytes(d.context)
        : null;
    }

    const updated = await prisma.biomarker.update({ where: { id }, data });
    invalidateUserHealthScore(user.id);

    await auditLog("biomarker.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4, and this is the edit that needs it most: a reference range
      // recolours every reading under it, so the error is silent. The feed has
      // to show the range that was there before. The context note is named and
      // never quoted; it is encrypted on the row.
      details: {
        biomarkerId: id,
        ...overwriteDetails({
          before: {
            name: existing.name,
            unit: existing.unit,
            lowerBound: existing.lowerBound,
            upperBound: existing.upperBound,
            panel: existing.panel,
            hidden: existing.hidden,
          },
          after: {
            name: updated.name,
            unit: updated.unit,
            lowerBound: updated.lowerBound,
            upperBound: updated.upperBound,
            panel: updated.panel,
            hidden: updated.hidden,
          },
          redacted: d.context !== undefined ? ["context"] : [],
        }),
      },
    });

    annotate({
      action: { name: "labs.biomarker.update" },
      meta: { biomarkerId: id },
    });

    return apiSuccess(serialiseBiomarker(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.biomarker.findFirst({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Biomarker not found", 404);
    }

    // Hard delete the marker AND its readings in one transaction. Deleting a
    // biomarker is a deliberate "remove this and its history" action, so the
    // readings go with it rather than lingering as orphaned, unlinked rows.
    // Both legs are userId-narrowed so a cross-user id can never reach another
    // account's data.
    await prisma.$transaction([
      prisma.labResult.deleteMany({
        where: { userId: user.id, biomarkerId: id },
      }),
      prisma.biomarker.delete({ where: { id } }),
    ]);
    invalidateUserHealthScore(user.id);

    await auditLog("biomarker.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { biomarkerId: id },
    });

    annotate({
      action: { name: "labs.biomarker.delete" },
      meta: { biomarkerId: id },
    });

    return apiSuccess({ deleted: true });
  },
);
