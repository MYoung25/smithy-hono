# {{APP_NAME}}

A [smithy-hono](https://smithy-hono.com) application: a typed Hono API generated
from a Smithy model, deployable one-command to **{{DEPLOY_PKG}}**'s target.

## Layout

```
model/              Smithy model — the single source of truth (edit main.smithy)
  traits.smithy     vendored smithy-hono custom traits (do not edit)
src/
  generated/        codegen output — gitignored, run `npm run codegen` (never edit)
  createApp.ts      the DI app factory (composes the generated router)
  index.ts          local dev entry (Node, in-memory store, :3000)
  ...               the deploy entry (worker / server / lambda handler)
smithy-deploy*.mjs  deploy config consumed by `npm run deploy`
```

## Develop

```bash
npm install
npm run codegen          # Smithy → src/generated  (requires JDK 21 — the codegen plugin's traits are Java-21 classes)
npm run dev              # API on http://localhost:3000
```

Edit `model/main.smithy`, re-run `npm run codegen`, then implement/adjust
`src/createApp.ts`. Typecheck with `npm run typecheck`; test with `npm test`.

## Deploy

```bash
npm run deploy -- <your-domain>
```

See the deploy config (`smithy-deploy*.config.mjs`) for the target-specific
prerequisites (account/registry/cluster credentials, DNS delegation, and — for the
OIDC flavor — your IdP facts and secrets).
