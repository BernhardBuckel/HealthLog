/**
 * v1.42.2 — records each scheduled dose of an `autoMarkTaken` medication as
 * taken once its time has passed.
 *
 * For a person who takes a fixed dose reliably (three supplements every
 * evening) and does not want to confirm it every day, while compliance, the
 * dose history and the Coach still see every dose. Each pass, per opted-in
 * medication:
 *
 *   1. Expands the slots between the floor and now through the canonical
 *      recurrence engine (`occurrencesBetween`, era-aware through
 *      `occurrencesAcrossEras`): daysOfWeek, intervalWeeks, RRULE, cyclic
 *      on/off weeks, several times a day, start and end dates, one-shot, and
 *      a rolling interval counted from the last taken dose. Nothing about the
 *      cadence is re-derived here.
 *   2. Drops slots inside a pause era.
 *   3. Records each remaining slot as taken AT its scheduled instant, marked
 *      `autoRecorded`, unless the person already acted on it.
 *
 * The floor is the latest of `autoMarkTakenSince` (the option is never
 * applied to history before it was switched on), the medication's creation,
 * and a 7-day catch-up window (a worker that was down for a weekend still
 * fills the gap, but a pass never walks unbounded history).
 *
 * What counts as "already acted on", and is therefore never touched:
 *   - a live row on the slot that is taken, skipped, or auto-missed;
 *   - a tombstone on the slot with no live row: the person removed the dose,
 *     and putting it back would undo their correction;
 *   - a live taken row whose `takenAt` lies in the slot's band (a dose the
 *     person logged off the exact slot instant, early or late).
 * A pending placeholder on the slot (the today projector's or the reminder
 * worker's) is converted in place instead of gaining a sibling. The convert
 * is one conditional UPDATE that re-checks "still pending", so a take or skip
 * the person records at the same moment wins rather than being overwritten.
 *
 * Idempotent: a second pass finds every slot it recorded taken and moves on.
 *
 * A recorded dose then goes through the same follow-ups a manual take does:
 * the inventory consume hook (exactly-once on its stamp, units per dose
 * resolved per slot), the compliance rollup for the slot's day, the server
 * caches, the one-shot lifecycle, and the silent wake that lets the iOS app
 * reconcile its widgets.
 *
 * The hourly auto-miss pass (`intake-auto-skip.ts`) leaves the slots this job
 * owns alone, so the two never write the same slot.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { consumeForIntake } from "@/lib/medications/inventory/consumption";
import { reconcileOneShotState } from "@/lib/medications/lifecycle";
import {
  buildBandsForSchedulesWithEras,
  occurrencesAcrossEras,
} from "@/lib/medications/scheduling/schedule-eras";
import {
  occurrencesBetween,
  type Occurrence,
} from "@/lib/medications/scheduling/recurrence";
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
} from "@/lib/medications/scheduling/worker-helpers";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { isP2002 } from "@/lib/prisma-errors";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForEvent,
} from "@/lib/rollups/medication-compliance-rollups";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const INTAKE_AUTO_TAKE_QUEUE = "intake-auto-take";

/**
 * Every 15 minutes, off the reminder tick (:00/:15/:30/:45) and the hourly
 * auto-miss pass (:05). A 19:00 dose reads taken by 19:10 at the latest.
 */
export const INTAKE_AUTO_TAKE_CRON = "10,25,40,55 * * * *";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far back one pass catches up on slots it has not filled yet. */
export const INTAKE_AUTO_TAKE_LOOKBACK_MS = 7 * DAY_MS;

/**
 * A rolling cadence produces its next slot only once the previous one is
 * taken, so a pass that catches up re-expands after each recorded rolling
 * dose. Bounded so a malformed schedule can never spin.
 */
const MAX_EXPANSION_ROUNDS = 16;

export interface IntakeAutoTakePayload {
  triggeredAt?: string;
}

export interface IntakeAutoTakeResult {
  /** Opted-in medications the pass looked at. */
  medicationCount: number;
  /** Slots recorded taken on this pass (inserted + converted). */
  recordedCount: number;
  /** Of those, pending placeholders converted in place. */
  convertedCount: number;
  /** Users whose caches were dropped because a dose was recorded. */
  userIds: string[];
}

type AutoTakeClient = Pick<
  PrismaClient,
  | "medication"
  | "medicationIntakeEvent"
  | "medicationInventoryItem"
  | "$transaction"
>;

const SCHEDULE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
  doseWindows: true,
} as const;

