/**
 * One full-history import per account and kind at a time, across processes.
 *
 * The admission queue runs one import at a time (`groupConcurrency: 1`), but
 * pg-boss only holds that line while the job is inside its expiry. Once the
 * expiry passes, pg-boss fails the job, fires its abort signal, frees the
 * worker slot and the group slot, and retries the job after its retry delay.
 * It does not stop the handler. Measured against pg-boss 12.34
 * (`tests/integration/integration-backfill-lane-expiry.test.ts`): a handler
 * that ignores the signal was still running when the retry of the same job
 * started beside it in the same worker, so the lane's "one at a time" did not
 * hold for the one case it exists for, an import too long for its expiry.
 *
 * So each run holds a session-level advisory lock keyed on the job's identity
 * (kind, provider where there is one, account) for as long as it runs. A
 * delivery that finds the lock taken does no work: the run that holds it is
 * still importing, and it either stamps its completion marker or leaves the
 * account for the next boot's discovery. The lock lives on a connection of its
 * own, outside the Prisma pool, because a session lock has to stay on one
 * connection for the whole run and a pooled one is handed back between
 * statements. Ending the connection releases the lock, and so does the
 * process dying, so a crash never leaves an account locked.
 *
 * One extra connection per running import; the lane admits one import per
 * process at a time, so that is one connection.
 */
import { Client } from "pg";

/** The lock key for one admission job's identity. */
function integrationBackfillLockKey(identity: string): string {
  return `integration-backfill:${identity}`;
}

/** What a guarded run came to. */
type GuardedRun<T> = { ran: true; result: T } | { ran: false };

/**
 * Run `run` while holding the import lock for `identity`. Resolves
 * `{ ran: false }` at once, without calling `run`, when another run holds it.
 * Rejects exactly as `run` does otherwise.
 */
export async function withIntegrationBackfillLock<T>(
  identity: string,
  run: () => Promise<T>,
  connectionString: string | undefined = process.env.DATABASE_URL,
): Promise<GuardedRun<T>> {
  const client = new Client({ connectionString, keepAlive: true });
  // An idle client whose server goes away emits `error`; unhandled, that
  // takes the whole worker down. The run itself notices the database is
  // gone through its own queries.
  client.on("error", () => {});
  await client.connect();
  try {
    const key = integrationBackfillLockKey(identity);
    const { rows } = await client.query<{ held: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
      [key],
    );
    if (!rows[0]?.held) return { ran: false };
    try {
      return { ran: true, result: await run() };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}
