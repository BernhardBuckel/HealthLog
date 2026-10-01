/**
 * Server-side read of a record's two unit preferences.
 *
 * Every text the server writes for a person to read — a status note, a period
 * narrative, a score label — quotes numbers, and a number is only right in the
 * unit its reader chose. This is the one read those producers share, so none
 * of them can load `unitPreference` and forget `glucoseUnit` or the reverse.
 */
import { prisma } from "@/lib/db";

import {
  DEFAULT_UNIT_PREFERENCES,
  resolveUnitPreferences,
  type UnitPreferences,
} from "./display-transform";

/** Both preferences of one record; the defaults when the row is gone. */
export async function loadUnitPreferences(
  userId: string,
): Promise<UnitPreferences> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { unitPreference: true, glucoseUnit: true },
  });
  return row ? resolveUnitPreferences(row) : DEFAULT_UNIT_PREFERENCES;
}