/** One slot row as the occupancy check reads it. */
interface SlotRow {
  id: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
  deletedAt: Date | null;
}

export type SlotDecision =
  | { kind: "create" }
  | { kind: "convert"; rowId: string }
  | {
      kind: "leave";
      reason: "actioned" | "removed" | "taken_nearby";
    };

/**
 * Decide what the pass does with one slot, given every row of the
 * medication around it (live and tombstoned). Pure, so the precedence rules
 * are tested without a database.
 *
 * `band` is the slot's attribution band when the cadence has one (a take
 * anywhere inside it belongs to this slot); `null` for a rolling slot, whose
 * next occurrence is by definition later than every taken dose.
 */
export function decideSlot(
  slotAt: Date,
  rows: readonly SlotRow[],
  band: Pick<SlotBand, "earlyStart" | "overdueEnd"> | null,
): SlotDecision {
  const t = slotAt.getTime();
  const onSlot = rows.filter((r) => r.scheduledFor.getTime() === t);
  const liveOnSlot = onSlot.filter((r) => r.deletedAt === null);

  if (liveOnSlot.some((r) => r.takenAt !== null || r.skipped || r.autoMissed)) {
    return { kind: "leave", reason: "actioned" };
  }
  if (liveOnSlot.length === 0 && onSlot.length > 0) {
    return { kind: "leave", reason: "removed" };
  }
  if (band) {
    const from = band.earlyStart.getTime();
    const to = band.overdueEnd.getTime();
    const takenNearby = rows.some(
      (r) =>
        r.deletedAt === null &&
        !r.skipped &&
        r.takenAt !== null &&
        r.takenAt.getTime() >= from &&
        r.takenAt.getTime() <= to,
    );
    if (takenNearby) return { kind: "leave", reason: "taken_nearby" };
  }
  const pending = [...liveOnSlot].sort(
    (a, b) => a.id.localeCompare(b.id), // deterministic pick on duplicates
  )[0];
  return pending ? { kind: "convert", rowId: pending.id } : { kind: "create" };
}

/** True when `at` falls inside a `[pausedAt, resumedAt ?? now)` pause era. */
export function isInPauseEra(
  at: Date,
  eras: readonly { pausedAt: Date; resumedAt: Date | null }[],
  now: Date,
): boolean {
  const t = at.getTime();
  return eras.some(
    (era) =>
      t >= era.pausedAt.getTime() && t < (era.resumedAt ?? now).getTime(),
  );
}

/** The slot floor for one medication: see the module comment. */
export function autoTakeFloor(input: {
  autoMarkTakenSince: Date;
  createdAt: Date;
  now: Date;
}): Date {
  return new Date(
    Math.max(
      input.autoMarkTakenSince.getTime(),
      input.createdAt.getTime(),
      input.now.getTime() - INTAKE_AUTO_TAKE_LOOKBACK_MS,
    ),
  );
}

interface AutoTakeMedication {
  id: string;
  userId: string;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  autoMarkTakenSince: Date | null;
  schedules: Parameters<typeof buildCanonicalSchedule>[0][];
  scheduleRevisions: {
    id: string;
    validFrom: Date;
    validUntil: Date;
    payload: unknown;
    supersededByRevisionId: string | null;
  }[];
  pauseEras: { pausedAt: Date; resumedAt: Date | null }[];
  user: { timezone: string | null };
}

/**
 * The slots of one medication that are due by `now` and not before `floor`,
 * in chronological order. Pure; `lastIntakeAt` anchors a rolling cadence.
 */
