# `docs/` — internal reference + operator playbooks

The user-facing documentation lives at **<https://docs.healthlog.dev>** —
that's the canonical surface for self-hosting guides, integration
walkthroughs, AI-provider setup, and the doctor-report workflow.

The files in this directory are the internal operator playbooks, audit
notes, and machine-readable specs that ship alongside the source:

- [`api/`](./api/) — the OpenAPI 3.1 spec for the native-client subset
  (iOS DTO codegen target). See [`api/README.md`](./api/README.md) for
  the preview commands. Also home to the MCP-server contract:
  [`api/mcp-capabilities.md`](./api/mcp-capabilities.md) (tools,
  resources, prompts, write model) and
  [`api/mcp-skills.md`](./api/mcp-skills.md) (building a connector / skill).
- [`ops/`](./ops/) — operator runbooks: deploy, backup / restore,
  encryption-key rotation, password reset and account recovery, env
  checks, TLS pinning, data repair. These are what an operator reaches
  for during an incident.
- [`self-hosting/`](./self-hosting/) — horizontal-scaling notes
  (`HEALTHLOG_PROCESS_TYPE=web|worker|all`) and the deploy-pipeline
  recipe. Routine install steps stay on `docs.healthlog.dev`. Includes
  [`self-hosting/mcp.md`](./self-hosting/mcp.md) — enabling the
  off-by-default MCP connector and pointing Claude.ai / ChatGPT /
  Claude Desktop at it, and [`self-hosting/sso.md`](./self-hosting/sso.md)
  — OIDC SSO login: IdP setup, the identity-pinning security model,
  `OIDC_ONLY` consequences, and the break-glass runbook. Also
  [`self-hosting/geolite2.md`](./self-hosting/geolite2.md) — bringing your
  own offline GeoLite2 databases via `GEOLITE2_DIR` instead of sending
  login IPs to a third-party lookup. And
  [`self-hosting/account-sharing.md`](./self-hosting/account-sharing.md) —
  letting one account on the instance open another's health record: the
  three access levels, the eight sections a grant can be narrowed to,
  managed profiles for somebody with no login and the guardians who look
  after them, what revocation does and does not undo, and which trust
  properties of the instance are unchanged by any of it.
- [`using/`](./using/) — notes on using the app that sit close to the
  code. [`using/search.md`](./using/search.md) covers the command palette's
  record search: opening it, what it finds, how matching works, and its
  limits on very large and shared records.
- [`migration/`](./migration/) — migration notes. Currently only
  v1.3 to v1.4; later releases are covered by `CHANGELOG.md` and
  <https://docs.healthlog.dev>.
- [`integrations/`](./integrations/) — per-integration reference
  (Withings, Fitbit, Google Health, WHOOP, Apple Health, AI providers,
  data import).
- [`adr/`](./adr/) — architecture decision records.
- [`security/`](./security/) — threat-model notes.
- [`diagrams/`](./diagrams/) — architecture diagrams rendered through
  docs.healthlog.dev.
- [`releases/`](./releases/) — release imagery.
- [`apple-store-connect-checklist.md`](./apple-store-connect-checklist.md)
  — the iOS submission gate.
- [`codex-protocol-spec.md`](./codex-protocol-spec.md) — Codex / ChatGPT
  OAuth protocol reverse-engineering notes.
- [`ui-guidelines.md`](./ui-guidelines.md) — UI / a11y house style.

If you're a self-hoster looking to spin up an instance, start at
<https://docs.healthlog.dev> or jump to the [Quick Start in the project
README](../README.md#quick-start).
