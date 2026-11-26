#!/usr/bin/env node
// Vendors the daemon's generated API types (Cliefden/celiador
// packages/client/src/schema.ts, generated from packages/client/openapi.yaml)
// into src/contract/schema.ts, pinned to one celiador commit in
// src/contract/SOURCE.
//
//   node scripts/sync-contract.mjs [ref]   # re-vendor from a celiador ref (default: main)
//   node scripts/sync-contract.mjs --check # the vendored file is exactly the pinned commit's;
//                                          # also says (without failing) when main has moved on
//
// The daemon's API only ever changes additively (packages/client/README.md in
// celiador), so an older pin keeps working; re-vendor when you need a new field.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO = 'Cliefden/celiador';
const PATH = 'packages/client/src/schema.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const target = `${root}src/contract/schema.ts`;
const sourceFile = `${root}src/contract/SOURCE`;

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'celiador-remote-sync-contract' } });
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res;
}

async function resolveSha(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return ref;
  }
  const res = await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`);
  return (await res.json()).sha;
}

const fileAt = async sha => (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${PATH}`)).text();

async function pinnedSha() {
  const line = (await readFile(sourceFile, 'utf8')).trim();
  const m = /@([0-9a-f]{40})\b/.exec(line);
  if (!m) {
    throw new Error(`src/contract/SOURCE doesn't name a commit: ${line}`);
  }
  return m[1];
}

const arg = process.argv[2];
if (arg === '--check') {
  const sha = await pinnedSha();
  const [vendored, pinned] = await Promise.all([readFile(target, 'utf8'), fileAt(sha)]);
  if (vendored !== pinned) {
    console.error(`src/contract/schema.ts differs from ${REPO}@${sha.slice(0, 7)}:${PATH}. Never edit it by hand; run: node scripts/sync-contract.mjs ${sha}`);
    process.exit(1);
  }
  console.log(`src/contract/schema.ts = ${REPO}@${sha.slice(0, 7)}`);
  try {
    const main = await resolveSha('main');
    if (main !== sha && (await fileAt(main)) !== pinned) {
      console.log(`::notice::The daemon's API types changed on ${REPO} main (${main.slice(0, 7)}); re-vendor with: npm run sync-contract`);
    }
  } catch (e) {
    console.log(`(couldn't compare with main: ${e.message})`);
  }
} else {
  const sha = await resolveSha(arg || 'main');
  await writeFile(target, await fileAt(sha));
  await writeFile(sourceFile, `${REPO}@${sha} ${PATH}\n`);
  console.log(`src/contract/schema.ts ← ${REPO}@${sha.slice(0, 7)}`);
}