export function dueAutoTakeSlots(input: {
  medication: AutoTakeMedication;
  userTz: string;
  floor: Date;
  now: Date;
  lastIntakeAt: Date | null;
}): Occurrence[] {
  const { medication, userTz, floor, now } = input;
  const ctx = buildRecurrenceContext({
    medication,
    userTz,
    lastIntakeAt: input.lastIntakeAt,
  });
  const live = medication.schedules.map(buildCanonicalSchedule);
  const slots = occurrencesAcrossEras(
    { from: floor, to: now },
    medication.scheduleRevisions,
    live,
    (schedule, from, to) => occurrencesBetween(schedule, from, to, ctx),
    { oneShot: medication.oneShot },
  );
  const seen = new Set<number>();
  return slots.filter((slot) => {
    const t = slot.at.getTime();
    if (t < floor.getTime() || t > now.getTime()) return false;
    if (isInPauseEra(slot.at, medication.pauseEras, now)) return false;
    // Two schedules on one medication naming the same instant are one slot
    // (the intake row is keyed on the instant, not the schedule).
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

/**
 * The attribution bands around the floor..now window, so a dose the person
 * logged off the exact slot instant still claims its slot. Keyed by anchor.
 */
function bandsByAnchor(input: {
  medication: AutoTakeMedication;
  userTz: string;
  floor: Date;
  now: Date;
  lastIntakeAt: Date | null;
}): Map<number, SlotBand> {
  const { medication, userTz, floor, now } = input;
  const ctx = buildRecurrenceContext({
    medication,
    userTz,
    lastIntakeAt: input.lastIntakeAt,
  });
  const groups = buildBandsForSchedulesWithEras({
    medication,
    schedules: medication.schedules.map(buildCanonicalSchedule),
    revisions: medication.scheduleRevisions,
    ctx,
    userTz,
    // A day of padding each side so the first and last slots' neighbours
    // exist and their bands are capped the way the ledger caps them.
    range: {
      from: new Date(floor.getTime() - DAY_MS),
      to: new Date(now.getTime() + DAY_MS),
    },
    now,
  });
  const map = new Map<number, SlotBand>();
  for (const group of groups) {
    for (const band of group.bands) map.set(band.at.getTime(), band);
  }
  return map;
}

/**
 * Run one pass. Pure over the injected client so a unit test drives it with
 * a fake and the integration test with a real Postgres.
 */
export async function runIntakeAutoTakePass(
  prisma: AutoTakeClient,
  options: { nowMs?: number } = {},
): Promise<IntakeAutoTakeResult> {
  const now = new Date(options.nowMs ?? Date.now());

  const medications = (await prisma.medication.findMany({
    where: {
      autoMarkTaken: true,
      autoMarkTakenSince: { not: null, lte: now },
      active: true,
      pausedAt: null,
      asNeeded: false,
      // A record-only medication expects no dose, so none is recorded.
      ...TRACKED_INTAKE_WHERE,
    },
    select: {
      id: true,
      userId: true,
      startsOn: true,
      endsOn: true,
      oneShot: true,
      createdAt: true,
      autoMarkTakenSince: true,
      schedules: { select: SCHEDULE_SELECT },
      scheduleRevisions: {
        orderBy: { validFrom: "asc" },
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          payload: true,
          supersededByRevisionId: true,
        },
      },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      user: { select: { timezone: true } },
    },
  })) as AutoTakeMedication[];

  let recordedCount = 0;
  let convertedCount = 0;
  const touchedUsers = new Set<string>();

  for (const medication of medications) {
    if (!medication.autoMarkTakenSince || medication.schedules.length === 0) {
      continue;
    }
    const userTz = medication.user.timezone || DEFAULT_TIMEZONE;
    const floor = autoTakeFloor({
      autoMarkTakenSince: medication.autoMarkTakenSince,
      createdAt: medication.createdAt,
      now,
    });
    const rolling = medication.schedules.some(
      (s) => s.rollingIntervalDays !== null,
    );

    const outcome = await autoTakeMedication(prisma, {
      medication,
      userTz,
      floor,
      now,
      rolling,
    });
    recordedCount += outcome.recorded.length;
    convertedCount += outcome.converted;
    if (outcome.recorded.length === 0) continue;

    touchedUsers.add(medication.userId);
    // The same follow-ups the intake routes run after a manual take.
    const days = new Set<string>();
    for (const slot of outcome.recorded) {
      await consumeForIntake({
        client: prisma,
        userId: medication.userId,
        medicationId: medication.id,
        eventId: slot.eventId,
        intakeAt: slot.at,
      });
      const dayKey = dayKeyForScheduledFor(slot.at, userTz);
      if (days.has(dayKey)) continue;
      days.add(dayKey);
      await recomputeMedicationComplianceForEvent({
        userId: medication.userId,
        medicationId: medication.id,
        scheduledFor: slot.at,
        tz: userTz,
      });
    }
    if (medication.oneShot) {
      await reconcileOneShotState(prisma, medication.id, medication.userId);
    }
  }

  for (const userId of touchedUsers) {
    invalidateUserMedications(userId, { evict: true });
    // Wakes the person's iOS devices so a widget or Live Activity showing
    // the dose as open reconciles. Coalesced per user, best-effort.
    queueMedicationIntakeSync({ userId, originDeviceToken: null });
  }

  return {
    medicationCount: medications.length,
    recordedCount,
    convertedCount,
    userIds: [...touchedUsers],
  };
}

async function autoTakeMedication(
  prisma: AutoTakeClient,
  input: {
    medication: AutoTakeMedication;
    userTz: string;
    floor: Date;
    now: Date;
    rolling: boolean;
  },
): Promise<{ recorded: { eventId: string; at: Date }[]; converted: number }> {
  const { medication, userTz, floor, now, rolling } = input;
  const recorded: { eventId: string; at: Date }[] = [];
  let converted = 0;
  const handled = new Set<number>();

  // Every row of the medication around the window, tombstones included: a
  // tombstone on a slot is the person's removal and must be seen.
  const rows: SlotRow[] = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: medication.userId,
      medicationId: medication.id,
      OR: [
        {
          scheduledFor: {
            gte: new Date(floor.getTime() - DAY_MS),
            lte: new Date(now.getTime() + DAY_MS),
          },
        },
        {
          takenAt: {
            gte: new Date(floor.getTime() - DAY_MS),
            lte: new Date(now.getTime() + DAY_MS),
          },
        },
      ],
    },
    select: {
      id: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
      autoMissed: true,
      deletedAt: true,
    },
  });

  let lastIntakeAt: Date | null = null;
  if (rolling) {
    const last = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId: medication.userId,
        medicationId: medication.id,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    lastIntakeAt = last?.takenAt ?? null;
  }

  for (let round = 0; round < MAX_EXPANSION_ROUNDS; round++) {
    const slots = dueAutoTakeSlots({
      medication,
      userTz,
      floor,
      now,
      lastIntakeAt,
    }).filter((slot) => !handled.has(slot.at.getTime()));
    if (slots.length === 0) break;
    const bands = bandsByAnchor({
      medication,
      userTz,
      floor,
      now,
      lastIntakeAt,
    });

    let recordedRolling = false;
    for (const slot of slots) {
      handled.add(slot.at.getTime());
      const isRollingSlot =
        medication.schedules.find((s) => s.id === slot.scheduleId)
          ?.rollingIntervalDays != null;
      const decision = decideSlot(
        slot.at,
        rows,
        isRollingSlot ? null : (bands.get(slot.at.getTime()) ?? null),
      );
      const written = await applyDecision(prisma, {
        decision,
        medication,
        at: slot.at,
      });
      if (!written) continue;
      recorded.push({ eventId: written.id, at: slot.at });
      if (decision.kind === "convert") converted++;
      // Keep the in-memory view current so a later slot's nearby-take check
      // and a rolling re-expansion see this dose.
      rows.push({
        id: written.id,
        scheduledFor: slot.at,
        takenAt: slot.at,
        skipped: false,
        autoMissed: false,
        deletedAt: null,
      });
      if (isRollingSlot) {
        recordedRolling = true;
        if (!lastIntakeAt || slot.at.getTime() > lastIntakeAt.getTime()) {
          lastIntakeAt = slot.at;
        }
      }
    }
    // Only a rolling cadence yields new slots after a recorded dose.
    if (!recordedRolling) break;
  }

  return { recorded, converted };
}

