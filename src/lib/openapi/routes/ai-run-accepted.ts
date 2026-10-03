/**
 * The request header and the 202 response every route that queues a
 * background document AI run shares (v1.40). See `./ai-runs.ts` for the poll.
 */
import { z } from "zod/v4";

import { dataEnvelope, errorEnvelope } from "./shared";

/** `Prefer: respond-async` on a route that offers the background path. */
export const preferRespondAsyncParameter = {
  name: "Prefer",
  in: "header" as const,
  required: false,
  schema: { type: "string" as const, example: "respond-async" },
  description:
    "Send `respond-async` (RFC 7240) to run the read in the background: the route answers 202 with a run id once every quick refusal has passed, and `GET /api/ai-runs/{id}` serves the result. Without it the route answers synchronously with the result, as it always has; that form is retained for clients that have not adopted runs, and its retirement will be announced one minor release ahead. A preference the route cannot apply is ignored and the response then carries no `Preference-Applied`.",
};

const acceptedBody = z
  .object({
    runId: z.string(),
    status: z.literal("QUEUED"),
    pollAfterMs: z
      .number()
      .int()
      .describe("How long to wait before the first poll."),
  })
  .meta({
    id: "AiRunAccepted",
    description:
      "The read was queued. Poll `GET /api/ai-runs/{runId}`. A second request for the same document while a read of it is still queued or running answers with that run instead of starting another.",
  });

const acceptedHeaders = z.object({
  "Preference-Applied": z.literal("respond-async").meta({
    description: "The route honoured `Prefer: respond-async`.",
  }),
  Location: z.string().meta({ description: "The run's poll address." }),
});

/** The 202 a queuing route answers with. */
export const aiRunAccepted = {
  "202": {
    description:
      "Queued for the background worker. Every refusal the route can answer quickly (capability, provider, rate limit, budget, validation) has already been answered; anything that goes wrong from here is reported on the run.",
    content: {
      "application/json": {
        schema: dataEnvelope(acceptedBody, "AiRunAcceptedEnvelope"),
      },
    },
    headers: acceptedHeaders,
  },
  "503": {
    description:
      "`aiRuns.workerUnavailable`: the run could not be handed to the background worker. Nothing was read and nothing was charged; try again.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};
