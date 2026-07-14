#!/usr/bin/env node
/**
 * The New York City calendar — build step.
 *
 * Pulls every source that publishes machine-readable dates, scores each event for
 * public significance, and writes data/events.json + subscribable .ics feeds.
 *
 * Sources
 *   1. Legistar          — City Council hearings and stated meetings (public read token)
 *   2. City Record       — public hearings filed by every other agency (Socrata, keyless)
 *   3. NY Senate API     — Albany session days (needs NYSENATE_API_KEY; dormant out of session)
 *   4. seed/history.json — 281 sourced historical events -> round-number anniversary engine
 *   5. seed/curated.json — cultural, sporting and statutory events no API publishes
 *
 * Everything here is deterministic. The only hand-set numbers in the system are the
 * `significance` values in seed/curated.json. See methodology.html.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, 'data');

// A public, read-only Legistar token. Legistar returns 403 without it.
const LEGISTAR_TOKEN = process.env.LEGISTAR_TOKEN ||
  'Uvxb0j9syjm3aI8h46DhQvnX5skN4aSUL0x_Ee3ty9M.ew0KICAiVmVyc2lvbiI6IDEsDQogICJOYW1lIjogIk5ZQyByZWFkIHRva2VuIDIwMTcxMDI2IiwNCiAgIkRhdGUiOiAiMjAxNy0xMC0yNlQxNjoyNjo1Mi42ODM0MDYtMDU6MDAiLA0KICAiV3JpdGUiOiBmYWxzZQ0KfQ';
const NYSENATE_KEY = process.env.NYSENATE_API_KEY || '';
const SOCRATA_TOKEN = process.env.SOCRATA_APP_TOKEN || '';

const TODAY = new Date();
const todayISO = iso(TODAY);
const HORIZON_DAYS = 400;
const horizonISO = iso(addDays(TODAY, HORIZON_DAYS));
// Keep a short tail of the recent past so the page can show "this week" in full.
const startISO = iso(addDays(TODAY, -14));

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/* ─────────────────────────────────────────────────────────────
   SIGNIFICANCE MODEL

   One 0-100 scale for everything, so a hearing and a World Cup final
   can sit in the same sorted list and land in the right size of type.

     marquee  >= 85   the city notices without being told
     major    65-84   consequential, will be covered
     notable  45-64   matters to the people it matters to
     routine   < 45   the machinery of government running

   Hearings are capped at 62 by design: the most important committee
   hearing of the year can reach "notable", but never outranks an election.
   ───────────────────────────────────────────────────────────── */

const TIERS = [
  { name: 'marquee', min: 85 },
  { name: 'major',   min: 65 },
  { name: 'notable', min: 45 },
  { name: 'routine', min: 0  },
];
const tierFor = (s) => TIERS.find(t => s >= t.min).name;

const HEARING_CAP = 62;

// Committees whose subject matter reliably reaches the public.
const SALIENT_COMMITTEES = [
  'public safety', 'housing and buildings', 'land use', 'education', 'health',
  'criminal justice', 'immigration', 'transportation', 'finance', 'oversight',
  'civil rights', 'sanitation', 'environmental protection',
];

// Agencies whose hearings decide things people feel directly.
const AGENCY_WEIGHT = {
  'rent guidelines board': 24,
  'city planning commission': 18,
  'board of correction': 16,
  'landmarks preservation commission': 14,
  'housing authority': 14,
  'board of standards and appeals': 10,
  'taxi and limousine commission': 8,
  'department of education': 10,
  'health': 8,
};

const HOT_WORDS = /\b(rent|rezon|ulurp|closure|close rikers|charter|police|nypd|evict|homeless|shelter|child care|congestion|fare|layoff|budget|oversight)\b/i;

function scoreCouncilEvent(ev) {
  const body = (ev.EventBodyName || '').toLowerCase();
  const comment = (ev.EventComment || '').toLowerCase();
  let s = 22;
  const why = [];

  if (body === 'city council') { s += 28; why.push('stated meeting of the full Council'); }
  if (SALIENT_COMMITTEES.some(c => body.includes(c))) { s += 10; why.push('high-salience committee'); }
  if (body.includes('finance')) { s += 6; why.push('finance committee'); }
  if (comment.includes('vote')) { s += 8; why.push('a vote is scheduled'); }
  if (comment.includes('jointly')) { s += 6; why.push('joint committee hearing'); }
  if (HOT_WORDS.test(body) || HOT_WORDS.test(comment)) { s += 8; why.push('subject matter of broad public interest'); }

  return { score: Math.min(s, HEARING_CAP), why };
}

