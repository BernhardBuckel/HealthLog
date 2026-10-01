/**
 * GET /api/meta/capabilities
 *
 * Live capability / discovery surface for the native client. Returns the
 * server's REAL id vocabularies — derived-metric ids, vitals-baseline
 * types, insights layout tile-ids, metric-status ids, the HealthKit ingest
 * mapping, and the FHIR coding constants — plus the running API contract
 * version. The iOS app reads this once on launch (or on a version bump) and
 * gates its UI / decoder against what the server actually ships, retiring
 * the recurring "doc says N, server ships M" enum-drift class.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`). NOT admin — every
 * authenticated client may discover the contract.
 *
 * DESIGN RULE: every list is SOURCED from the existing canonical server
 * constant / Zod enum / registry — never hand-duplicated here. Adding a
 * derived metric, a tile, a writable source, or a HealthKit mapping
 * auto-updates this endpoint, so it cannot drift from the real registries.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

import packageJson from "../../../../../package.json";

import {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
} from "@/lib/insights/derived/registry";
import { INSIGHTS_TILE_IDS } from "@/lib/insights-layout";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";
import { WELLNESS_SCORE_TYPES } from "@/lib/insights/derived/wellness-scores";
import { WRITABLE_MEASUREMENT_SOURCES } from "@/lib/validations/measurement";
import {
  APPLE_HEALTH_TYPE_MAP,
  type AppleHealthMapping,
} from "@/lib/measurements/apple-health-mapping";
import {
  ATC_SYSTEM,
  SNOMED_SYSTEM,
  GERMAN_ATC_DEFAULT_LOCALES,
} from "@/lib/fhir/build-bundle";
import {
  FHIR_REST_RESOURCE_TYPES,
  FHIR_EVERYTHING_OPERATION,
  FHIR_SEARCH_PARAMS,
} from "@/lib/fhir/rest";
import { SHARE_LINK_MAX_DAYS } from "@/lib/validations/clinician-share-link";
import { ALL_LEAF_IDS, SHARE_GROUPS } from "@/lib/report-selection/catalogue";
import { RETIRED_ROUTES } from "@/lib/http/retired-routes";

export const dynamic = "force-dynamic";

/**
 * An EVENT-class HealthKit identifier carries a device-produced verdict, not
 * a continuous reading — it is marked by an `eventClassificationMap` or a
 * `fallbackClassification` in the ingest mapping. Everything else is a
 * quantity sample. Splitting the single mapping by this predicate keeps the
 * two ingest lists derived from one registry.
 */
function isEventMapping(m: AppleHealthMapping): boolean {
  return Boolean(m.eventClassificationMap || m.fallbackClassification);
}

export const GET = apiHandler(async () => {
  await requireAuth();
  annotate({ action: { name: "meta.capabilities.read" } });

  // Mirror the /api/version source so the contract version cannot drift from
  // the running build's reported version (build-arg env wins over the
  // package.json fallback for local dev).
  const apiContractVersion =
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version;

  const mappings = Object.values(APPLE_HEALTH_TYPE_MAP);

  const quantityTypes = mappings
    .filter((m) => !isEventMapping(m))
    .map((m) => ({
      type: m.measurementType,
      hk: m.hkIdentifier,
      unit: m.dbUnit,
    }));

  // Distinct event-class MeasurementTypes (several HK event identifiers can
  // share one MeasurementType, e.g. the audio-exposure pair).
  const eventTypes = Array.from(
    new Set(mappings.filter(isEventMapping).map((m) => m.measurementType)),
  );

  return apiSuccess({
    apiContractVersion,
    derivedMetricIds: DERIVED_METRIC_IDS,
    vitalsBaselineTypes: VITALS_BASELINE_TYPES,
    layoutTileIds: INSIGHTS_TILE_IDS,
    metricStatusIds: METRIC_STATUS_IDS,
    ingest: {
      quantityTypes,
      eventTypes,
      computedScores: Object.values(WELLNESS_SCORE_TYPES),
      writeAllowlist: WRITABLE_MEASUREMENT_SOURCES,
    },
    fhir: {
      atcSystem: ATC_SYSTEM,
      snomedRoute: SNOMED_SYSTEM,
      germanAtcDefaultLocales: GERMAN_ATC_DEFAULT_LOCALES,
      // Read-only REST face (v1.11): the resource types served, the
      // whole-record operation, the honoured search params and the narrow
      // Bearer scope. All sourced from the canonical `rest.ts` constants.
      restBaseUrl: "/api/fhir",
      // The face checks a narrow `fhir:read` scope, and NO code path mints a
      // token carrying it — every mint grants a wildcard (login, passkey,
      // refresh), the per-medication ingest pair (`medication:ingest` +
      // `medication:<id>:ingest`), `measurements:write`, `workouts:write`,
      // `documents:write`, or an MCP scope (`health:read`, `health:write`).
      // So the face is reachable by the owner's cookie session or a wildcard
      // device token, and by nothing else. It is reported that way rather than advertising a credential a
      // client cannot obtain.
      scopeMintable: false,
      resourceTypes: FHIR_REST_RESOURCE_TYPES,
      operations: [FHIR_EVERYTHING_OPERATION],
      searchParams: FHIR_SEARCH_PARAMS,
    },
    // Clinician share-link surface: a scoped, time-boxed, revocable read-only
    // link to the owner's record, sourced from the canonical share validation
    // and the selection catalogue.
    //
    // `reportDownload` replaces the old `fhirApi: false`, which described a
    // face that was never built. The record IS reachable in machine form now:
    // as a download under the token, behind the same unlock the page uses,
    // serving exactly the link's frozen selection. No bearer face, no new
    // scope — `/api/fhir/*` still refuses a share token.
    share: {
      supported: true,
      maxDays: SHARE_LINK_MAX_DAYS,
      reportDownload: ["fhir", "pdf"],
      selectionVersion: 2,
      // Each group carries its own member leaves, and the fenced tier carries
      // `sensitive: true` — the membership the panel, the PDF and the guard
      // tests already enforce, published so the native client can mirror the
      // fence instead of guessing which leaves it may bundle behind one
      // control. `leaves` stays the flat total set for back-compat.
      groups: SHARE_GROUPS,
      leaves: ALL_LEAF_IDS,
    },
    // Paths this server used to serve and no longer does. A capability that
    // disappears from the lists above is a signal a client can act on without
    // comparing versions; this is the same signal for the routes themselves,
    // and it arrives on the launch read rather than on the failing call. The
    // list is the same constant the proxy answers 410 from and the contract
    // publishes as gone, so a retirement cannot be announced here and not
    // honoured, or honoured and not announced.
    retiredRoutes: RETIRED_ROUTES,
  });
});
