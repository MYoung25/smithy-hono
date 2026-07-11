---
id: deployment-targets
title: Deployment targets
sidebar_label: Deployment targets
sidebar_position: 3
---

# Deployment targets

The repo ships reference deployments under `deploy/`. Their READMEs hold the exact
manifests and stay in place — this page links out to them. For the platform
matrix and the store/secret wiring each needs, see
[Deploying](../consuming/deployment.md).

| Target | Runtime | Data store | README |
|---|---|---|---|
| Node / k8s | Node + `@hono/node-server` | Redis (or Postgres) | deploy/node |
| Cloudflare (secured) | Workers (Paid — uses Durable Objects) | — | deploy/cf |
| Cloudflare CRUD (full-stack) | Workers (free plan) | Cloudflare D1 | deploy/cf-crud |
| AWS Lambda | Lambda + CDK + `hono/aws-lambda` | DynamoDB | deploy/aws |