function scoreCityRecordEvent(rec) {
  const agency = (rec.agency_name || '').toLowerCase();
  const title = (rec.short_title || '');
  let s = 20;
  const why = [];

  for (const [name, bonus] of Object.entries(AGENCY_WEIGHT)) {
    if (agency.includes(name)) { s += bonus; why.push(`${rec.agency_name} sets policy the public feels directly`); break; }
  }
  if (HOT_WORDS.test(title)) { s += 8; why.push('subject matter of broad public interest'); }

  return { score: Math.min(s, HEARING_CAP), why };
}

/* Round-number anniversaries, computed fresh every run.
 *
 * Roundness only *modifies* the score; it does not drive it. A 250th anniversary
 * of a skirmish should not outrank the 25th of 9/11, so how much the event
 * matters to the public today (importance, 1-5) carries far more weight than how
 * many zeroes are on the number. */
const ROUNDNESS = [
  [300, 22], [250, 20], [200, 18], [175, 16], [150, 16],
  [125, 15], [100, 14], [75, 11], [50, 10],
  // Decades count too — a 30th or a 10th is a real anniversary, and the city
  // marks them. But they are common, so they must clear a higher bar to appear
  // (see MINOR_INTERVAL below) or the calendar fills with trivia.
  [40, 8], [30, 7], [25, 6], [20, 5], [10, 4],
];

// Anniversaries at intervals below this are only shown for events that genuinely
// register with the public (importance 3+). A 25th and up appears regardless.
const MINOR_INTERVAL = 25;

function anniversaryBonus(years) {
  // Take the largest round interval this anniversary satisfies.
  for (const [interval, bonus] of ROUNDNESS) {
    if (years >= interval && years % interval === 0) return { bonus, interval };
  }
  if (years > 300 && years % 50 === 0) return { bonus: 22, interval: 50 };
  return null; // not a round anniversary — skip it entirely
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ─────────────────────────────────────────────────────────────
   SOURCE 1 — City Council (Legistar)
   ───────────────────────────────────────────────────────────── */
async function fetchCouncil() {
  const url = new URL('https://webapi.legistar.com/v1/nyc/events');
  url.searchParams.set('token', LEGISTAR_TOKEN);
  url.searchParams.set('$filter', `EventDate ge datetime'${startISO}' and EventDate le datetime'${horizonISO}'`);
  url.searchParams.set('$orderby', 'EventDate');

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Legistar ${res.status}`);
  const rows = await res.json();

  return rows.map(ev => {
    const { score, why } = scoreCouncilEvent(ev);
    const isStated = (ev.EventBodyName || '').toLowerCase() === 'city council';
    return {
      date: ev.EventDate.slice(0, 10),
      time: ev.EventTime || null,
      title: isStated ? 'Stated meeting of the City Council' : ev.EventBodyName,
      note: [ev.EventComment, ev.EventLocation].filter(Boolean).join(' · ') || null,
      strand: 'hearings',
      source: 'City Council',
      sourceUrl: ev.EventInSiteURL || null,
      agendaUrl: ev.EventAgendaFile || null,
      significance: score,
      why,
      live: true,
    };
  });
}

/* ─────────────────────────────────────────────────────────────
   SOURCE 2 — The City Record (every other agency)
   ───────────────────────────────────────────────────────────── */
async function fetchCityRecord() {
  const url = new URL('https://data.cityofnewyork.us/resource/dg92-zbpx.json');
  url.searchParams.set('$select', 'event_date,agency_name,short_title,type_of_notice_description,street_address_1,city');
  url.searchParams.set('$where', `event_date >= '${startISO}T00:00:00' AND event_date <= '${horizonISO}T00:00:00'`);
  url.searchParams.set('$order', 'event_date');
  url.searchParams.set('$limit', '2000');

  const headers = { Accept: 'application/json' };
  if (SOCRATA_TOKEN) headers['X-App-Token'] = SOCRATA_TOKEN;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`City Record ${res.status}`);
  const rows = await res.json();

  return rows
    // The Council is covered authoritatively by Legistar; don't double-list it.
    .filter(r => !(r.agency_name || '').toLowerCase().includes('city council'))
    .filter(r => r.event_date && r.agency_name)
    .map(r => {
      const { score, why } = scoreCityRecordEvent(r);
      const title = (r.short_title || '').trim();
      return {
        date: r.event_date.slice(0, 10),
        time: null,
        title: title || `${r.agency_name}: ${r.type_of_notice_description || 'public hearing'}`,
        note: [r.agency_name, r.street_address_1].filter(Boolean).join(' · '),
        strand: 'hearings',
        source: r.agency_name,
        sourceUrl: 'https://a856-cityrecord.nyc.gov/',
        significance: score,
        why,
        live: true,
      };
    });
}

/* ─────────────────────────────────────────────────────────────
   SOURCE 3 — Albany session days
   The Senate API only publishes floor calendars, and only once a year's
   session is scheduled. Out of session this correctly returns nothing.
   ───────────────────────────────────────────────────────────── */
async function fetchAlbany() {
  if (!NYSENATE_KEY) return { events: [], note: 'no API key configured' };

  const years = [...new Set([TODAY.getFullYear(), TODAY.getFullYear() + 1])];
  const dates = new Set();

  for (const year of years) {
    const url = `https://legislation.nysenate.gov/api/3/calendars/${year}?limit=400&full=true&key=${NYSENATE_KEY}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const body = await res.json();
    for (const item of body?.result?.items || []) {
      const d = item?.floorCalendar?.calDate;
      if (d && d >= todayISO && d <= horizonISO) dates.add(d);
    }
  }

  const events = [...dates].sort().map(date => ({
    date,
    time: null,
    title: 'Albany session day',
    note: 'The Legislature is in session. Bills affecting the city can move on any session day.',
    strand: 'power',
    source: 'New York State Senate',
    sourceUrl: 'https://www.nysenate.gov/calendar',
    significance: 46,
    why: ['the Legislature is sitting'],
    live: true,
  }));

  return { events, note: events.length ? null : 'the Legislature is out of session' };
}

