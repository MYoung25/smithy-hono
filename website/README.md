# smithy-hono documentation site

The public documentation site for smithy-hono, published to **Cloudflare Pages**
at **https://smithy-hono.com**.

It is a [Docusaurus v3](https://docusaurus.io) site. The content root is the
repo's `../docs` directory — **`docs/` stays the single source of truth**; this
`website/` folder is only the presentation shell (theme, landing page, deploy
config). A custom landing page (`src/pages/index.js`) owns `/`; the docs are
served under `/docs`.

## Local development

```bash
cd website
npm install      # first time
npm start        # dev server with hot reload at http://localhost:3000
npm run build    # production build into website/build (also link-checks: onBrokenLinks=throw)
npm run serve    # serve the built site locally
```

Edit documentation in `../docs/*.md`. Sidebar structure is driven by the
`_category_.json` files there.

## How it publishes

Publishing is fully handled by GitLab CI — the `docs-cloudflare` job in
`../.gitlab-ci.yml`:

- **Trigger:** automatically on pushes to `main` that change `website/**` or
  `docs/**`.
- **Gated on credentials:** the job's rule requires `$CLOUDFLARE_API_TOKEN`, so
  until the CI/CD variables below are set it simply does not run (it never
  reddens the pipeline).
- **What it does:** `npm ci` → `npm run build` → `wrangler pages deploy build`
  to the Cloudflare Pages project `smithy-hono` (production branch `main`).

`wrangler.toml` pins the project name and build output dir, so
`wrangler pages deploy` needs no flags.

## One-time setup (operator)

Do this once to wire up the Cloudflare side. After it's done, every push to
`main` deploys automatically.

1. **Zone:** make sure `smithy-hono.com` is an **active zone** on the target
   Cloudflare account (so Pages can auto-create the CNAME for the custom domain).

2. **API token:** create a Cloudflare API token scoped
   **Account → Cloudflare Pages: Edit**. To let the setup script also attach the
   custom domain, add **Zone → DNS: Edit** on the `smithy-hono.com` zone
   (otherwise attach the domain in the dashboard instead).

3. **GitLab CI/CD variables** (Settings → CI/CD → Variables), both **masked**
   and **protected**:
   - `CLOUDFLARE_API_TOKEN` — the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — the 32-hex account id (Cloudflare dashboard → any
     domain → Overview → API section, or `npx wrangler whoami`)

4. **Create the project + attach the domain** — run the helper locally:

   ```bash
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
     ./scripts/setup-cloudflare-pages.sh
   ```

   This idempotently creates the `smithy-hono` Pages project and attaches
   `smithy-hono.com` + `www.smithy-hono.com`. (Alternatively, create the project
   and add the custom domain by hand in **Workers & Pages → smithy-hono →
   Custom domains**.)

5. **First deploy:** push a change to `main` (or run `npm run deploy:cf` locally
   with the two env vars set).

## Manual deploy (optional)

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in your shell:

```bash
cd website
npm run deploy:cf     # = docusaurus build && wrangler pages deploy build
```
