import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

const FEATURES = [
  {
    title: 'Codegen, not scaffolding',
    to: '/docs/authoring/codegen-plugin-guide',
    description: (
      <>
        A Smithy build plugin emits Hono routers, Zod schemas, typed error classes, and an
        operation-handler interface per <code>@http</code> resource. Your{' '}
        <code>src/routes/*.ts</code> satisfy the generated interfaces — and are never overwritten.
      </>
    ),
  },
  {
    title: 'Security pipeline built in',
    to: '/docs/consuming/security',
    description: (
      <>
        <code>@smithy-hono/security-core</code> runs before deserialization: OIDC cookie sessions,
        SH-HMAC service-to-service signing, CSRF, CORS, security headers, rate limiting, two-tier
        authorization, and audit — driven by generated operation metadata.
      </>
    ),
  },
  {
    title: 'Deploy anywhere web-standard',
    to: '/docs/reference/deployment-targets',
    description: (
      <>
        Runtime-agnostic adapters target Cloudflare Workers (KV + Durable Objects), AWS Lambda
        (DynamoDB), and Node/Redis + Postgres. One command ships a Worker to Cloudflare with{' '}
        <code>@smithy-hono/deploy-cf</code>.
      </>
    ),
  },
  {
    title: 'Typed clients, SSE & MCP',
    to: '/docs/reference/packages',
    description: (
      <>
        Get a typed client and a discriminated union of <code>@sseEvent</code> shapes for free.
        Expose the same service as an MCP server over Streamable-HTTP JSON-RPC with{' '}
        <code>@smithy-hono/mcp-core</code>.
      </>
    ),
  },
];

function Feature({ title, description, to }) {
  return (
    <div className={clsx('col col--6', styles.featureCol)}>
      <Link to={to} className={styles.card}>
        <h3 className={styles.cardTitle}>{title}</h3>
        <p className={styles.cardBody}>{description}</p>
      </Link>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <h2 className={styles.sectionTitle}>From model to production API</h2>
        <div className="row">
          {FEATURES.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
