#!/usr/bin/env node
/**
 * build-eternal-virtues.js
 * ────────────────────────────────────────────────────────────────
 * Parses eternal-virtues.md (master content file authored from the book
 * "Eternal Virtues — Spiritual Attributes of Pramukh Swami Maharaj")
 * into a JSON payload and uploads it to the Firestore doc:
 *
 *   content/eternalVirtues
 *     { version, count, updatedAt, json }
 *
 * `json` is the stringified payload the app consumes:
 *   { version, count, items: [{ v, vEn, vGu, title, text }] }
 *
 * Items are interleaved round-robin across virtues so consecutive days
 * rotate through different virtues. The order is deterministic (derived
 * from the MD file), so every user sees the same snippet on the same day
 * via `daysSinceEpoch % items.length` in app.js.
 *
 * Usage:
 *   node scripts/build-eternal-virtues.js --dry-run    # parse + stats only
 *   node scripts/build-eternal-virtues.js              # parse + upload
 *
 * Auth: reuses the cached firebase-tools login (same pattern as
 * prerender-tts.js) — no service account file needed.
 */

'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PROJECT = 'baal-shravan';
const ROOT    = path.join(__dirname, '..');
const MD_PATH = path.join(ROOT, 'eternal-virtues.md');
const DRY_RUN = process.argv.includes('--dry-run');
const VERSION = 1;

// ── Parse the master markdown ─────────────────────────────────────
function parseMarkdown(md) {
  const sections = [];   // [{ v, vEn, vGu, snippets: [{title, text}] }]
  let section = null;
  let snippet = null;

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();

    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      const parts = h2[1].split('·').map(s => s.trim());
      if (parts.length < 3) throw new Error(`Bad section header: "${line}" (expected "Virtue · English · Gujarati")`);
      section = { v: parts[0], vEn: parts[1], vGu: parts[2], snippets: [] };
      sections.push(section);
      snippet = null;
      continue;
    }

    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      if (!section) throw new Error(`Snippet before any section: "${line}"`);
      snippet = { title: h3[1].trim(), text: '' };
      section.snippets.push(snippet);
      continue;
    }

    if (snippet && line.trim()) {
      snippet.text += (snippet.text ? ' ' : '') + line.trim();
    }
  }
  return sections;
}

// ── Interleave: round-robin one snippet per virtue per cycle ──────
function interleave(sections) {
  const queues = sections.map(s => s.snippets.map(sn => ({
    v: s.v, vEn: s.vEn, vGu: s.vGu, title: sn.title, text: sn.text,
  })));
  const items = [];
  let remaining = queues.reduce((n, q) => n + q.length, 0);
  while (remaining > 0) {
    for (const q of queues) {
      if (q.length) { items.push(q.shift()); remaining--; }
    }
  }
  return items;
}

// ── Auth: fresh Google access token via firebase-tools cache ──────
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const api      = require('/Users/ankit/.npm-global/lib/node_modules/firebase-tools/lib/api');
    const { getGlobalDefaultAccount } = require('/Users/ankit/.npm-global/lib/node_modules/firebase-tools/lib/auth');
    const account  = getGlobalDefaultAccount();
    const clientId = api.clientId();
    const secret   = api.clientSecret();
    const rt       = account.tokens.refresh_token;

    const body = `client_id=${clientId}&client_secret=${secret}&refresh_token=${rt}&grant_type=refresh_token`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const r = JSON.parse(d);
        r.access_token ? resolve(r.access_token) : reject(new Error(r.error_description || JSON.stringify(r)));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Firestore write ───────────────────────────────────────────────
function firestoreSet(token, payload) {
  return new Promise((resolve, reject) => {
    const docPath = `projects/${PROJECT}/databases/(default)/documents/content/eternalVirtues`;
    const body = JSON.stringify({
      fields: {
        version:   { integerValue: String(payload.version) },
        count:     { integerValue: String(payload.count) },
        updatedAt: { integerValue: String(Date.now()) },
        json:      { stringValue: JSON.stringify(payload) },
      },
    });
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/${docPath}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        res.statusCode === 200 ? resolve() : reject(new Error(`Firestore write failed ${res.statusCode}: ${d.substring(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const md = fs.readFileSync(MD_PATH, 'utf8');
  const sections = parseMarkdown(md);
  const items = interleave(sections);

  console.log(`\n📖 Eternal Virtues — parsed ${MD_PATH}`);
  console.log(`   Virtues:  ${sections.length}`);
  console.log(`   Snippets: ${items.length}\n`);
  for (const s of sections) {
    console.log(`   ${String(s.snippets.length).padStart(3)}  ${s.v} · ${s.vEn}`);
  }

  // Sanity checks
  if (!sections.length || !items.length) {
    console.error('\n❌ Parsed zero sections/snippets — refusing to overwrite the live doc.');
    process.exit(1);
  }
  const empty = items.filter(i => !i.text || i.text.length < 100);
  if (empty.length) {
    console.error(`\n❌ ${empty.length} snippet(s) look too short:`);
    empty.forEach(i => console.error(`   - [${i.v}] ${i.title} (${i.text.length} chars)`));
    process.exit(1);
  }
  const payload = { version: VERSION, count: items.length, items };
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  console.log(`\n   Payload: ${(bytes / 1024).toFixed(1)} KB (Firestore doc limit ~1024 KB)`);
  if (bytes > 900 * 1024) { console.error('❌ Payload too close to the 1 MB doc limit'); process.exit(1); }

  // Show the first week of rotation as a preview
  console.log('\n   First 7 days of rotation:');
  items.slice(0, 7).forEach((i, d) => console.log(`   day+${d}: [${i.v}] ${i.title}`));

  if (DRY_RUN) { console.log('\n🏁 Dry run — nothing uploaded.\n'); return; }

  console.log('\n☁️  Uploading to Firestore doc content/eternalVirtues …');
  const token = await getAccessToken();
  await firestoreSet(token, payload);
  console.log('✅ Uploaded.\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