/* ─────────────────────────────────────────────────────────────
   SOURCE 4 — The anniversary engine
   ───────────────────────────────────────────────────────────── */
async function buildAnniversaries() {
  const raw = JSON.parse(await fs.readFile(path.join(DIR, 'seed/history.json'), 'utf8'));
  const { categoryDefaults, overrides } = JSON.parse(await fs.readFile(path.join(DIR, 'seed/importance.json'), 'utf8'));

  // The corpus contains a few duplicate entries (9/11 and the English seizure of
  // New Amsterdam each appear twice). Collapse on title + year.
  const seen = new Set();
  const history = raw.filter(h => {
    const k = `${h.year}|${h.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const out = [];
  // Check every year the horizon touches.
  const years = [...new Set([TODAY.getFullYear(), addDays(TODAY, HORIZON_DAYS).getFullYear()])];

  for (const y of years) {
    for (const h of history) {
      const age = y - h.year;
      if (age <= 0) continue;
      const round = anniversaryBonus(age);
      if (round === null) continue;

      const date = `${y}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`;
      if (date < startISO || date > horizonISO) continue;

      const importance = overrides[h.title] ?? categoryDefaults[h.category] ?? 2;
      // A 10th or 20th only earns a place if the event still means something.
      if (round.interval < MINOR_INTERVAL && importance < 3) continue;

      const living = age <= 60 ? 8 : 0; // within living memory of many New Yorkers
      const score = Math.min(30 + importance * 10 + round.bonus + living, 100);

      const why = [`${ordinal(age)} anniversary`];
      if (living) why.push('within living memory');

      out.push({
        date,
        time: null,
        title: `${h.title} — ${ordinal(age)} anniversary`,
        note: h.blurb,
        strand: 'anniversary',
        source: 'New York, in Time',
        sourceUrl: h.source,
        significance: score,
        importance,
        why,
        historyYear: h.year,
        anniversaryYears: age,
        live: true, // recomputed every run; rolls over on its own
      });
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────
   SOURCE 5 — Curated
   ───────────────────────────────────────────────────────────── */
async function loadCurated() {
  const { events } = JSON.parse(await fs.readFile(path.join(DIR, 'seed/curated.json'), 'utf8'));
  return events
    .filter(e => e.date >= startISO && e.date <= horizonISO)
    .map(e => ({
      date: e.date,
      time: null,
      title: e.title,
      note: e.note || null,
      strand: e.strand,
      source: 'Curated',
      sourceUrl: e.url || null,
      significance: e.significance,
      why: ['editorially judged'],
      approx: e.approx || false,
      live: false,
    }));
}

/* ─────────────────────────────────────────────────────────────
   ICS
   ───────────────────────────────────────────────────────────── */
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line) {
  // RFC 5545: lines must not exceed 75 octets.
  const out = [];
  let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  out.push(s);
  return out.join('\r\n');
}

function toICS(events, name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The New York City calendar//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    'X-PUBLISHED-TTL:PT12H', 'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  ];

  for (const e of events) {
    const d = e.date.replace(/-/g, '');
    const end = iso(addDays(new Date(e.date + 'T12:00:00'), 1)).replace(/-/g, '');
    const uid = `${d}-${e.title.replace(/\W/g, '').slice(0, 40)}@nyc-calendar`;
    const desc = [e.note, e.sourceUrl].filter(Boolean).join('\n\n');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${d}`);
    lines.push(`DTEND;VALUE=DATE:${end}`);
    lines.push(fold(`SUMMARY:${icsEscape(e.title)}`));
    if (desc) lines.push(fold(`DESCRIPTION:${icsEscape(desc)}`));
    if (e.sourceUrl) lines.push(fold(`URL:${e.sourceUrl}`));
    lines.push(`CATEGORIES:${icsEscape(e.strand)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/* ─────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────── */
const sources = [];

async function run(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const events = Array.isArray(r) ? r : r.events;
    sources.push({ name: label, ok: true, count: events.length, ms: Date.now() - t0, note: r.note || null });
    console.log(`  ✓ ${label.padEnd(22)} ${String(events.length).padStart(4)} events  ${Date.now() - t0}ms${r.note ? `  (${r.note})` : ''}`);
    return events;
  } catch (err) {
    sources.push({ name: label, ok: false, count: 0, error: err.message });
    console.error(`  ✗ ${label.padEnd(22)} FAILED: ${err.message}`);
    return [];
  }
}

console.log(`\nBuilding the New York City calendar — ${todayISO}\n`);

const all = (await Promise.all([
  run('City Council', fetchCouncil),
  run('City Record', fetchCityRecord),
  run('Albany', fetchAlbany),
  run('Anniversaries', buildAnniversaries),
  run('Curated', loadCurated),
])).flat();

// A failure of every live source means something is badly wrong; don't publish an empty calendar.
const liveOk = sources.filter(s => ['City Council', 'City Record'].includes(s.name) && s.ok).length;
if (liveOk === 0) {
  console.error('\nAll live sources failed. Refusing to overwrite data with an empty calendar.\n');
  process.exit(1);
}

for (const e of all) e.tier = tierFor(e.significance);

// Sanity checks on the curated seed. These do not fail the build — a bad row
// should not take the calendar down — but they must not pass in silence.
{
  const curated = all.filter(e => e.source === 'Curated');
  const seen = new Map();
  for (const e of curated) {
    const k = `${e.date}|${e.title}`;
    if (seen.has(k)) console.warn(`  ! duplicate curated event: ${k}`);
    seen.set(k, true);
  }
  // A "forthcoming" book whose date has passed is either stale or, worse, a
  // paperback reissue that was never forthcoming at all. See seed/curated.json.
  const stale = curated.filter(e => e.strand === 'books' && e.date < todayISO);
  for (const e of stale) console.warn(`  ! book already out — is this a reissue? ${e.date} ${e.title}`);
}

all.sort((a, b) =>
  a.date.localeCompare(b.date) ||
  b.significance - a.significance ||
  a.title.localeCompare(b.title)
);

const counts = all.reduce((m, e) => (m[e.tier] = (m[e.tier] || 0) + 1, m), {});

// The page and the methodology both cite the size of the history corpus. Publish the
// real number rather than a hand-typed one, and shout if the prose has drifted from it.
const corpusSize = JSON.parse(await fs.readFile(path.join(DIR, 'seed/history.json'), 'utf8')).length;
for (const file of ['methodology.html', 'README.md', 'index.html']) {
  const text = await fs.readFile(path.join(DIR, file), 'utf8').catch(() => '');
  const stale = [...text.matchAll(/(\d{3}) sourced (?:historical )?events/g)]
    .map(m => +m[1]).filter(n => n !== corpusSize);
  if (stale.length) console.warn(`  ! ${file} says ${[...new Set(stale)].join('/')} sourced events; the corpus holds ${corpusSize}`);
}

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'events.json'), JSON.stringify({
  generated: new Date().toISOString(),
  window: { start: startISO, end: horizonISO },
  corpusSize,
  sources,
  counts,
  events: all,
}, null, 1));

// Two feeds: everything, and the things you'd actually clear your calendar for.
await fs.writeFile(path.join(OUT, 'calendar.ics'), toICS(all, 'The New York City calendar'));
const highlights = all.filter(e => e.significance >= 65);
await fs.writeFile(path.join(OUT, 'highlights.ics'), toICS(highlights, 'The New York City calendar — highlights'));

console.log(`\n  ${all.length} events · marquee ${counts.marquee || 0} · major ${counts.major || 0} · notable ${counts.notable || 0} · routine ${counts.routine || 0}`);
console.log(`  wrote data/events.json, data/calendar.ics, data/highlights.ics (${highlights.length} highlights)\n`);
