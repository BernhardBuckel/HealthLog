/**
 * v1.42.2 — `sendsMedicationReminders` is the one reminder decision: the
 * worker and the admin check gate on it, the read paths publish it as
 * `remindersActive`. Pins the truth table and that every site calls it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sendsMedicationReminders } from "../auto-mark-taken";

describe("sendsMedicationReminders", () => {
  it("reminds only for an active, tracked, scheduled medication with reminders on and no auto-recording", () => {
    for (let bits = 0; bits < 32; bits++) {
      const med = {
        notificationsEnabled: (bits & 1) !== 0,
        autoMarkTaken: (bits & 2) !== 0,
        active: (bits & 4) !== 0,
        trackIntake: (bits & 8) !== 0,
        asNeeded: (bits & 16) !== 0,
      };
      expect(sendsMedicationReminders(med), JSON.stringify(med)).toBe(
        med.notificationsEnabled &&
          !med.autoMarkTaken &&
          med.active &&
          med.trackIntake &&
          !med.asNeeded,
      );
    }
  });

  it("is the decision at every gate and on every published DTO", () => {
    const src = (rel: string) =>
      readFileSync(join(process.cwd(), "src", rel), "utf8");
    for (const gate of [
      "lib/jobs/reminder/medication-reminder-check.ts",
      "app/api/admin/notifications/reminder-check/route.ts",
    ]) {
      expect(src(gate), gate).toMatch(/sendsMedicationReminders\(med\)/);
      // No send site falls back to the raw preference.
      expect(src(gate), gate).not.toMatch(
        /if \([^)]*med\.notificationsEnabled\)/,
      );
    }
    for (const dto of [
      "lib/medications/list-read.ts",
      "app/api/medications/[id]/route.ts",
    ]) {
      expect(src(dto), dto).toMatch(
        /remindersActive:\s*sendsMedicationReminders\(/,
      );
    }
  });
});
