import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { MEDICATION_CATEGORY_VALUES } from "@/lib/validations/medication";

const MEDICATION_CATEGORIES = MEDICATION_CATEGORY_VALUES;

export type MedicationCategory = (typeof MEDICATION_CATEGORIES)[number];

const DEFAULT_CATEGORY: MedicationCategory = "OTHER";

/**
 * The client surface the helpers below need. The default is the shared
 * client; the backup builder and the restore pass their own (the restore's
 * transaction client, so a category row lands in the same transaction as
 * the medication it points at and its foreign key can see that row).
 */
type CategoryClient = Pick<
  Prisma.TransactionClient,
  "medicationCategoryAssignment"
>;

function normalizeCategory(input: unknown): MedicationCategory {
  if (typeof input !== "string") return DEFAULT_CATEGORY;
  return MEDICATION_CATEGORIES.includes(input as MedicationCategory)
    ? (input as MedicationCategory)
    : DEFAULT_CATEGORY;
}

export async function getMedicationCategories(
  medicationIds: string[],
  client: CategoryClient = prisma,
): Promise<Record<string, MedicationCategory>> {
  if (medicationIds.length === 0) return {};

  const rows = await client.medicationCategoryAssignment.findMany({
    where: { medicationId: { in: medicationIds } },
    select: { medicationId: true, category: true },
  });

  const map: Record<string, MedicationCategory> = {};
  for (const id of medicationIds) {
    map[id] = DEFAULT_CATEGORY;
  }
  for (const row of rows) {
    map[row.medicationId] = normalizeCategory(row.category);
  }
  return map;
}

export async function setMedicationCategory(
  medicationId: string,
  category: unknown,
  client: CategoryClient = prisma,
) {
  const normalized = normalizeCategory(category);

  await client.medicationCategoryAssignment.upsert({
    where: { medicationId },
    create: { medicationId, category: normalized },
    update: { category: normalized },
  });

  return normalized;
}

export async function deleteMedicationCategory(
  medicationId: string,
  client: CategoryClient = prisma,
) {
  await client.medicationCategoryAssignment.deleteMany({
    where: { medicationId },
  });
}
