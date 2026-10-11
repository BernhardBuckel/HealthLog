/**
 * Session settings shared by every Postgres connection HealthLog opens: the
 * Prisma pool, pg-boss's pool and the dedicated lock and maintenance clients.
 * Kept apart from `db.ts` so a side connection can use them without loading
 * the Prisma client.
 */
import type { Pool, PoolClient } from "pg";

/**
 * Whether the app may send the libpq `options` startup parameter at all.
 *
 * PgBouncer refuses a connection that carries a startup parameter it does not
 * know (`unsupported startup parameter: options`) unless the operator lists
 * it in `ignore_startup_parameters`. Up to v1.41 such a host could set the
 * statement timeout to 0, which dropped the whole string; v1.42 always sends
 * `work_mem`, so that no longer worked. `DATABASE_SESSION_OPTIONS_DISABLED`
 * (1, true or yes) sends none of the session settings; the pooler or the
 * database's own defaults then apply.
 */
export function sessionOptionsDisabled(): boolean {
  const raw = process.env.DATABASE_SESSION_OPTIONS_DISABLED?.trim();
  return raw !== undefined && /^(1|true|yes)$/i.test(raw);
}

/**
 * The session time zone every connection HealthLog opens runs in.
 *
 * Almost every `DateTime` column is `timestamp(3)` WITHOUT time zone and
 * holds UTC. Postgres converts between that type and `now()` /
 * `CURRENT_TIMESTAMP` / `timestamptz` through the session time zone, and the
 * driver sends a `Date` parameter as an offset-free UTC string that a
 * `timestamptz` column reads in the session time zone. On a database whose
 * default is anything but UTC (a shared instance set to Europe/Berlin, say)
 * every expiry check then ran hours off, a passkey challenge expired before
 * the prompt closed, and `timestamptz` writes landed shifted. Pinning the
 * session removes the dependence for every query at once, whatever the
 * database or role default says.
 */
export const SESSION_TIME_ZONE = "UTC";

export const TIME_ZONE_OPTION = `-c TimeZone=${SESSION_TIME_ZONE}`;

/**
 * The statement that pins the time zone where the startup `options` cannot
 * be sent (`DATABASE_SESSION_OPTIONS_DISABLED`, a connection pooler).
 * PgBouncer tracks `TimeZone` per client and replays it onto whichever server
 * connection serves the next transaction, so a `SET` on connect holds in
 * transaction pooling too.
 */
export const SET_SESSION_TIME_ZONE = `SET TIME ZONE '${SESSION_TIME_ZONE}'`;

/** The startup option alone, for the side connections (pg-boss, locks). */
export function timeZoneSessionOptions(): string | undefined {
  return sessionOptionsDisabled() ? undefined : TIME_ZONE_OPTION;
}

/**
 * Pin the time zone on every new connection of `pool` by statement, when the
 * startup options are off. pg queues the statement ahead of the first query
 * the new client is handed out for, so no query runs before it.
 */
export function pinTimeZoneOnConnect(pool: Pool): void {
  if (!sessionOptionsDisabled()) return;
  pool.on("connect", (client: PoolClient) => {
    client.query(SET_SESSION_TIME_ZONE).catch((err: unknown) => {
      console.error("[db] Could not pin the session time zone:", err);
    });
  });
}
