#!/usr/bin/env node
/**
 * prerender-tts.js
 * ────────────────────────────────────────────────────────────────
 * Pre-generates Gujarati TTS audio for satsang stories and stores
 * the MP3 files in Firebase Storage, with URLs indexed in Firestore.
 *
 * Usage:
 *   node scripts/prerender-tts.js [--count 5] [--voice rohan] [--all] [--skip-existing]
 *
 * Defaults: first 5 non-video satsang stories, voice = rohan
 * --skip-existing  Skip stories that already have a complete Firestore doc
 *
 * Storage layout:
 *   Firebase Storage:  prerendered-tts/{voice}/{storyId}/p{idx}.mp3
 *   Firestore doc:     prerenderedTTS/{storyId}
 *                        { voice, paragraphUrls: [url0, url1, ...], generatedAt }
 */

'use strict';
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── CLI args ──────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const _ci   = args.indexOf('--count');
const _vi   = args.indexOf('--voice');
const COUNT        = args.includes('--all') ? Infinity : parseInt(_ci >= 0 ? args[_ci + 1] : '5', 10);
const VOICE        = _vi >= 0 ? args[_vi + 1] : 'rohan';
const MODEL        = 'bulbul:v3';   // rohan is v3
const SKIP_EXISTING = args.includes('--skip-existing');  // skip stories already in Firestore

// ── Project constants ─────────────────────────────────────────────
const PROJECT    = 'baal-shravan';
// Firebase Storage bucket — try the new format first, fall back to legacy .appspot.com
const BUCKET_NEW    = `${PROJECT}.firebasestorage.app`;
const BUCKET_LEGACY = `${PROJECT}.appspot.com`;
let   BUCKET        = BUCKET_NEW;   // resolved in checkBucket()
const ROOT       = path.join(__dirname, '..');

