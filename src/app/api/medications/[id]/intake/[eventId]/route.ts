import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import {
  applyCanonicalSlotWrite,
  findPinConflict,
  resolveForcedSlotForWrite,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import { NextRequest } from "next/server";
import { dateOnlyKey } from "@/lib/tz/date-only";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting a dose tombstones the original and
    // re-creates it on the corrected slot, so the write is reconstructable by
    // the rows; what it must not do is restamp where the dose came from (C8).
    const { user } = await requireRecordAuth("manage", "medications");

    const { id, eventId } = await params;

    // v1.7.0 sync — a tombstoned event 404s on PUT; the `deletedAt: null`
    // filter refuses to resurrect-edit a soft-deleted intake.
    const event = await prisma.medicationIntakeEvent.findFirst({
      where: { id: eventId, deletedAt: null },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });

    if (jsonError) return jsonError;
    const parsed = updateIntakeEventSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — per-event update hot path; multi-issue 422 +
      // audit breadcrumb keyed
      // `medications.intake.event.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.event.update.validation-failed" },
        meta: {
          issue_count: issues.length,
          medication_id: id,
          event_id: eventId,
        },
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("medications.intake.event.update.validation-failed", {
        userId: user.id,
        details: {
          issues,
          medicationId: id,
          eventId,
        },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const data = parsed.data;

    // v1.15.19 — start-date guard on an edited `takenAt` (audit P0-4). The
    // schema bounds the instant to a plausible absolute range; this check
    // adds the per-medication floor: a take cannot predate the day the
    // medication starts (calendar-day comparison in the user's timezone, so
    // a take in the early hours of the start day never false-rejects).
    if (data.takenAt instanceof Date) {
      const medication = await prisma.medication.findFirst({
        where: { id, userId: user.id },
        select: { startsOn: true },
      });
      if (medication?.startsOn) {
        const takenDay = dayKeyForUserTz(data.takenAt, user.timezone);
        const startsOnDay = dateOnlyKey(medication.startsOn);
        if (takenDay < startsOnDay) {
          annotate({
            action: {
              name: "medications.intake.event.update.before-start-date",
            },
            meta: { medication_id: id, event_id: eventId },
          });
          return apiError(
            "takenAt is before the medication's start date",
            422,
            { errorCode: "medications.intake.taken_at.before_start" },
          );
        }
      }
    }

    // The post-edit state of the row (current values where the body omits a
    // field) — drives the re-attribution decision.
    const nextTakenAt =
      data.takenAt !== undefined ? data.takenAt : event.takenAt;
    const nextSkipped =
      data.skipped !== undefined ? data.skipped : event.skipped;
    const takenOrSkippedChanged =
      (data.takenAt !== undefined &&
        data.takenAt?.getTime() !== event.takenAt?.getTime()) ||
      (data.skipped !== undefined && data.skipped !== event.skipped);

    // v1.15.18 — re-run window-band attribution when the edit moves `takenAt`
    // or `skipped`, so an edited time re-binds to the correct slot instead of
    // leaving `scheduledFor` stale (audit HIGH-4). Precedence:
    //   1. an explicit `scheduledFor` in the body wins (deliberate override);
    //   2. else `forceSlotInstant` pins onto a named real slot (422 if it is
    //      not a slot of this med) — v1.15.20: standalone too, no takenAt /
    //      skipped change required ("Slot zuordnen" from the ledger kebab),
    //      and the row is stamped USER_PIN so the read ledger binds it by
    //      anchor instead of degrading the off-window take back to ad-hoc;
    //   3. else an explicit `forceSlotInstant: null` UNPINS (v1.15.20,
    //      "Zuordnung lösen"): re-attribute the take by band on its takenAt
    //      (ad-hoc when no band matches). v1.16.0 — the release is itself a
    //      deliberate binding decision, so the row KEEPS `USER_PIN`
    //      provenance ("attribution user-fixed": onto a slot OR deliberately
    //      ad-hoc). The persisted marker is what keeps the nightly slot
    //      dedup from snapping the released row back into the cluster the
    //      user just detached it from;
    //   4. else a taken edit attributes by band (slot anchor on match, the
    //      take's own time on a miss → ad-hoc), provenance AUTO;
    //   5. a skip / pending edit keeps the existing `scheduledFor` anchor.
    let resolvedScheduledFor: Date | undefined = data.scheduledFor;
    let attributionSource: "AUTO" | "USER_PIN" | undefined;
    if (resolvedScheduledFor === undefined) {
      if (
        data.forceSlotInstant !== undefined &&
        data.forceSlotInstant !== null
      ) {
        const forced = await resolveForcedSlotForWrite({
          userId: user.id,
          medicationId: id,
          userTz: user.timezone,
          slotInstant: data.forceSlotInstant,
        });
        if (forced === null) {
          annotate({
            action: { name: "medication.intake.force_slot.invalid" },
            meta: { medication_id: id, event_id: eventId },
          });
          return apiError(
            "forceSlotInstant is not a scheduled slot of this medication",
            422,
            { errorCode: "medications.intake.force_slot.invalid" },
          );
        }
        // v1.16.0 — refuse to pin onto a slot another recorded action
        // already serves (excluding the row being edited): the explicit-
        // write last-write-wins rule would silently overwrite that dose
        // record. The ledger UI only offers the pin for unserved slots,
        // so this only fires for stale clients / raw API calls.
        if (
          await findPinConflict({
            userId: user.id,
            medicationId: id,
            canonicalSlot: forced,
            incomingTakenAt: nextSkipped ? null : nextTakenAt,
            excludeEventId: eventId,
          })
        ) {
          annotate({
            action: { name: "medication.intake.force_slot.occupied" },
            meta: { medication_id: id, event_id: eventId },
          });
          return apiError(
            "forceSlotInstant already carries a recorded dose action",
            422,
            { errorCode: "medications.intake.force_slot.occupied" },
          );
        }
        resolvedScheduledFor = forced;
        attributionSource = "USER_PIN";
      } else if (
        (data.forceSlotInstant === null || takenOrSkippedChanged) &&
        nextTakenAt !== null &&
        !nextSkipped
      ) {
        const attribution = await resolveSlotForWriteByBand({
          userId: user.id,
          medicationId: id,
          userTz: user.timezone,
          takenAt: nextTakenAt,
        });
        // band.at on match; the take's own time on a miss (ad-hoc).
        resolvedScheduledFor = attribution.slotInstant ?? nextTakenAt;
        // v1.16.0 — an explicit unpin stays user-fixed (USER_PIN) even on
        // the released row; a plain taken/skipped edit re-attributes AUTO.
        attributionSource =
          data.forceSlotInstant === null ? "USER_PIN" : "AUTO";
      } else if (data.forceSlotInstant === null) {
        // Unpin on a row that is not a confirmed take (skip / pending):
        // nothing to re-attribute, but the provenance still resets — a
        // skip / pending row anchors on its slot by construction, so there
        // is no user-fixed ad-hoc decision to persist.
        attributionSource = "AUTO";
      }
      // skip / pending edits leave `scheduledFor` on the existing anchor.
    }

    const targetScheduledFor = resolvedScheduledFor ?? event.scheduledFor;
    const slotMoved =
      targetScheduledFor.getTime() !== event.scheduledFor.getTime();

    // v1.16.10 — transition gate for the inventory hooks below. Only an
    // edit moving the row INTO taken may consume; a row that was
    // already taken keeps its stamp frozen (a stamped row would no-op
    // anyway, and a pre-v1.16.10 taken row — NULL stamp, stock already
    // moved by the legacy hook at take time — must never retro-consume
    // on a time correction).
    const wasTaken = event.takenAt !== null && !event.skipped;

    let updated;
    if (!slotMoved) {
      // The slot is unchanged — a bare in-place update can never collide with
      // a sibling row (it is its own slot).
      updated = await prisma.medicationIntakeEvent.update({
        where: { id: eventId },
        data: {
          ...(data.takenAt !== undefined && { takenAt: data.takenAt }),
          ...(data.skipped !== undefined && { skipped: data.skipped }),
          // v1.15.20 — binding provenance: pin / unpin / band re-attribution
          // stamps it even when the anchor itself did not move (e.g. a pin
          // onto the slot the row already sits on, or an unpin whose band
          // re-attribution lands on the same anchor).
          ...(attributionSource !== undefined && { attributionSource }),
          // v1.7.0 sync — bump the reconciliation counter on every
          // server-side mutation so the `/api/sync/changes` feed echoes a
          // monotonic value to paired clients.
          syncVersion: { increment: 1 },
        },
      });
      // v1.16.10 — inventory follows the post-edit state: an edit that
      // moves the row INTO taken consumes; a row that stays taken keeps
      // its stamp untouched (the stamp freezes what the original take
      // pulled, even when `unitsPerDose` changed since, and a pre-stamp
      // legacy row must not retro-consume); a row edited out of taken
      // (skip flip, takenAt cleared) refunds its stamp.
      if (nextTakenAt !== null && !nextSkipped) {
        if (!wasTaken) {
          await consumeForIntake({
            client: prisma,
            userId: user.id,
            medicationId: id,
            eventId,
            intakeAt: nextTakenAt,
          });
        }
      } else {
        await restoreForIntake({
          client: prisma,
          userId: user.id,
          eventId,
        });
      }
    } else {
      // The edit moved the dose to a different slot. Tombstone the original
      // row (the iOS "a correction is a tombstone + re-insert" model the
      // DELETE handler documents) and route the corrected dose through the
      // shared canonical-slot upsert, which converges onto any row already at
      // the target slot (a pending REMINDER row) rather than bare-updating
      // into an occupied slot and risking a P2002 (audit HIGH-4).
      //
      // v1.16.10 — refund the source row's consumption stamp BEFORE the
      // tombstone; the consume on the converged row below nets the move
      // to exactly one consumption.
      await restoreForIntake({
        client: prisma,
        userId: user.id,
        eventId,
      });
      await prisma.medicationIntakeEvent.update({
        where: { id: eventId },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      const applied = await applyCanonicalSlotWrite({
        client: prisma,
        userId: user.id,
        medicationId: id,
        canonicalSlot: targetScheduledFor,
        takenAt: nextSkipped ? null : nextTakenAt,
        skipped: nextSkipped,
        isExplicitTaken: !nextSkipped && nextTakenAt !== null,
        isExplicitSkip: nextSkipped,
        idempotencyKey: null,
        // C8 — the converged row keeps the ORIGINAL's provenance. This used
        // to be a hardcoded `"WEB"`, which said "somebody typed this in the
        // browser" about an Apple Health dose whose time was corrected. Under
        // MANAGE the sentence would be wrong about a second person as well.
        createSource: event.source,
        attributionSource,
        // v1.16.9 — a slot move is a re-binding, not a new dose: the
        // original row's recorded injection site and dose override ride
        // along onto the converged row instead of being tombstoned away.
        injectionSite: event.injectionSite,
        doseTaken: event.doseTaken,
      });
      updated = applied.row;
      // A taken source WITHOUT a stamp is a pre-v1.16.10 row whose
      // stock moved through the legacy hook: the refund above was a
      // no-op, so consuming on the converged row would double-charge —
      // skip it. Every other taken outcome nets the move to exactly one
      // consumption.
      if (
        nextTakenAt !== null &&
        !nextSkipped &&
        (!wasTaken || event.inventoryConsumption !== null)
      ) {
        await consumeForIntake({
          client: prisma,
          userId: user.id,
          medicationId: id,
          eventId: applied.row.id,
          intakeAt: nextTakenAt,
        });
      }
    }

    await auditLog("medication.intake.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4 — what the correction moved. A dose edit changes when a dose is
      // recorded as taken, which is exactly what a clinician reads back.
      details: {
        eventId,
        medicationId: id,
        ...overwriteDetails({
          before: {
            scheduledFor: event.scheduledFor,
            takenAt: event.takenAt,
            skipped: event.skipped,
          },
          // The slot-write result carries the canonical four. The injection
          // site and the dose override are not compared here because the move
          // path copies them onto the converged row by construction — there is
          // no edit of them to report.
          after: {
            scheduledFor: updated.scheduledFor,
            takenAt: updated.takenAt,
            skipped: updated.skipped,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "medication.intake.update",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the edited event.
    invalidateUserMedications(user.id, { evict: true });

    // v1.4.39 W-MED — refresh the rollup row for both the old + new
    // scheduledFor day-keys when the dose moved across a day boundary
    // (band re-attribution can move it as well as an explicit edit); if the
    // slot is unchanged the second call collapses to a no-op upsert.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });
    if (slotMoved) {
      await recomputeMedicationComplianceForEvent({
        userId: user.id,
        medicationId: id,
        scheduledFor: targetScheduledFor,
        tz: user.timezone,
      });
    }

    // v1.5.0 — re-evaluate the one-shot active flag. A skip-flip on the
    // single live intake of a one-shot medication should reactivate it
    // (the dose is no longer logged), and the reverse case should
    // deactivate again. No-op for non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    // (#22) — silent cross-device intake sync: an edited dose must
    // reconcile on the user's other iOS devices too. Coalesced per user,
    // best-effort — never affects the response.
    queueMedicationIntakeSync({
      userId: user.id,
      originDeviceToken: request.headers.get("x-device-id"),
    });

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete: the row stays, the sync feed carries the
    // tombstone, and the inventory stamp is refunded.
    const { user } = await requireRecordAuth("manage", "medications");

    const { id, eventId } = await params;

    const event = await prisma.medicationIntakeEvent.findUnique({
      where: { id: eventId },
    });

    if (!event || event.userId !== user.id || event.medicationId !== id) {
      return apiError("Intake not found", 404);
    }

    // v1.16.10 — a deleted dose record refunds its consumption stamp
    // (no-op for a never-consumed row; a re-delete finds it cleared).
    await restoreForIntake({
      client: prisma,
      userId: user.id,
      eventId,
    });

    // v1.7.0 sync — soft-delete instead of a hard `delete`. An intake is
    // an immutable fact, so a "correction" is a tombstone + re-insert
    // (never an in-place edit). Setting `deletedAt` (+ bumping
    // `syncVersion`) leaves the row in place so the `/api/sync/changes`
    // feed surfaces the deletion as a tombstone keyed on the server `id`
    // to paired clients offline at delete time. Every today / compliance
    // / list read filters `deletedAt: null`, so the row is invisible to
    // normal reads from here on. A re-delete re-bumps harmlessly.
    await prisma.medicationIntakeEvent.update({
      where: { id: eventId },
      data: {
        deletedAt: new Date(),
        syncVersion: { increment: 1 },
      },
    });

    const ip = getClientIp(request) ?? "unknown";
    await auditLog("medication.intake.delete", {
      userId: user.id,
      ipAddress: ip,
      details: { eventId, medicationId: id },
    });

    annotate({
      action: {
        name: "medication.intake.delete",
        entity_type: "intake_event",
        entity_id: eventId,
      },
      meta: { medication_id: id },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id, { evict: true });

    // v1.4.39 W-MED — refresh the rollup row for the day the deleted
    // event sat on. When that day now holds zero events the helper
    // drops the rollup row entirely.
    await recomputeMedicationComplianceForEvent({
      userId: user.id,
      medicationId: id,
      scheduledFor: event.scheduledFor,
      tz: user.timezone,
    });

    // v1.5.0 — re-evaluate the one-shot active flag. Deleting the
    // single live intake of a one-shot medication reactivates it so
    // the dashboard / lists / worker pick it back up. No-op for
    // non-one-shot medications.
    await reconcileOneShotState(prisma, id, user.id);

    // (#22) — silent cross-device intake sync: an undone dose must
    // reconcile on the user's other iOS devices (the widget count and a
    // pending Live Activity both change). Coalesced per user,
    // best-effort — never affects the response.
    queueMedicationIntakeSync({
      userId: user.id,
      originDeviceToken: request.headers.get("x-device-id"),
    });

    return apiSuccess({ deleted: true });
  },
);
