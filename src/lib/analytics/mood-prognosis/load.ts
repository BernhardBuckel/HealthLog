/**
 * The database read behind the fit, and nothing else.
 *
 * Separate from `features.ts` on purpose. `features.ts` is pure, and it shares
 * `feature-keys.ts` with the client component that labels a stored feature key
 * (`components/insights/mood/prognosis-feature-label.ts` imports the parser
 * from there) — so those two modules form a Prisma-free island the browser
 * bundle can reach. A database import in `features.ts` would drag the client
 * towards that bundle; keeping the read here is what holds the line. The split
 * is the boundary, not a preference.
 *
 * **One row per day, taken whole from one entry.** A day with two entries
 * contributes the later one — its target, its dimensions and its context
 * together. Averaging the ratings and taking the context from whichever entry
 * happened to carry one would build a row nobody logged, and the model would
 * then be fitted on days that did not happen.
 *
 * The day key is the entry's own `date`, already resolved in the zone the
 * entry was written in. Re-deriving it here from `moodLoggedAt` would be a
 * second opinion about which day a row belongs to, which is the class of bug
 * the per-row `tz` column was added to end.
 */
import { prisma } from "@/lib/db";
import { decodeKeyList } from "@/lib/mood/context-vocabulary";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { resolveLinkedDayFigures } from "@/lib/mood/linked-context";

import type { PrognosisDayInput } from "./features";

/**
 * How far back the fit looks.
 *
 * A year: long enough to hold a seasonal swing, short enough that a life that
 * changed two years ago is not still being fitted against today. Longer would
 * also make the per-user standardisation describe somebody the person no
 * longer is.
 */
export const PROGNOSIS_FIT_WINDOW_DAYS = 365;

/**
 * How many recent days the job writes a forecast for.
 *
 * Not the whole window: a forecast is worth storing for the days somebody
 * might still be looking at. Older rows are recomputable and are deleted on
 * every pass, which is also what keeps a stale forecast from outliving the
 * data it was fitted on.
 */
export const PROGNOSIS_WRITE_WINDOW_DAYS = 7;

/**
 * Hard cap on the rows one fit reads.
 *
 * A year holds 365 days and the fold keeps one entry per day, so the cap only
 * ever bites on an account that logs many times a day — and there it bites on
 * the oldest days, which is the right end to lose. It is here because an
 * unbounded `findMany` in a nightly job over an account with years of history
 * is a table scan waiting for the account that has one.
 */
export const MAX_PROGNOSIS_ROWS = 5000;

/** `YYYY-MM-DD`, this many days before the given instant, in UTC terms. */
export function dayKeyBefore(now: Date, days: number): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: far edge of the fit window on stored day keys; a day either way does not change the fit
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every day of the fit window, in day order, with everything the matrix needs.
 *
 * The linked figures come from the resolver that owns them, over the whole
 * window in one query. They are read in the account's display zone: the entry
 * rows carry their own zone for their own day key, but a step count has to be
 * bucketed under some zone, and the account's own is the one every other
 * surface uses.
 */
export async function loadPrognosisDays(
  userId: string,
  now: Date,
  timezone: string | null,
  windowDays: number = PROGNOSIS_FIT_WINDOW_DAYS,
): Promise<PrognosisDayInput[]> {
  const since = dayKeyBefore(now, windowDays);
  const entries = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, date: { gte: since } },
    // Descending, and the fold below keeps the FIRST row it sees per day, so
    // "the last entry of a day wins" is the read order rather than a
    // comparison. Descending also puts the cap on the right end: an account
    // that logs many times a day loses its oldest days to the limit, never
    // its newest ones, and the newest are the days a forecast is written for.
    orderBy: [{ date: "desc" }, { moodLoggedAt: "desc" }],
    take: MAX_PROGNOSIS_ROWS,
    select: {
      date: true,
      moodA1: true,
      stressA2: true,
      energyA3: true,
      connectionA4: true,
      stabilityA5: true,
      context: {
        select: {
          workStatus: true,
          workMinutes: true,
          overtimeMinutes: true,
          workLoad: true,
          workSatisfaction: true,
          contactCircles: true,
          contactForm: true,
          contactExtent: true,
          contactQuality: true,
          contactSupport: true,
          leisureCategories: true,
          leisureMinutes: true,
          leisureJoy: true,
          leisureRecovery: true,
          eventType: true,
          eventValence: true,
          // The note is deliberately not selected. It is encrypted free text
          // about somebody's day and the model has no use for it; a fit does
          // not read prose, and a query that decrypted it anyway would be
          // reading a diary to compute an average.
        },
      },
    },
  });

  const byDay = new Map<string, PrognosisDayInput>();
  for (const entry of entries) {
    // The rows arrive newest first, so the first one seen for a day is that
    // day's last entry.
    if (byDay.has(entry.date)) continue;
    byDay.set(entry.date, {
      day: entry.date,
      a1: entry.moodA1,
      dimensions: {
        a2: entry.stressA2,
        a3: entry.energyA3,
        a4: entry.connectionA4,
        a5: entry.stabilityA5,
      },
      context: entry.context
        ? {
            workStatus: entry.context.workStatus,
            workMinutes: entry.context.workMinutes,
            overtimeMinutes: entry.context.overtimeMinutes,
            workLoad: entry.context.workLoad,
            workSatisfaction: entry.context.workSatisfaction,
            contactCircles: decodeKeyList(entry.context.contactCircles),
            contactForm: entry.context.contactForm,
            contactExtent: entry.context.contactExtent,
            contactQuality: entry.context.contactQuality,
            contactSupport: entry.context.contactSupport,
            leisureCategories: decodeKeyList(entry.context.leisureCategories),
            leisureMinutes: entry.context.leisureMinutes,
            leisureJoy: entry.context.leisureJoy,
            leisureRecovery: entry.context.leisureRecovery,
            eventType: entry.context.eventType,
            eventValence: entry.context.eventValence,
          }
        : null,
      linked: {
        sleepAsleep: null,
        steps: null,
        activeEnergy: null,
        restingHeartRate: null,
        heartRateVariability: null,
      },
    });
  }

  const days = [...byDay.keys()].sort();
  if (days.length === 0) return [];

  const linked = await resolveLinkedDayFigures(
    userId,
    days,
    timezone ?? DEFAULT_TIMEZONE,
  );
  for (const day of days) {
    const figures = linked.get(day);
    if (figures) byDay.get(day)!.linked = figures;
  }

  return days.map((day) => byDay.get(day)!);
}

/**
 * How many days of the window carry a self-rated pleasantness.
 *
 * The number the ladder is read against, and the number a surface quotes when
 * it explains why there is nothing yet. Days, not entries: two entries on one
 * Tuesday are one Tuesday, and counting them as two would let somebody reach
 * a threshold by logging twice a day for a fortnight.
 */
export async function countQualifyingDays(
  userId: string,
  now: Date,
  windowDays: number = PROGNOSIS_FIT_WINDOW_DAYS,
): Promise<number> {
  const since = dayKeyBefore(now, windowDays);
  const days = await prisma.moodEntry.findMany({
    where: {
      userId,
      deletedAt: null,
      moodA1: { not: null },
      date: { gte: since },
    },
    distinct: ["date"],
    select: { date: true },
    // Bounded by the window either way — a year holds 366 distinct day keys —
    // and the cap says so rather than trusting the window to be small.
    take: 400,
  });
  return days.length;
}
