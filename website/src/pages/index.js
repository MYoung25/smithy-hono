import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import styles from './index.module.css';

const MODEL_SAMPLE = `@http(method: "POST", uri: "/tasks")
operation CreateTask {
  input: CreateTaskInput
  output: Task
  errors: [ValidationError]
}`;

const APP_SAMPLE = `import { createTaskServiceRouter } from './generated/task.gen';
import { ops } from './routes/tasks';

// Zod validation, typed errors, auth metadata — all generated.
app.route('/', createTaskServiceRouter(ops));`;

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.hero)}>
      <div className={clsx('container', styles.heroInner)}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Smithy · Hono · TypeScript</span>
          <h1 className={styles.heroTitle}>{siteConfig.title}</h1>
          <p className={styles.heroTagline}>{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link className="button button--primary button--lg" to="/docs/getting-started/quickstart">
              Get started →
            </Link>
            <Link className="button button--secondary button--lg" to="/docs/">
              Read the docs
            </Link>
          </div>
        </div>
        <div className={styles.heroCode}>
          <div className={styles.codeLabel}>model/main.smithy</div>
          <CodeBlock language="java">{MODEL_SAMPLE}</CodeBlock>
          <div className={styles.codeArrow}>▼ ./gradlew smithyBuild</div>
          <div className={styles.codeLabel}>src/app.ts</div>
          <CodeBlock language="ts">{APP_SAMPLE}</CodeBlock>
        </div>
      </div>
    </header>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — Smithy → Hono codegen`}
      description="Generate a secure, deployable Hono API server (routes, Zod, typed errors, SSE, MCP) from a Smithy model.">
      <Hero />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
