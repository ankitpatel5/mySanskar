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

const DELAY_MS = 300; // be polite — pause between requests
const CONCURRENCY = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BaalShravanBot/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  // Some pages use latin1 encoding
  return new TextDecoder('latin1').decode(buf);
}

// Parse the listing page → array of {title, href}
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const stories = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).text().trim();
    // Only story pages: end in .htm, no slash, not navigation links
    if (
      href.endsWith('.htm') &&
      !href.includes('/') &&
      title.length > 3 &&
      !href.includes('stories.htm') &&
      href !== 'index.htm'
    ) {
      // Avoid duplicates
      if (!stories.find(s => s.href === href)) {
        stories.push({ title, href });
      }
    }
  });
  return stories;
}

// Parse individual story page → {photo, paragraphs, isFlash}
function parseStoryPage(html, href) {
  const $ = cheerio.load(html);

  // Detect Flash/download-only stories (no real text content)
  const hasDownload = $('img[src*="download"]').length > 0;

  // Get story photo — look for photo/ directory image
  let photo = null;
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('photo/') || src.includes('/photo/')) {
      photo = src.startsWith('photo/')
        ? `${BASE}/${src}`
        : `${BASE}/${src}`;
    }
  });

  // Collect meaningful paragraphs (filter out nav/decoration)
  const paragraphs = [];
  $('p, td > font, td').each((_, el) => {
    const text = $(el).text().trim()
      .replace(/\s+/g, ' ')
      .replace(/[\r\n]+/g, ' ');
    if (
      text.length > 60 &&
      !text.includes('Satsang Stories') &&
      !text.includes('Hindu Stories') &&
      !text.includes('Moral Stories') &&
      !text.includes('Story Time') &&
      !text.includes('Subscribe') &&
      !text.includes('email') &&
      !text.toLowerCase().includes('click here') &&
      !text.includes('©') &&
      !text.includes('BAPS Swaminarayan Sanstha')
    ) {
      // Avoid duplicate paragraphs
      if (!paragraphs.includes(text)) {
        paragraphs.push(text);
      }
    }
  });

  const isFlash = hasDownload && paragraphs.length === 0;

  return { photo, paragraphs, isFlash };
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
        const { photo, paragraphs, isFlash } = parseStoryPage(html, href);

        if (isFlash || paragraphs.length === 0) {
          return null; // skip Flash / empty stories
        }

        return {
          id: href.replace('.htm', ''),
          title,
          photo: photo || null,
          paragraphs,
          url: storyUrl,
        };
      } catch (e) {
        console.warn(`\n   ⚠ Failed: ${href} — ${e.message}`);
        return null;
      }
    }, CONCURRENCY);

    const valid = stories.filter(Boolean);
    console.log(`\n   ✓ ${valid.length} text stories (skipped ${listing.length - valid.length} Flash/empty)`);
    output.stories[cat.id] = valid;
  }

  const js = `// Auto-generated by scripts/crawl-stories.js — do not edit manually\n// Run: node scripts/crawl-stories.js to regenerate\nwindow.STORIES_DATA = ${JSON.stringify(output, null, 2)};\n`;
  fs.writeFileSync(OUT, js, 'utf8');

  const total = Object.values(output.stories).reduce((s, arr) => s + arr.length, 0);
  console.log(`\n✅ Done! ${total} stories written to stories-data.js (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
