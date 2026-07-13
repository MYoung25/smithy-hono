---
id: examples
title: Examples
sidebar_label: Examples
sidebar_position: 4
---

# Examples

Worked reference apps live under `examples/` in the repo — they are the gold
implementations. READMEs (where present) stay in place; this page links out to
them, otherwise to the example directory.

| Example | Shows | Source / README |
|---|---|---|
| todo-api | Hand-written operation handlers + the full security pipeline, in **memory** and **Redis** variants; MCP as an OAuth resource server. | README |
| secure-api | OIDC cookie sessions, S2S HMAC import, owner-scoped resource authorization, fail-fast config validation. | README |
| crud-api | Zero-handler `@persisted` CRUD over a `DataStore`, live MCP mount + stdio transport. No security pipeline. | examples/crud-api |
| crud-ui | Vite browser front-end driving the generated typed client against `crud-api`. | examples/crud-ui |
