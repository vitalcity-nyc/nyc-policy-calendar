#!/usr/bin/env node
/**
 * Link rot check.
 *
 * Every event on the calendar cites a source, and a citation that 404s is a
 * failed citation. This walks every unique sourceUrl in data/events.json and
 * reports the dead ones.
 *
 * Many authoritative sites (Britannica, nyc.gov, the state election board)
 * return 403 to a script while serving fine to a browser, so a 403 is reported
 * as "blocked", not "dead". Only 404/410 and hard failures count as broken.
 *
 *   node scripts/check-links.mjs          # report
 *   node scripts/check-links.mjs --strict # exit 1 if anything is broken
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const { events } = JSON.parse(await fs.readFile(path.join(DIR, '../data/events.json'), 'utf8'));

const urls = [...new Set(events.map(e => e.sourceUrl).filter(u => u && /^https?:/.test(u)))];
console.log(`Checking ${urls.length} cited sources…\n`);

const broken = [], blocked = [];

async function check(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404 || res.status === 410) {
      broken.push({ url, status: res.status });
      console.log(`  DEAD    ${res.status}  ${url}`);
    } else if (res.status === 403 || res.status === 429) {
      blocked.push({ url, status: res.status });
    }
  } catch {
    // A refused or timed-out connection usually means the host dislikes scripts
    // (several government sites do), not that the page is gone. Surface it, but
    // do not call it dead — that is a claim only a 404 earns.
    blocked.push({ url, status: 'unreachable' });
  }
}

// Small batches: politeness, and several of these are government sites.
for (let i = 0; i < urls.length; i += 6) {
  await Promise.all(urls.slice(i, i + 6).map(check));
}

console.log(`\n  ${urls.length - broken.length - blocked.length} live · ${blocked.length} blocked to scripts (fine in a browser) · ${broken.length} dead`);

if (broken.length) {
  console.log('\nDead citations must be replaced — a source that 404s is not a source:');
  for (const b of broken) console.log(`  ${b.status}  ${b.url}`);
  if (process.argv.includes('--strict')) process.exit(1);
}
