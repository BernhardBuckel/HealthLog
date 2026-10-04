/**
 * The marker HealthLog's iOS app stamps on every HealthKit sample it writes
 * itself (a manual entry, or a Withings or import row it mirrors into Apple
 * Health). The sample also carries the HealthLog measurement id as
 * `HKExternalUUID`.
 *
 * Such a sample is already in the database under its own source. When the same
 * sample comes back through an Apple Health export it is a second copy of that
 * reading, so the export import leaves it out. This is the same predicate the
 * app's own sync filter uses, and a stable contract with the app.
 */
export const HEALTHLOG_ORIGIN_METADATA_KEY = "dev.healthlog.app.origin";
export const HEALTHLOG_ORIGIN_METADATA_VALUE = "healthlog";

/** Is this `<MetadataEntry>` the mark of a sample HealthLog wrote itself? */
export function isHealthLogOriginEntry(
  key: string | undefined,
  value: string | undefined,
): boolean {
  return (
    key === HEALTHLOG_ORIGIN_METADATA_KEY &&
    value === HEALTHLOG_ORIGIN_METADATA_VALUE
  );
}