async function applyDecision(
  prisma: AutoTakeClient,
  input: {
    decision: SlotDecision;
    medication: AutoTakeMedication;
    at: Date;
  },
): Promise<{ id: string } | null> {
  const { decision, medication, at } = input;
  if (decision.kind === "leave") return null;

  if (decision.kind === "convert") {
    // Conditional: still pending at the moment of the write. A take or skip
    // the person records concurrently makes this match nothing.
    const { count } = await prisma.medicationIntakeEvent.updateMany({
      where: {
        id: decision.rowId,
        deletedAt: null,
        takenAt: null,
        skipped: false,
        autoMissed: false,
      },
      data: {
        takenAt: at,
        autoRecorded: true,
        syncVersion: { increment: 1 },
      },
    });
    return count === 1 ? { id: decision.rowId } : null;
  }

  try {
    return await prisma.medicationIntakeEvent.create({
      data: {
        userId: medication.userId,
        medicationId: medication.id,
        scheduledFor: at,
        takenAt: at,
        skipped: false,
        // The server wrote it, as for the projector's and the reminder
        // worker's slot rows; `autoRecorded` says which server path.
        source: "REMINDER",
        autoRecorded: true,
      },
      select: { id: true },
    });
  } catch (err) {
    // A placeholder minted for the same slot between the read and this
    // insert. The next pass converts it.
    if (isP2002(err)) return null;
    throw err;
  }
}
