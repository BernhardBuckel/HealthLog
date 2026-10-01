/**
 * Shared upper day bound for the nutrient write paths.
 *
 * `NutrientIntakeDay.day` is a local `YYYY-MM-DD` key, so the server cannot
 * simply compare it against the UTC date: a client in the most-ahead IANA zone
 * (UTC+14) is legitimately already on "tomorrow" relative to UTC. Two days of
 * slack covers every real zone and still rejects a key that cannot be a local
 * day at all.
 *
 * The batch route carried this bound privately while `POST /api/nutrients/water`
 * validated calendar realism only — so a manual write could land a `2999-01-01`
 * row, and since every read filters `day: { gte: since }` with no upper bound,
 * that row became the permanent `latestDay` on the settings card and the
 * permanent `lastSeenAt` on the dashboard water tile. Both routes now share
 * this one bound.
 */
export function maxAcceptableNutrientDay(now: Date): string {
  const limit = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: upper sanity bound with two days of slack for every real zone (see the doc comment)
  return limit.toISOString().slice(0, 10);
}
