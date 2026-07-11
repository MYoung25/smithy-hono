// Post-build generator for AI/LLM consumption. Runs after `docusaurus build`
// and writes into website/build/:
//   - llms.txt        curated markdown index of every doc (llmstxt.org convention)
//   - llms-full.txt   the entire docs corpus concatenated into one file
//   - docs/**/*.md    raw markdown mirror (each page fetchable as clean text at
//                     <page-url>.md, e.g. /docs/consuming/security.md)
//
// Zero dependencies — reads docs/ (the single source of truth) directly.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(scriptDir, '../../docs');
const BUILD_DIR = path.resolve(scriptDir, '../build');
const SITE = 'https://smithy-hono.com';
const DOCS_BASE = '/docs';
const TAGLINE =
  'Generate a secure, deployable Hono API server (routes, Zod, errors, SSE, MCP) from a Smithy model.';

/** Minimal YAML-frontmatter parser (flat key: value only). */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const data = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (mm) data[mm[1]] = mm[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, body };
}

/** First prose paragraph after the H1 — used as an index annotation. Joins
 *  hard-wrapped lines so the sentence isn't cut at an ~80-col wrap boundary. */
function firstProse(body) {
  const skip = (l) =>
    !l ||
    l.startsWith('#') ||
    l.startsWith('```') ||
    l.startsWith('|') ||
    l.startsWith('<') ||
    l.startsWith('- ') ||
    l.startsWith('>') ||
    l.startsWith(':::') ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(l);
  const para = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (para.length === 0) {
      if (skip(line)) continue;
      para.push(line);
    } else {
      if (!line || line.startsWith('```') || line.startsWith('|') || line.startsWith('#')) break;
      para.push(line);
    }
  }
  let t = para.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`_]/g, '');
  if (t.length > 200) t = t.slice(0, 197) + '…';
  return t;
}

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function sectionMeta(topDir) {
  if (!topDir) return { label: 'Overview', position: 0 };
  try {
    const cat = JSON.parse(await fs.readFile(path.join(DOCS_DIR, topDir, '_category_.json'), 'utf8'));
    return { label: cat.label || topDir, position: cat.position ?? 999 };
  } catch {
    return { label: topDir, position: 999 };
  }
}

async function main() {
  try {
    await fs.access(BUILD_DIR);
  } catch {
    throw new Error(`build dir not found at ${BUILD_DIR} — run \`docusaurus build\` first`);
  }

  const files = await walk(DOCS_DIR);
  const entries = [];
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const rel = path.relative(DOCS_DIR, file);
    const topDir = path.dirname(rel) === '.' ? '' : rel.split(path.sep)[0];
    const sec = await sectionMeta(topDir);
    const title = data.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(rel, '.md');
    entries.push({
      file,
      rel,
      body: body.trim(),
      title,
      desc: data.description || firstProse(body),
      section: sec.label,
      sectionPos: sec.position,
      docPos: Number(data.sidebar_position ?? 999),
      mdUrl: `${SITE}${DOCS_BASE}/${rel.split(path.sep).join('/')}`,
    });
  }

  entries.sort(
    (a, b) =>
      a.sectionPos - b.sectionPos || a.docPos - b.docPos || a.title.localeCompare(b.title),
  );

  // --- llms.txt (curated index) ---
  let llms = `# smithy-hono\n\n> ${TAGLINE}\n\n`;
  llms +=
    `This file follows the llmstxt.org convention. Each link points to the raw ` +
    `markdown of a docs page. For the entire documentation in one file, fetch ` +
    `${SITE}/llms-full.txt\n`;
  let section = null;
  for (const e of entries) {
    if (e.section !== section) {
      section = e.section;
      llms += `\n## ${section}\n\n`;
    }
    llms += `- [${e.title}](${e.mdUrl})${e.desc ? `: ${e.desc}` : ''}\n`;
  }

  // --- llms-full.txt (full corpus) ---
  const rule = '='.repeat(79);
  let full = `# smithy-hono — full documentation\n\n> ${TAGLINE}\n\n`;
  full += `Source: ${SITE}  •  ${entries.length} pages  •  generated from docs/\n`;
  for (const e of entries) {
    full += `\n\n${rule}\n# ${e.title}\nSource: ${e.mdUrl}\nSection: ${e.section}\n${rule}\n\n`;
    full += `${e.body}\n`;
  }

  // --- raw markdown mirror under build/docs/ ---
  for (const e of entries) {
    const dest = path.join(BUILD_DIR, 'docs', e.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(e.file, dest);
  }

  await fs.writeFile(path.join(BUILD_DIR, 'llms.txt'), llms);
  await fs.writeFile(path.join(BUILD_DIR, 'llms-full.txt'), full);

  console.log(
    `[llms] wrote llms.txt (${entries.length} pages), llms-full.txt (${(full.length / 1024).toFixed(
      0,
    )} KB), mirrored ${entries.length} raw .md files`,
  );
}

main().catch((err) => {
  console.error('[llms] generation failed:', err.message);
  process.exit(1);
});
