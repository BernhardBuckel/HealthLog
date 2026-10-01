import { prisma } from "@/lib/db";

/**
 * Dated failure marker for the daily-briefing generation.
 *
 * The briefing keeps its last good payload on a failed refresh: the generator
 * writes NO `User.insightsCachedText` row when a provider times out or errors,
 * so the previous briefing stays intact and the surface never blanks. What was
 * missing is a signal the READ path can use to tell the difference between "no
 * refresh was due" and "the last refresh attempt failed" — without that, a
 * stale-but-shown briefing reads as current and a never-generated one shows a
 * generic empty state instead of an honest "couldn't generate".
 *
 * This records an append-only `auditLog` row (no migration, no overwrite of the
 * cached text) carrying the calendar day, the reason, and the locale. The read
 * path compares the latest marker's timestamp against the last successful
 * generation (`User.insightsCachedAt`): a marker newer than the last success
 * means the most recent attempt failed.
 */
export const BRIEFING_FAILURE_ACTION = "insights.briefing-failure";

/**
 * Coarse class of a briefing-generation failure, used by the read path to
 * point the empty-state hint at the right lever:
 *   - `timeout`     — the generation ran out of time (no upstream HTTP status,
 *                     or a transport/abort error). Lever: raise the AI response
 *                     timeout for a slow local model.
 *   - `auth`        — the provider rejected the request (4xx that is not 429).
 *                     Lever: re-check the provider / API key in Settings.
 *   - `rate-limit`  — the provider returned 429.
 *   - `provider`    — a 5xx / generic upstream failure.
 *   - `format`      — the model returned unparseable output (invalid JSON).
 *   - `unknown`     — anything that does not classify.
 */
export type BriefingFailureClass =
  "timeout" | "auth" | "rate-limit" | "provider" | "format" | "unknown";

/**
 * Classify a failure from its recorded reason and (optional) upstream HTTP
 * status. A reason of `invalid-json` is always a format miss; a 401/403 (or any
 * other non-429 4xx) is an auth / configuration problem; 429 is a rate limit; a
 * 5xx is a generic provider failure. With no status at all — the timeout /
 * transport / abort path, which is the dominant briefing failure on a slow
 * self-hosted backend — the most useful lever is the response-timeout, so it
 * classifies as `timeout`.
 */
export function classifyBriefingFailure(args: {
  reason: string;
  httpStatus?: number | null;
}): BriefingFailureClass {
  if (args.reason === "invalid-json") return "format";
  const status = args.httpStatus;
  if (typeof status === "number" && status > 0) {
    if (status === 429) return "rate-limit";
    if (status >= 400 && status < 500) return "auth";
    if (status >= 500) return "provider";
  }
  // No / sentinel-zero upstream status: a transport-level timeout or abort.
  return "timeout";
}

/** UTC YYYY-MM-DD calendar-day key for the marker payload. */
function dateKey(at: Date = new Date()): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: internal once-per-day marker key, written and read by this module only, never shown
  return at.toISOString().slice(0, 10);
}

/**
 * Append a failure marker for `userId`. Best-effort: a write failure here must
 * never propagate out of the generation's own failure path.
 */
export async function recordBriefingFailure(args: {
  userId: string;
  reason: string;
  locale?: string;
  /**
   * v1.25.3 — upstream HTTP status when the failure carried one, so the read
   * path can tell an auth / rate-limit / provider failure apart from a plain
   * timeout and point the hint at the right lever.
   */
  httpStatus?: number | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId,
        action: BRIEFING_FAILURE_ACTION,
        details: JSON.stringify({
          dateKey: dateKey(),
          reason: args.reason,
          httpStatus: args.httpStatus ?? null,
          locale: args.locale ?? null,
          triedAt: new Date().toISOString(),
        }),
      },
    });
  } catch {
    // Marker is best-effort — never throw out of the failure path.
  }
}

export interface BriefingFailureState {
  triedAt: string;
  reason: string;
  /** v1.25.3 — coarse class for the empty-state hint (see classifyBriefingFailure). */
  failureClass: BriefingFailureClass;
}

/**
 * Read the latest briefing-failure marker for `userId`, but only when it is
 * newer than the last successful generation (`since`). Returns `null` when the
 * most recent attempt succeeded (or there is no marker at all), so the read
 * path can render a discreet "couldn't refresh" hint exactly when it applies.
 */
export async function readBriefingFailure(args: {
  userId: string;
  since: Date | null;
}): Promise<BriefingFailureState | null> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: BRIEFING_FAILURE_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latest) return null;
  // A failure older than (or equal to) the last successful generation has been
  // superseded — the surface is showing fresh text, not a held one.
  if (args.since && latest.createdAt <= args.since) return null;

  let reason = "unknown";
  let httpStatus: number | null = null;
  if (latest.details) {
    try {
      const parsed = JSON.parse(latest.details) as {
        reason?: unknown;
        httpStatus?: unknown;
      };
      if (typeof parsed.reason === "string") reason = parsed.reason;
      if (typeof parsed.httpStatus === "number") httpStatus = parsed.httpStatus;
    } catch {
      // Malformed marker payload — still report the failure, generic reason.
    }
  }
  return {
    triedAt: latest.createdAt.toISOString(),
    reason,
    failureClass: classifyBriefingFailure({ reason, httpStatus }),
  };
}
