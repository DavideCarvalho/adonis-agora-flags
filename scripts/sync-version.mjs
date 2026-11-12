#!/usr/bin/env node
/**
 * Rewrites the `export const VERSION = '...'` literal in each package's
 * `src/index.ts` so it matches that package's `version` in package.json.
 *
 * Why: packages are built with plain `tsc` (no version injection), so the
 * exported VERSION is whatever is hard-coded in source. `changeset version`
 * bumps package.json but leaves the source literal stale, shipping a wrong
 * VERSION in dist. This script is chained after `changeset version` to keep
 * the literal in lockstep with every release bump. It is idempotent and only
 * touches packages whose index.ts(x) actually declares a VERSION const.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

// Matches: export const VERSION = '...' | "..." (keeps quote style + trailing `;`)
const VERSION_RE = /(export const VERSION\s*=\s*)(['"])(.*?)\2/;

const check = process.argv.includes('--check');

let changed = 0;
let checked = 0;
const mismatches = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgDir = join(packagesDir, entry.name);
  const pkgJsonPath = join(pkgDir, 'package.json');
  // React packages keep their entry in index.tsx.
  const indexPath = ['index.ts', 'index.tsx']
    .map((file) => join(pkgDir, 'src', file))
    .find((path) => existsSync(path));
  if (!existsSync(pkgJsonPath) || !indexPath) continue;

  const { name, version } = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const source = readFileSync(indexPath, 'utf8');
  const match = source.match(VERSION_RE);
  if (!match) continue; // package does not export a VERSION const — skip

  checked++;
  const current = match[3];
  if (current === version) continue;

  if (check) {
    mismatches.push(`  ${name}: VERSION='${current}' but package.json is '${version}'`);
    continue;
  }

  const next = source.replace(VERSION_RE, `$1$2${version}$2`);
  writeFileSync(indexPath, next);
  changed++;
  console.log(`synced VERSION for ${name}: ${current} -> ${version}`);
}

if (check && mismatches.length > 0) {
  console.error(
    `Exported VERSION const out of sync in ${mismatches.length} package(s):\n${mismatches.join(
      '\n',
    )}\nRun \`node scripts/sync-version.mjs\` and commit.`,
  );
  process.exit(1);
}

if (changed === 0) {
  console.log(`VERSION const in sync across ${checked} package(s).`);
}
