/**
 * @fileoverview Aggregates the project-local `healthlog/*` ESLint rules
 * into a single plugin object for the flat config.
 *
 *   - `queryKey-factory`     — bare-array queryKey / mutationKey bypass guard.
 *   - `safe-fetch-required`  — outbound fetch must route through safeFetch.
 *   - `api-fetch-required`   — client /api/ calls must route through apiFetch.
 *   - `no-raw-palette-color` — ban raw Tailwind palette utilities in app UI.
 *   - `spacing-scale`        — no pt-/pb- overrides on gap-based Card slots,
 *                              and no off-scale `5` step on a bg-card shell.
 *   - `job-handler-outcome`  — pg-boss bindings route through createAndWork,
 *                              whose handler returns a JobOutcome.
 *   - `no-default-zone-literal` — the default zone is DEFAULT_TIMEZONE from
 *                              src/lib/tz/format, never written out.
 *   - `no-utc-day-key`       — a day is cut through the tz module, not by
 *                              slicing an ISO string or parsing UTC midnight.
 */

"use strict";

const queryKeyFactory = require("./queryKey-factory.js");
const safeFetchRequired = require("./safe-fetch-required.js");
const apiFetchRequired = require("./api-fetch-required.js");
const noRawPaletteColor = require("./no-raw-palette-color.js");
const spacingScale = require("./spacing-scale.js");
const jobHandlerOutcome = require("./job-handler-outcome.js");
const noDefaultZoneLiteral = require("./no-default-zone-literal.js");
const noUtcDayKey = require("./no-utc-day-key.js");

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactory.rules["queryKey-factory"],
    "safe-fetch-required": safeFetchRequired,
    "api-fetch-required": apiFetchRequired,
    "no-raw-palette-color": noRawPaletteColor,
    "spacing-scale": spacingScale,
    // Same module as `no-raw-palette-color`, registered under a second
    // name so the flat config can run the `dracula` check as its own
    // named rule (now error-level too; the staged warn phase ended with
    // the semantic sweep). See the rule header.
    "no-dracula-utility": noRawPaletteColor,
    "job-handler-outcome": jobHandlerOutcome,
    "no-default-zone-literal": noDefaultZoneLiteral,
    "no-utc-day-key": noUtcDayKey,
  },
};
