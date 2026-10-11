/**
 * Every collection a Google Health backfill walks, by the key its resume note
 * stores (`runGoogleHealthCollection`). The key type is what that function
 * accepts, so a collection added without an entry here does not compile, and
 * the backfill's slice ceiling (`GOOGLE_HEALTH_BACKFILL_MAX_SLICE`) is derived
 * from this list rather than counted by hand.
 */
export const GOOGLE_HEALTH_COLLECTION_KEYS = [
  "fetchSteps",
  "fetchDistance",
  "fetchActiveEnergy",
  "fetchFloors",
  "fetchVo2Max",
  "fetchWeight",
  "fetchBodyFat",
  "fetchSpo2",
  "fetchHrv",
  "fetchRhr",
  "fetchRespiratoryRate",
  "fetchHeartRate",
  "fetchBloodGlucose",
  "fetchCoreBodyTemperature",
  "fetchSleepTemperature",
  "fetchExercise",
  "sleep",
] as const;

export type GoogleHealthCollectionKey =
  (typeof GOOGLE_HEALTH_COLLECTION_KEYS)[number];