// ── Load app data ─────────────────────────────────────────────────
const g = {}; const window = g;
eval(fs.readFileSync(path.join(ROOT, 'stories-data.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'translations-data.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'));

const SARVAM_KEY = g.DRIFT_CONFIG.sarvamKey;
const STORIES    = g.STORIES_DATA.stories['satsang'] || [];
const TRANS      = g.STORY_TRANSLATIONS;

// ── Auth: get fresh Google access token via firebase-tools ────────
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

// ── Sarvam helpers ─────────────────────────────────────────────────
function splitTextForSarvam(text, maxChars = 450) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  const sentences = text.split(/(?<=[.।?!॥])\s*/);
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (current.length + (current ? 1 : 0) + s.length <= maxChars) {
      current = current ? current + ' ' + s : s;
    } else {
      if (current) chunks.push(current);
      if (s.length > maxChars) {
        let rem = s;
        while (rem.length > maxChars) {
          const cut = rem.lastIndexOf(' ', maxChars);
          chunks.push(rem.substring(0, cut > 0 ? cut : maxChars).trim());
          rem = rem.substring(cut > 0 ? cut + 1 : maxChars).trim();
        }
        current = rem;
      } else {
        current = s;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(c => c.length > 0);
}

function sarvamChunk(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      inputs: [text],
      target_language_code: 'gu-IN',
      speaker: VOICE,
      model: MODEL,
      enable_preprocessing: true,
    });
    const req = https.request({
      hostname: 'api.sarvam.ai', path: '/text-to-speech', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': SARVAM_KEY, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const r = JSON.parse(d);
        if (!r.audios?.[0]) return reject(new Error(r.error?.message || r.message || `Sarvam HTTP ${res.statusCode}`));
        const b64 = r.audios[0];
        const buf = Buffer.from(b64, 'base64');
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

/**
 * Properly merges multiple WAV buffers into one.
 * Sarvam returns uncompressed WAV (PCM) — each chunk has its own RIFF header,
 * so naive Buffer.concat would produce a corrupt file.  We parse every chunk,
 * extract just the raw PCM samples, then write a single correct WAV header
 * whose "data" section contains all samples in sequence.
 */
function mergeWavBuffers(wavBuffers) {
  if (wavBuffers.length === 1) return wavBuffers[0];

  function parseWav(buf) {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Buffer is not a valid WAV file (missing RIFF/WAVE marker)');
    }
    let offset = 12;
    let fmtData = null;
    let pcmData = null;

    while (offset + 8 <= buf.length) {
      const id   = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'fmt ')  fmtData = buf.slice(offset + 8, offset + 8 + size);
      else if (id === 'data') pcmData = buf.slice(offset + 8, offset + 8 + size);
      offset += 8 + size;
      if (offset % 2 !== 0) offset++;   // RIFF chunks are word-aligned
    }

    if (!fmtData || !pcmData) throw new Error('WAV missing required fmt or data chunk');
    return { fmtData, pcmData };
  }

  const parsed  = wavBuffers.map(parseWav);
  const fmtData = parsed[0].fmtData;                          // all chunks share the same format
  const allPcm  = Buffer.concat(parsed.map(p => p.pcmData));  // full audio samples

  // Build output: RIFF header (12 B) + fmt chunk (8+fmtLen B) + data chunk (8+pcmLen B)
  const headerBuf = Buffer.alloc(12 + 8 + fmtData.length + 8);
  headerBuf.write('RIFF', 0);
  headerBuf.writeUInt32LE(4 + 8 + fmtData.length + 8 + allPcm.length, 4);  // total file size − 8
  headerBuf.write('WAVE', 8);
  headerBuf.write('fmt ', 12);
  headerBuf.writeUInt32LE(fmtData.length, 16);
  fmtData.copy(headerBuf, 20);
  const dataHdrOff = 20 + fmtData.length;
  headerBuf.write('data', dataHdrOff);
  headerBuf.writeUInt32LE(allPcm.length, dataHdrOff + 4);

  return Buffer.concat([headerBuf, allPcm]);
}

async function generateAudio(gujaratiText) {
  const chunks = splitTextForSarvam(gujaratiText);
  const buffers = [];
  for (const chunk of chunks) {
    process.stdout.write(`      chunk (${chunk.length} chars)… `);
    const buf = await sarvamChunk(chunk);
    process.stdout.write(`${buf.length} bytes\n`);
    buffers.push(buf);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }
  // Merge into a single properly-formed WAV (not a naive byte concat)
  return mergeWavBuffers(buffers);
}

// ── Probe a bucket to see if it exists ───────────────────────────
function probeBucket(token, bucket) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'firebasestorage.googleapis.com',
      path: `/v0/b/${bucket}/o?maxResults=1`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Determine which bucket is reachable; throws with setup instructions if neither exists
async function checkBucket(token) {
  const newOk = await probeBucket(token, BUCKET_NEW);
  if (newOk) { BUCKET = BUCKET_NEW; console.log(`   Bucket: ${BUCKET_NEW} ✅`); return; }

  const legacyOk = await probeBucket(token, BUCKET_LEGACY);
  if (legacyOk) { BUCKET = BUCKET_LEGACY; console.log(`   Bucket: ${BUCKET_LEGACY} ✅ (legacy)`); return; }

  console.error(`
❌  Firebase Storage bucket not found.

Neither of these buckets exists yet:
  • ${BUCKET_NEW}
  • ${BUCKET_LEGACY}

To fix this (one-time setup):
  1. Open https://console.firebase.google.com/project/${PROJECT}/storage
  2. Click "Get started" and follow the prompts (Spark plan is free — no billing needed)
  3. Re-run this script once Storage is initialized

`);
  process.exit(1);
}

// ── Firebase Storage upload ───────────────────────────────────────
function uploadToStorage(token, audioBuffer, storagePath) {
  return new Promise((resolve, reject) => {
    const encodedPath = encodeURIComponent(storagePath);
    const body = audioBuffer;
    const req = https.request({
      hostname: 'firebasestorage.googleapis.com',
      path: `/v0/b/${BUCKET}/o?uploadType=media&name=${encodedPath}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'audio/wav',
        'Content-Length': body.length,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const r = JSON.parse(d);
          // Use the download token returned by Firebase — no ACL call needed.
          // Token-authenticated URLs are accessible by anyone who has the URL.
          const token = r.downloadTokens || '';
          const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodedPath}?alt=media${token ? `&token=${token}` : ''}`;
          resolve(downloadUrl);
        } else {
          reject(new Error(`Storage upload failed ${res.statusCode}: ${d.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}


// ── Firestore read (check if already rendered) ────────────────────
function firestoreGet(token, storyId) {
  return new Promise((resolve) => {
    const docPath = `projects/${PROJECT}/databases/(default)/documents/prerenderedTTS/${storyId}`;
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: `/v1/${docPath}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const r = JSON.parse(d);
          const fields = r.fields || {};
          resolve({
            voice: fields.voice?.stringValue || '',
            count: parseInt(fields.count?.integerValue || '0', 10),
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Firestore write ───────────────────────────────────────────────
function firestoreSet(token, storyId, paragraphUrls) {
  return new Promise((resolve, reject) => {
    const docPath = `projects/${PROJECT}/databases/(default)/documents/prerenderedTTS/${storyId}`;
    // Build Firestore field map
    const urlFields = {};
    paragraphUrls.forEach((url, i) => {
      urlFields[`p${i}`] = { stringValue: url };
    });
    const body = JSON.stringify({
      fields: {
        voice:         { stringValue: VOICE },
        paragraphUrls: { mapValue: { fields: urlFields } },
        generatedAt:   { integerValue: String(Date.now()) },
        count:         { integerValue: String(paragraphUrls.length) },
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
  console.log(`\n🎙️  Sarvam TTS Pre-render Script`);
  console.log(`   Voice: ${VOICE} (${MODEL})`);
  console.log(`   Limit: ${COUNT === Infinity ? 'ALL' : COUNT} stories\n`);

  // Filter eligible stories
  const eligible = STORIES.filter(s =>
    s.type !== 'youtube' &&
    s.paragraphs && s.paragraphs.length > 0 &&
    TRANS[s.id] && Array.isArray(TRANS[s.id].gujarati) && TRANS[s.id].gujarati.length > 0
  ).slice(0, COUNT);

  console.log(`Found ${eligible.length} eligible satsang stories\n`);

  // Get access token
  console.log('🔑 Getting Firebase access token…');
  const token = await getAccessToken();
  console.log('   ✅ Token acquired\n');

  // Verify Firebase Storage bucket exists
  console.log('🗄️  Checking Firebase Storage bucket…');
  await checkBucket(token);
  console.log();

  let successCount = 0;
  let failCount = 0;

  for (const story of eligible) {
    const trans = TRANS[story.id];
    const paragraphs = trans.gujarati;
    console.log(`📖 [${successCount + failCount + 1}/${eligible.length}] "${story.title}" (${story.id})`);
    console.log(`   ${paragraphs.length} paragraph(s), ${paragraphs.reduce((s, p) => s + p.length, 0)} total chars`);

    // --skip-existing: check Firestore for a complete, matching doc before doing any API work
    if (SKIP_EXISTING) {
      const existing = await firestoreGet(token, story.id);
      if (existing && existing.voice === VOICE && existing.count >= paragraphs.length) {
        console.log(`   ⏭️  Already pre-rendered (${existing.count} paragraph(s), voice=${existing.voice}) — skipping\n`);
        successCount++;
        continue;
      }
    }

    const paragraphUrls = [];
    let storyFailed = false;

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const storagePath = `prerendered-tts/${VOICE}/${story.id}/p${i}.wav`;
      process.stdout.write(`   [p${i}] Generating audio (${para.length} chars)…\n`);

      try {
        const wav = await generateAudio(para);
        process.stdout.write(`   [p${i}] Uploading ${(wav.length / 1024).toFixed(0)} KB to Storage…`);
        const url = await uploadToStorage(token, wav, storagePath);
        process.stdout.write(` ✅\n`);
        paragraphUrls.push(url);
      } catch (e) {
        process.stdout.write(` ❌ ${e.message}\n`);
        storyFailed = true;
        break;
      }
    }

    if (!storyFailed && paragraphUrls.length === paragraphs.length) {
      process.stdout.write(`   Saving ${paragraphUrls.length} URL(s) to Firestore…`);
      try {
        await firestoreSet(token, story.id, paragraphUrls);
        process.stdout.write(` ✅\n`);
        successCount++;
      } catch (e) {
        process.stdout.write(` ❌ ${e.message}\n`);
        failCount++;
      }
    } else {
      failCount++;
    }
    console.log();
  }

  console.log(`\n✅ Done — ${successCount} stories pre-rendered, ${failCount} failed`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
