/**
 * Boot check: does a pooled connection really run in UTC?
 *
 * HealthLog pins `TimeZone=UTC` on every connection it opens (see
 * `@/lib/db-session`). This reads the setting back on one pooled connection
 * and says so in the log when it is anything else: a pooler that drops the
 * startup options, a role or proxy that overrides the setting. The expiry
 * checks of passkey challenges, sessions and one-time links read the stored
 * UTC timestamps through that zone, so a mismatch shows up as "expired"
 * straight away. The check never throws and never stops the boot.
 */

const UTC_NAMES = /^(etc\/)?(utc|uct|universal|zulu)$/i;

export interface TimeZoneCheckClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export type TimeZoneCheckOutcome =
  | { state: "utc"; timeZone: string }
  | { state: "mismatch"; timeZone: string }
  | { state: "error"; message: string };

export function isUtcTimeZone(name: string): boolean {
  return UTC_NAMES.test(name.trim());
}

export async function checkSessionTimeZone(
  client: TimeZoneCheckClient,
): Promise<TimeZoneCheckOutcome> {
  try {
    const rows =
      await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
        "SHOW TimeZone",
      );
    const value = rows[0] ? Object.values(rows[0])[0] : undefined;
    const timeZone = typeof value === "string" ? value : String(value);
    return isUtcTimeZone(timeZone)
      ? { state: "utc", timeZone }
      : { state: "mismatch", timeZone };
  } catch (err) {
    return {
      state: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function timeZoneMismatchMessage(timeZone: string): string {
  return (
    `[boot] The database session runs in time zone "${timeZone}", not UTC. ` +
    "HealthLog stores times as UTC and pins every connection to UTC, but " +
    "something between the app and the database overrode it. Expiry checks " +
    "(passkey challenges, sessions, one-time links) will be off by the zone " +
    "offset. Fix: ALTER DATABASE <name> SET timezone TO 'UTC', and if a " +
    "connection pooler drops the startup options, set " +
    "DATABASE_SESSION_OPTIONS_DISABLED=true so the app pins the zone by " +
    "statement instead."
  );
}

/** Run the check and log the outcome. Resolves the outcome for tests. */
export async function runBootTimeZoneCheck(
  client: TimeZoneCheckClient,
): Promise<TimeZoneCheckOutcome> {
  const outcome = await checkSessionTimeZone(client);
  if (outcome.state === "mismatch") {
    console.warn(timeZoneMismatchMessage(outcome.timeZone));
  } else if (outcome.state === "error") {
    console.warn(
      `[boot] Database time zone check skipped: ${outcome.message.slice(0, 300)}`,
    );
  }
  return outcome;
}
