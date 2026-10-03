/**
 * OpenAPI route table — the liveness/readiness probe.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * `/api/health` is the one route in the document that does NOT speak the
 * `{ data, error }` envelope: it answers a bare object, because the compose
 * healthcheck and every uptime monitor in front of a self-hosted instance
 * read `status` directly. It is also the one route on the public-path
 * allowlist in `src/proxy.ts` that a worker-only process still serves, so a
 * deployment with no web role can still be probed.
 *
 * The response is not one shape but two, and which one a caller gets depends
 * on who is asking — an authenticated ADMIN cookie session gets the component
 * detail, everybody else gets the single word. That is deliberate (the detail
 * names the database and worker state) and it is why the 200 below documents
 * a union rather than a single object.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

const healthStatusEnum = z.enum(["ok", "degraded"]).meta({
  id: "HealthStatus",
  description:
    "`ok` when the database answers AND every role this process runs holds up: the pg-boss producer is bound when the process serves web, and the worker loop is running when the process runs the worker. `degraded` on any of those failing.",
});

const healthReason = z.enum(["encryption_key_mismatch"]).optional().meta({
  id: "HealthReason",
  description:
    "Present only when the process refuses to serve for a reason a person has to fix. `encryption_key_mismatch`: the configured encryption key cannot open the data in this database (checked at boot). Every other route then answers 503 with `meta.errorCode` `encryption.key_mismatch`, and background jobs are not started. Fix: restore the original key, point the server at the matching database, or start with an empty one; then restart.",
});

const healthPublicResponse = z
  .object({ status: healthStatusEnum, reason: healthReason })
  .meta({
    id: "HealthPublicResponse",
    description:
      "What an unauthenticated (or non-admin) caller sees: the aggregate verdict and nothing else. No component detail, so an uptime probe cannot be used to fingerprint which part of a self-hosted instance is unwell.",
  });

const healthAdminResponse = z
  .object({
    status: healthStatusEnum,
    reason: healthReason,
    timestamp: z.iso
      .datetime({ offset: true })
      .describe("When the probe ran. UTC (`Z`) — no user context is loaded."),
    database: z
      .enum(["connected", "disconnected"])
      .describe("Result of a `SELECT 1` round-trip."),
    worker: z
      .enum(["running", "stopped"])
      .describe(
        "The in-process pg-boss worker loop. Reported for every process, including one that does not run the worker role — a web-only process reads `stopped` here and can still be `ok`.",
      ),
    workerLastHeartbeat: z.iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Last worker heartbeat. Absent when the worker has never beaten in this process.",
      ),
  })
  .meta({
    id: "HealthAdminResponse",
    description:
      "The component breakdown, returned ONLY to a caller whose cookie session resolves to an ADMIN. A Bearer token never reaches this arm: the route resolves the session directly through `getSession()`, which reads the cookie.",
  });

export const healthPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/health": {
    get: {
      // No credential: this operation is reachable before one exists.
      // The document-level default offers the Bearer token and the session
      // cookie as alternatives; an empty array is how OpenAPI says neither
      // is required. The list of paths allowed to say it lives in
      // `openapi-security-declaration-guard.test.ts`.
      security: [],
      tags: ["Meta"],
      summary: "Liveness / readiness probe",
      description:
        "Reports whether this process can serve. Public — it is on the proxy's allowlist and needs no credential, which is what lets `docker compose` and an external monitor use it. It is also the ONLY path a worker-only process answers; every other route on such a process is refused.\n\nThe body is a BARE object, not the `{ data, error }` envelope every other route returns. Do not run it through the envelope decoder.\n\nThe status code carries the verdict as well as the body: 200 for `ok`, 503 for `degraded`. Probe on the code; the body is for a human reading the response.\n\nAn ADMIN cookie session gets the component breakdown (`database`, `worker`, `timestamp`); everybody else gets `{ status }` alone. `Cache-Control: no-store, no-cache, must-revalidate` on both arms.",
      responses: {
        "200": {
          description:
            'Healthy. `{ status: "ok" }`, plus the component breakdown when the caller is an admin.',
          content: {
            "application/json": {
              schema: z.union([healthAdminResponse, healthPublicResponse]),
            },
          },
        },
        "503": {
          description:
            "Degraded — the database did not answer, or a role this process runs is not up. Same body shape as the 200, with `status: \"degraded\"`. A restart loop reports this rather than failing to answer, so a monitor can tell 'starting' from 'gone'.",
          content: {
            "application/json": {
              schema: z.union([healthAdminResponse, healthPublicResponse]),
            },
          },
        },
      },
    },
  },
};
