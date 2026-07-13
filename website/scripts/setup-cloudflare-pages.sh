#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-time (idempotent) Cloudflare Pages setup for the smithy-hono docs site.
#
# Creates the Pages project and attaches the custom domain(s). Safe to re-run:
# "already exists" responses are treated as success.
#
# Prerequisites:
#   - CLOUDFLARE_API_TOKEN  scope: Account -> Cloudflare Pages: Edit
#                           (to also attach the domain the token additionally
#                            needs Zone -> DNS: Edit on the smithy-hono.com zone)
#   - CLOUDFLARE_ACCOUNT_ID the 32-hex account id
#   - smithy-hono.com is already an ACTIVE zone on the same Cloudflare account
#     (Pages then auto-creates the CNAME for the custom domain).
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/setup-cloudflare-pages.sh
#
# After this runs once, GitLab CI's `docs-cloudflare` job publishes new builds
# automatically on every push to main that touches website/** or docs/**.
# ---------------------------------------------------------------------------
set -euo pipefail

PROJECT="${PAGES_PROJECT:-smithy-hono}"
PRODUCTION_BRANCH="${PAGES_PRODUCTION_BRANCH:-main}"
DOMAINS="${PAGES_DOMAINS:-smithy-hono.com www.smithy-hono.com}"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (scope: Cloudflare Pages: Edit)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (32-hex account id)}"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

cd "$(dirname "$0")/.."

echo "==> Ensuring Pages project '${PROJECT}' (production branch: ${PRODUCTION_BRANCH})"
if npx --yes wrangler pages project create "${PROJECT}" \
      --production-branch="${PRODUCTION_BRANCH}" 2>/tmp/wrangler-create.log; then
  echo "    created."
else
  if grep -qiE "already exists|8000007" /tmp/wrangler-create.log; then
    echo "    already exists — ok."
  else
    cat /tmp/wrangler-create.log >&2
    echo "!! failed to create project" >&2
    exit 1
  fi
fi

for domain in ${DOMAINS}; do
  echo "==> Attaching custom domain '${domain}'"
  resp="$(curl -sS -X POST "${API}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PROJECT}/domains" \
      "${AUTH[@]}" --data "{\"name\":\"${domain}\"}")"
  if echo "${resp}" | grep -q '"success":true'; then
    echo "    attached."
  elif echo "${resp}" | grep -qiE "already|exists|8000030|8000031"; then
    echo "    already attached — ok."
  else
    echo "    response: ${resp}" >&2
    echo "!! could not attach ${domain} (attach it in the dashboard: Workers & Pages -> ${PROJECT} -> Custom domains)" >&2
  fi
done

echo
echo "Done. Trigger the first deploy by pushing to '${PRODUCTION_BRANCH}',"
echo "or deploy from here:  cd website && npm run deploy:cf"
