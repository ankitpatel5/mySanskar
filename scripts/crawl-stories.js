#!/usr/bin/env node
// Crawl BAPS Kids Story Time pages and generate stories-data.js
// Run: node scripts/crawl-stories.js

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const BASE = 'https://kids.baps.org/storytime';
const OUT  = path.join(__dirname, '..', 'stories-data.js');

const CATEGORIES = [
  { id: 'satsang', name: 'Satsang Stories', file: 'satsangstories.htm',
    color: ['#1a3a2a', '#0d1f16'], icon: '🕉️' },
  { id: 'hindu',   name: 'Hindu Stories',   file: 'hindustories.htm',
    color: ['#3a2010', '#1f1008'], icon: '🪔' },
  { id: 'moral',   name: 'Moral Stories',   file: 'moralstories.htm',
    color: ['#1a2a3a', '#0d1620'], icon: '⭐' },
];

const DELAY_MS   = 300;
const CONCURRENCY = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BaalShravanBot/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('latin1').decode(buf);
}

// Parse the listing page → array of {title, href}
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).text().trim();
    if (
      href.endsWith('.htm') &&
      !href.includes('/') &&
      title.length > 3 &&
      !href.includes('stories.htm') &&
      href !== 'index.htm'
    ) {
      if (!stories.find(s => s.href === href)) {
        stories.push({ title, href });
      }
    }
  });
  return stories;
}

// Parse individual story page → {type, photo, paragraphs, youtubeId}
// type: 'text' | 'youtube' | 'skip'
function parseStoryPage(html) {
  const $ = cheerio.load(html);

  // ── YouTube detection ──────────────────────────────────────────────
  const ytMatch = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  if (ytMatch) {
    // Also grab any text paragraphs that accompany the video
    const paragraphs = extractParagraphs($);
    return { type: 'youtube', youtubeId: ytMatch[1], paragraphs, photo: null };
  }

  // ── Flash / SWF detection ─────────────────────────────────────────
  const hasSwf = html.includes('.swf') || html.includes('RufflePlayer');

  // ── Story photo ───────────────────────────────────────────────────
  let photo = null;
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('photo/') || src.includes('/photo/')) {
      photo = `${BASE}/${src.startsWith('photo/') ? src : src}`;
    }
  });

  // ── Text paragraphs ───────────────────────────────────────────────
  const paragraphs = extractParagraphs($);

  // Skip if Flash-only with no real text
  if (hasSwf && paragraphs.length === 0) return { type: 'skip' };
  // Skip if completely empty
  if (paragraphs.length === 0) return { type: 'skip' };

  return { type: 'text', photo, paragraphs };
}

// Extract meaningful paragraphs, filtering out navigation, ads, and JS code
function extractParagraphs($) {
  const paragraphs = [];
  $('p, td > font, td').each((_, el) => {
    const text = $(el).text().trim()
      .replace(/\s+/g, ' ')
      .replace(/[\r\n]+/g, ' ');

    if (
      text.length > 60 &&
      // Navigation / boilerplate
      !text.includes('Satsang Stories') &&
      !text.includes('Hindu Stories') &&
      !text.includes('Moral Stories') &&
      !text.includes('Story Time') &&
      !text.includes('Subscribe') &&
      !text.includes('email') &&
      !text.toLowerCase().includes('click here') &&
      !text.includes('©') &&
      !text.includes('BAPS Swaminarayan Sanstha') &&
      // Flash / JS code leaking into text nodes
      !text.includes('RufflePlayer') &&
      !text.includes('window.addEventListener') &&
      !text.includes('window.RufflePlayer') &&
      !text.includes('createPlayer') &&
      !text.includes('player.load(') &&
      !text.includes('.swf') &&
      !text.includes('var ruffle') &&
      !text.includes('const ruffle')
    ) {
      if (!paragraphs.includes(text)) {
        paragraphs.push(text);
      }
    }
  });
  return paragraphs;
}

// Process stories in batches to limit concurrency
async function processBatch(items, fn, concurrency) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) await sleep(DELAY_MS);
    process.stdout.write(`  ${Math.min(i + concurrency, items.length)}/${items.length}\r`);
  }
  return results;
}

async function main() {
  const output = { categories: CATEGORIES, stories: {} };
  const summary = { text: 0, youtube: 0, skipped: 0 };

  for (const cat of CATEGORIES) {
    console.log(`\n📖 Crawling ${cat.name}...`);
    const listUrl = `${BASE}/${cat.file}`;
    const listHtml = await fetchHtml(listUrl);
    const listing = parseListingPage(listHtml);
    console.log(`   Found ${listing.length} stories`);

    const stories = await processBatch(listing, async ({ title, href }) => {
      try {
        const storyUrl = `${BASE}/${href}`;
        const html = await fetchHtml(storyUrl);
        const parsed = parseStoryPage(html);

        if (parsed.type === 'skip') {
          summary.skipped++;
          return null;
        }

        summary[parsed.type]++;
        return {
          id: href.replace('.htm', ''),
          title,
          type: parsed.type,           // 'text' | 'youtube'
          photo: parsed.photo || null,
          youtubeId: parsed.youtubeId || null,
          paragraphs: parsed.paragraphs || [],
          url: storyUrl,
        };
      } catch (e) {
        console.warn(`\n   ⚠ Failed: ${href} — ${e.message}`);
        return null;
      }
    }, CONCURRENCY);

    const valid = stories.filter(Boolean);
    const ytCount   = valid.filter(s => s.type === 'youtube').length;
    const txtCount  = valid.filter(s => s.type === 'text').length;
    const skipped   = listing.length - valid.length;
    console.log(`\n   ✓ ${valid.length} stories (${txtCount} text, ${ytCount} video, ${skipped} skipped)`);
    output.stories[cat.id] = valid;
  }

  const js = `// Auto-generated by scripts/crawl-stories.js — do not edit manually\n// Run: node scripts/crawl-stories.js to regenerate\nwindow.STORIES_DATA = ${JSON.stringify(output, null, 2)};\n`;
  fs.writeFileSync(OUT, js, 'utf8');

  const total = Object.values(output.stories).reduce((s, arr) => s + arr.length, 0);
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\n✅ Done! ${total} stories (${summary.text} text, ${summary.youtube} video, ${summary.skipped} skipped) → stories-data.js (${kb} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
