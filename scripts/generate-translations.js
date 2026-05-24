#!/usr/bin/env node
/**
 * generate-translations.js
 *
 * Pre-translates all text stories into Gujarati + Transliteration using Gemini.
 * Outputs: ../translations-data.js  (window.STORY_TRANSLATIONS = { ... })
 *
 * Usage:
 *   node scripts/generate-translations.js
 *
 * The Gemini API key is read from ../config.js (gitignored).
 * Progress is saved to .translation-progress.json so interrupted runs resume.
 *
 * Rate limiting: 5 concurrent requests, 1s pause between batches.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Read Gemini API key from config.js ─────────────────────────────────────
let GEMINI_KEY = '';
try {
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const m = cfgSrc.match(/geminiKey\s*:\s*['"]([^'"]+)['"]/);
  if (m) GEMINI_KEY = m[1];
} catch (e) {
  console.error('Could not read config.js:', e.message);
}
if (process.env.GEMINI_KEY) GEMINI_KEY = process.env.GEMINI_KEY;
if (!GEMINI_KEY) {
  console.error('No Gemini API key found. Add it to config.js or set GEMINI_KEY env var.');
  process.exit(1);
}

// ── Load stories ────────────────────────────────────────────────────────────
let STORIES_DATA;
{
  const src = fs.readFileSync(path.join(ROOT, 'stories-data.js'), 'utf8');
  // Replace browser globals with node globals so we can eval in Node
  const nodeSrc = src.replace(/\bwindow\b/g, 'global');
  eval(nodeSrc);
  STORIES_DATA = global.STORIES_DATA;
}

// Collect all text stories
const allStories = [];
for (const [catId, stories] of Object.entries(STORIES_DATA.stories)) {
  for (const s of stories) {
    if (s.type !== 'youtube' && Array.isArray(s.paragraphs) && s.paragraphs.length) {
      allStories.push({ id: s.id, catId, paragraphs: s.paragraphs });
    }
  }
}
console.log(`Found ${allStories.length} text stories to translate.\n`);

// ── Progress file (so we can resume) ───────────────────────────────────────
const PROGRESS_FILE = path.join(ROOT, '.translation-progress.json');
let progress = {};
try {
  progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  const done = Object.keys(progress).length;
  console.log(`Resuming — ${done} already translated, ${allStories.length - done} remaining.\n`);
} catch {}

// ── Gemini call ─────────────────────────────────────────────────────────────
async function translateStory(story) {
  const numbered = story.paragraphs.map((p, i) => `${i + 1}. "${p}"`).join('\n');
  const prompt = `You are a warm translator for a BAPS Swaminarayan children's app (ages 2–8).

Translate the following story paragraphs into:
1. Simple, flowing Gujarati script suitable for reading aloud to a baby or toddler (natural, not literal)
2. Roman transliteration of that Gujarati — phonetic English letters so parents who speak but cannot read Gujarati script can read aloud naturally

Return ONLY valid JSON — no markdown, no extra text:
{
  "gujarati": ["paragraph 1 in Gujarati script", "..."],
  "transliteration": ["paragraph 1 phonetic English", "..."]
}

English paragraphs:
${numbered}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,    // lower temp for translation accuracy
      maxOutputTokens: 65536, // max for gemini-2.5-flash — needed for long stories
    },
  });

  const MAX_ATTEMPTS = 4;
  const RETRY_DELAYS = [3000, 7000, 15000];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1];
      process.stdout.write(`  retry ${attempt}/${MAX_ATTEMPTS - 1} (wait ${delay / 1000}s)…`);
      await sleep(delay);
    }
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();

      const isOverloaded =
        res.status === 503 ||
        (data?.error?.message || '').toLowerCase().includes('high demand') ||
        (data?.error?.message || '').toLowerCase().includes('overloaded') ||
        data?.error?.status === 'UNAVAILABLE';

      if (!res.ok) {
        if (isOverloaded && attempt < MAX_ATTEMPTS - 1) continue;
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
      }

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Empty response');

      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const result = JSON.parse(cleaned);

      if (!Array.isArray(result.gujarati) || !Array.isArray(result.transliteration)) {
        throw new Error('Invalid response structure');
      }
      return result;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1) { console.error(`  error: ${e.message} — retrying`); continue; }
      throw e;
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Single-paragraph fallback ────────────────────────────────────────────────
// Used when a full-story translation fails (usually due to a very long paragraph)
async function translateParagraph(para) {
  const prompt = `You are a warm translator for a BAPS Swaminarayan children's app.

Translate the following English paragraph into:
1. Simple, flowing Gujarati script suitable for reading aloud
2. Roman transliteration of that Gujarati — phonetic English letters

Return ONLY valid JSON:
{"gujarati": "translated paragraph in Gujarati script", "transliteration": "phonetic English"}

English paragraph:
${para}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
      maxOutputTokens: 65536,
    },
  });

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS = [3000, 7000];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS[attempt - 1]);
    }
    try {
      const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Empty response');
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const result = JSON.parse(cleaned);
      if (typeof result.gujarati !== 'string' || typeof result.transliteration !== 'string') {
        throw new Error('Invalid structure');
      }
      return result;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS - 1) continue;
      throw e;
    }
  }
}

async function translateStoryByChunks(story) {
  const gujaratiParts = [];
  const transliterationParts = [];
  for (const para of story.paragraphs) {
    await sleep(400); // small delay between para calls
    const result = await translateParagraph(para);
    gujaratiParts.push(result.gujarati);
    transliterationParts.push(result.transliteration);
  }
  return { gujarati: gujaratiParts, transliteration: transliterationParts };
}

// ── Batch processor ─────────────────────────────────────────────────────────
const CONCURRENCY = 5;
const BATCH_PAUSE_MS = 1200; // ms between batches to stay under rate limit

async function run() {
  const remaining = allStories.filter((s) => !progress[s.id]);
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (story) => {
        process.stdout.write(`[${Object.keys(progress).length + 1}/${allStories.length}] ${story.id}… `);
        try {
          let trans;
          try {
            trans = await translateStory(story);
          } catch (e) {
            // Full-story call failed — fall back to per-paragraph translation
            process.stdout.write(` (chunked fallback)… `);
            trans = await translateStoryByChunks(story);
          }
          progress[story.id] = trans;
          processed++;
          console.log('✓');
          // Save progress after each successful translation
          fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
          return true;
        } catch (e) {
          errors++;
          console.error(`✗ ${e.message}`);
          return false;
        }
      })
    );
    // Pause between batches (skip after the last batch)
    if (i + CONCURRENCY < remaining.length) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  console.log(`\n✓ Translated ${processed} stories. ${errors} errors.`);
  if (errors > 0) {
    console.log('Re-run the script to retry failed stories.\n');
  }

  // ── Write output file ──────────────────────────────────────────────────────
  const outPath = path.join(ROOT, 'translations-data.js');
  const json = JSON.stringify(progress, null, 2);
  const js = `/* ============================================================
   Sanskar — Pre-generated story translations
   Generated by: node scripts/generate-translations.js
   DO NOT edit manually — regenerate with the script above.
   Total stories: ${Object.keys(progress).length}
   ============================================================ */

window.STORY_TRANSLATIONS = ${json};
`;
  fs.writeFileSync(outPath, js, 'utf8');
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
  console.log(`${Object.keys(progress).length}/${allStories.length} stories covered.\n`);

  if (Object.keys(progress).length === allStories.length) {
    // Clean up progress file on full success
    try { fs.unlinkSync(PROGRESS_FILE); } catch {}
    console.log('All done! Commit translations-data.js and deploy.');
  } else {
    console.log(`${allStories.length - Object.keys(progress).length} stories still missing — re-run to fill gaps.`);
  }
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
