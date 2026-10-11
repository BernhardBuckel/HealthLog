/**
 * v1.42.2 — "record doses automatically" (`Medication.autoMarkTaken`).
 *
 * A medication with the option on has every scheduled dose recorded as taken
 * by the `intake-auto-take` job once its time has passed. There is nothing to
 * remind about, so every reminder path asks {@link sendsMedicationReminders}
 * instead of reading `notificationsEnabled` alone. The person's own reminder
 * preference stays stored untouched: switching the option off restores
 * whatever they had chosen.
 */

/**
 * True when a dose reminder may be sent for this medication: reminders are
 * switched on and its doses are not recorded automatically.
 */
export function sendsMedicationReminders(medication: {
  notificationsEnabled: boolean;
  autoMarkTaken: boolean;
}): boolean {
  return medication.notificationsEnabled && !medication.autoMarkTaken;
}
