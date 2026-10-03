import { z } from "zod/v4";

/**
 * The optional `clientTransport` field the web client sends on the browser
 * sign-in requests. Optional everywhere: a client that does not send it (the
 * iOS app, scripts) is never refused because of it. It can only ever cause a
 * refusal of its own request, so a forged value harms nobody but its sender.
 */
export const clientTransportSchema = z
  .object({
    protocol: z
      .enum(["http", "https"])
      .describe("The scheme of the page the request comes from."),
    host: z
      .string()
      .max(255)
      .describe("`location.host` of that page: hostname and optional port."),
  })
  .meta({
    id: "ClientTransport",
    description:
      "Sent by the web client only. When the server issues `Secure` session cookies and this says the page is on plain `http://` (and not a loopback host), the sign-in is refused with 409 `auth.session.insecure_transport` before any credential, ticket or code is checked or used, because the browser would drop the session cookie.",
  });
