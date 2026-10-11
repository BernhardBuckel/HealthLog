/**
 * v1.42.2 — whether a dose reminder may be sent for a medication.
 *
 * THE one definition. The reminder worker and the admin reminder check gate
 * every send on it, and the medication read paths publish its result as
 * `remindersActive`, so a client that arms local reminders reads the server's
 * decision instead of re-deriving it from the raw flags.
 *
 * A medication reminds only when the person wants reminders
 * (`notificationsEnabled`), it is active (not paused or ended), it has doses
 * that fall due (intake tracked, not as-needed), and its doses are not
 * recorded automatically (`autoMarkTaken`). The person's own reminder
 * preference stays stored untouched: switching auto-mark-taken off restores
 * whatever they had chosen.
 */
export interface ReminderGateMedication {
  notificationsEnabled: boolean;
  autoMarkTaken: boolean;
  active: boolean;
  trackIntake: boolean;
  asNeeded: boolean;
}

export function sendsMedicationReminders(
  medication: ReminderGateMedication,
): boolean {
  return (
    medication.notificationsEnabled &&
    !medication.autoMarkTaken &&
    medication.active &&
    medication.trackIntake &&
    !medication.asNeeded
  );
}
