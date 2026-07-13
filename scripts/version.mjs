#!/usr/bin/env node
// Normalize the versions of every shipped (public) workspace package to a single
// version, then bump that version by a patch (0.0.1). Internal @smithy-hono/*
// dependency ranges are normalized to match. Use --dry to preview.
//
//   node scripts/version.mjs          # normalize + patch bump, writes files
//   node scripts/version.mjs --dry    # print what would change, write nothing
//
// "Shipped" = workspace packages under packages/* that are not marked private.
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');

const files = globSync('packages/*/package.json', { cwd: root }).sort();
const pkgs = files
  .map((rel) => {
    const path = join(root, rel);
    return { path, rel, json: JSON.parse(readFileSync(path, 'utf8')) };
  })
  .filter((p) => !p.json.private);

if (pkgs.length === 0) {
  console.error('No public packages found under packages/*');
  process.exit(1);
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

// Normalize: pick the highest existing version as the common baseline.
const versions = [...new Set(pkgs.map((p) => p.json.version))];
const baseline = versions.sort(cmp).at(-1);
if (versions.length > 1) {
  console.log(`Found mixed versions: ${versions.join(', ')} -> normalizing to ${baseline}`);
}

// Bump patch by 1.
const [maj, min, pat] = baseline.split('.').map(Number);
const next = `${maj}.${min}.${pat + 1}`;
const names = new Set(pkgs.map((p) => p.json.name));

console.log(`Baseline ${baseline} -> bumping all shipped packages to ${next}\n`);

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

for (const p of pkgs) {
  const before = p.json.version;
  p.json.version = next;
  let depChanges = [];
  for (const key of DEP_KEYS) {
    const deps = p.json[key];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (!names.has(dep)) continue;
      const range = deps[dep];
      // Preserve the range operator (^, ~, or exact) and retarget to `next`.
      const op = range.match(/^[\^~]/)?.[0] ?? '';
      const updated = `${op}${next}`;
      if (updated !== range) {
        deps[dep] = updated;
        depChanges.push(`${dep} ${range} -> ${updated}`);
      }
    }
  }
  console.log(`  ${p.json.name}: ${before} -> ${next}`);
  for (const c of depChanges) console.log(`      dep: ${c}`);
  if (!dry) writeFileSync(p.path, JSON.stringify(p.json, null, 2) + '\n');
}

// Retarget consumer `file:` tarball specifiers that pin the packed-tarball
// filename, which embeds the package version (e.g. examples/*, deploy/*,
// typecheck/). These live OUTSIDE packages/*, so the loop above never sees them;
// without this they dangle at the old version after a bump and `npm install`
// ENOENTs the missing old tarball (which broke CI on the 0.1.1 -> 0.1.2 bump).
// Text-edit (not JSON rewrite) to preserve each consumer's formatting; the regex
// only touches file: tarball refs, so running it over every package.json is safe.
// (build.gradle.kts reads the version straight from a package.json, so the Gradle
// side stays in sync on its own — these file: refs were the other leak.)
const TARBALL_RE = /(file:[^"']*smithy-hono-[a-z-]+-)\d+\.\d+\.\d+(\.tgz)/g;
const allPkgFiles = globSync('**/package.json', {
  cwd: root,
  exclude: (p) => p.includes('node_modules'),
});

let consumerCount = 0;
for (const rel of allPkgFiles) {
  const path = join(root, rel);
  const text = readFileSync(path, 'utf8');
  const hits = [...text.matchAll(TARBALL_RE)].length;
  if (hits === 0) continue;
  const updated = text.replace(TARBALL_RE, `$1${next}$2`);
  if (updated === text) continue;
  consumerCount++;
  console.log(`  ${rel}: retargeted ${hits} file: tarball ref(s) -> ${next}`);
  if (!dry) writeFileSync(path, updated);
}

console.log(
  `\n${dry ? '[dry run] no files written' : `Wrote ${pkgs.length} package.json files`}` +
    (consumerCount ? ` (+${consumerCount} consumer file: ref${consumerCount > 1 ? 's' : ''})` : ''),
);
console.log(`\nNext version: ${next}  (tag: v${next})`);
