/**
 * Link a marker to its analyte for the unit conversion.
 *
 * The key is set when a marker is created and, for a marker that already
 * existed, the first time a reading needs it. It is never overwritten: a key a
 * person (or an earlier pass) set stands, and `updateMany` is gated on the
 * column still being null, so two concurrent writers converge. A marker whose
 * name matches no analyte keeps a null key and gets no conversion.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { matchAnalyteKey } from "./analyte-match";

export async function ensureAnalyteKey(
  client: Pick<PrismaClient, "biomarker">,
  marker: {
    id: string;
    name: string;
    unit: string;
    analyteKey?: string | null;
  },
): Promise<string | null> {
  if (marker.analyteKey) return marker.analyteKey;
  const key = matchAnalyteKey({ name: marker.name, unit: marker.unit });
  if (!key) return null;
  const { count } = await client.biomarker.updateMany({
    where: { id: marker.id, analyteKey: null },
    data: { analyteKey: key },
  });
  if (count > 0) return key;
  // Another writer set it first; read what stands.
  const current = await client.biomarker.findUnique({
    where: { id: marker.id },
    select: { analyteKey: true },
  });
  return current?.analyteKey ?? null;
}
