#!/usr/bin/env node
/* global console, process, URL */
// Local-only initial-JS measurement. No production accounts or services.
/**
 * Reproducible initial-JS measurement for the FixFlow web app.
 *
 * Scope (exactly what is measured): the JS files DIRECTLY referenced by
 * the built `dist/index.html` — the entry `<script type="module">` plus
 * the `<link rel="modulepreload">` assets. That is the reviewer's
 * definition: six direct initial script/modulepreload assets in the
 * Phase 7 build (index, rolldown-runtime, vendor-react, i18n, client
 * and the router chunk). Lazy-route chunks, CSS, images, the manifest
 * and network overhead (HTTP headers, TLS, compression negotiation)
 * are NOT counted. Each asset is summed in raw bytes and in bytes
 * after gzip level 9 (matching the reviewer's "default Python gzip
 * settings": Python's gzip.compress defaults to compresslevel 9).
 *
 * Usage:
 *   node scripts/measure-initial-js.mjs [--web-root apps/web] [--dist apps/web/dist] [--json] [--no-build]
 * - Builds the web app first when dist/index.html is absent (unless
 *   --no-build is given); pass an existing dist to measure it as-is.
 * - Prints a table + totals to stdout and writes
 *   <dist>/initial-js-report.json (unless --json, which prints the
 *   JSON to stdout instead of the table and does not write the file).
 *
 * Reproduction check (reviewed Phase 7 tree, 2026-11-24):
 *   total 464,167 bytes / 149,373 bytes gzipped (level 9).
 * If the script does not reproduce those numbers on the reviewed
 * tree, the scope or the gzip settings have drifted — fix the script,
 * not the numbers.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const webRoot = resolve(repoRoot, flagValue('--web-root', 'apps/web'));
const distDir = resolve(repoRoot, flagValue('--dist', join(webRoot, 'dist')));
const asJson = args.includes('--json');
const noBuild = args.includes('--no-build');

const indexHtml = join(distDir, 'index.html');
if (!existsSync(indexHtml)) {
  if (noBuild) {
    console.error(`No dist/index.html at ${indexHtml}; run the web build first.`);
    process.exit(1);
  }
  console.log(`No dist at ${distDir}; building the web app first…`);
  execSync('npm run build --workspace=@fixflow/web', { stdio: 'inherit', cwd: repoRoot });
}
if (!existsSync(indexHtml)) {
  console.error(`Still no dist/index.html at ${indexHtml} after building.`);
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
// Deduplicate while keeping document order (the entry script plus
// modulepreload links; a file listed twice is downloaded once).
const seen = new Set();
const files = [];
for (const p of assetPaths) {
  const file = p.replace(/^\/+/, '');
  if (seen.has(file)) continue;
  seen.add(file);
  const full = join(distDir, file);
  if (!existsSync(full)) {
    console.error(`Referenced asset missing from dist: ${file}`);
    process.exit(1);
  }
  files.push({ file, full, data: readFileSync(full) });
}

// Gzip level 9. The reviewer's numbers were produced with Python's
// gzip.compress (level 9), so prefer Python when it is available:
// Node's bundled zlib (1.3.2.1-motley here) compresses the same
// assets 368 bytes larger in total (149,741 vs 149,373 on the
// reviewed tree) — same algorithm, different zlib build. Fall back
// to Node zlib and say so in the report when Python is absent.
let gzipBytesByFile = null;
let gzipEngine = 'python-gzip-level9';
try {
  const out = execFileSync(
    'python3',
    [
      '-c',
      'import gzip, json, sys\n' +
        'print(json.dumps({p: len(gzip.compress(open(p, "rb").read(), compresslevel=9)) for p in sys.argv[1:]}))',
      ...files.map((f) => f.full),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  gzipBytesByFile = JSON.parse(out);
} catch {
  gzipEngine = 'node-zlib-level9 (fallback; ~0.25% larger than Python gzip on this tree)';
}
const assets = files.map((f) => ({
  file: f.file,
  bytes: f.data.length,
  gzipBytes: gzipBytesByFile?.[f.full] ?? gzipSync(f.data, { level: 9 }).length,
}));

const report = {
  generatedAt: new Date().toISOString(),
  scope:
    'JS files directly referenced by dist/index.html (entry script + modulepreload links). ' +
    'Lazy-route chunks, CSS, images, manifest and network overhead are NOT counted. ' +
    'Gzip is level 9 (Python gzip.compress default).',
  gzipEngine,
  dist: distDir,
  assets,
  totalBytes: assets.reduce((s, a) => s + a.bytes, 0),
  totalGzipBytes: assets.reduce((s, a) => s + a.gzipBytes, 0),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('Initial JS (direct assets in dist/index.html):');
  for (const a of assets) {
    console.log(
      `  ${a.file.padEnd(40)} ${String(a.bytes).padStart(8)} bytes  gzip ${String(a.gzipBytes).padStart(8)}`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(40)} ${String(report.totalBytes).padStart(8)} bytes  gzip ${String(report.totalGzipBytes).padStart(8)}`,
  );
  const outPath = join(distDir, 'initial-js-report.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report written to ${outPath}`);
}
