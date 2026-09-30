/**
 * The Bearer scope for pushing workouts in from another system (#1054): a
 * watch vendor's bridge, a script replaying an export.
 *
 * A zero-import leaf for the reason `MEASUREMENTS_WRITE_SCOPE` is one (see
 * `@/lib/measurements/scopes`): the mint route, the batch route, the settings
 * card and the guards all read it, and none of them should inherit an import
 * graph for a string.
 *
 * Its own scope rather than a second door for `measurements:write`. A token
 * someone already pasted into a scale's uploader should not quietly start
 * accepting workouts because a later release widened what the name means; a
 * scope grants what it names, and a bridge that sends both mints both.
 *
 * Deliberately alone. There is no read counterpart and must not be one: the
 * workout list and detail stay cookie-equivalent, so a credential pasted into
 * a bridge can add a session and learn nothing about the ones already stored.
 */

/** The scope a narrow token must carry to write workouts. */
export const WORKOUTS_WRITE_SCOPE = "workouts:write";
