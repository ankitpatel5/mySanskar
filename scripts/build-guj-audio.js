#!/usr/bin/env node
/**
 * build-guj-audio.js — bundles the Learn Gujarati audio locally.
 *
 * Extracts every Firebase Storage audio URL from gujarati-data-content.js,
 * downloads each clip, trims leading/trailing silence (2% peak threshold,
 * 30ms pads), re-encodes to mono 48kbps AAC (speech at 192kbps stereo was
 * ~3x larger for no audible benefit), and writes to guj-audio/ using EXACTLY
 * the names AppUtils.gujLocalAudioPath maps to at runtime (single source of
 * truth — a divergence would 404 to the remote fallback, not break playback).
 *
 * Idempotent: existing outputs are skipped. macOS-only (afconvert).
 * Usage: node scripts/build-guj-audio.js [--force]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { gujLocalAudioPath } = require('../utils.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'guj-audio');
const TMP = fs.mkdtempSync('/tmp/gujaudio-');
const FORCE = process.argv.includes('--force');

const data = fs.readFileSync(path.join(ROOT, 'gujarati-data-content.js'), 'utf8');
const urls = [...new Set([...data.matchAll(/"audio":\s*"(https:\/\/firebasestorage[^"]+)"/g)].map((m) => m[1]))];
console.log(`Found ${urls.length} unique audio URLs`);

// Uniqueness guard: two storage paths must never map to one local name.
const byLocal = new Map();
for (const u of urls) {
  const local = gujLocalAudioPath(u);
  if (!local) { console.error(`✗ unmappable URL: ${u.slice(0, 100)}`); process.exit(1); }
  if (byLocal.has(local) && byLocal.get(local) !== u) {
    console.error(`✗ name collision: ${local}\n  ${byLocal.get(local)}\n  ${u}`); process.exit(1);
  }
  byLocal.set(local, u);
}
fs.mkdirSync(OUT, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      const f = fs.createWriteStream(dest);
      res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject);
    }).on('error', reject);
  });
}

// Trim silence from 16-bit PCM WAV: find the 'data' chunk, locate onset/offset
// at 2% of peak, keep 30ms pads, rewrite the chunk. Returns trimmed ms.
function trimWav(inPath, outPath) {
  const buf = fs.readFileSync(inPath);
  let off = 12, dataOff = -1, dataLen = 0, sr = 44100, ch = 1, bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
    if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len + (len % 2);
  }
  if (dataOff < 0 || bits !== 16) { fs.copyFileSync(inPath, outPath); return 0; }
  const samples = new Int16Array(buf.buffer, buf.byteOffset + dataOff, Math.floor(dataLen / 2));
  let peak = 1;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const th = peak * 0.02;
  let first = 0, last = samples.length - 1;
  while (first < samples.length && Math.abs(samples[first]) <= th) first++;
  while (last > first && Math.abs(samples[last]) <= th) last--;
  const pad = Math.round(0.03 * sr) * ch;
  first = Math.max(0, first - pad);
  last = Math.min(samples.length, last + pad);
  first -= first % ch; // frame-align
  const outSamples = samples.subarray(first, last);
  const header = Buffer.from(buf.subarray(0, dataOff));
  header.writeUInt32LE(36 + outSamples.length * 2, 4);          // RIFF size
  header.writeUInt32LE(outSamples.length * 2, dataOff - 4);      // data size
  fs.writeFileSync(outPath, Buffer.concat([header, Buffer.from(outSamples.buffer, outSamples.byteOffset, outSamples.length * 2)]));
  return Math.round(((samples.length - outSamples.length) / ch / sr) * 1000);
}

(async () => {
  let done = 0, skipped = 0, failed = 0, trimmedMs = 0;
  const queue = [...byLocal.entries()];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const [local, url] = queue.shift();
      const outFile = path.join(ROOT, local);
      if (!FORCE && fs.existsSync(outFile)) { skipped++; continue; }
      const base = path.join(TMP, String(done + skipped + failed) + Math.random().toString(36).slice(2, 6));
      try {
        await download(url, base + '.src');
        execFileSync('afconvert', [base + '.src', '-f', 'WAVE', '-d', 'LEI16', base + '.wav'], { stdio: 'pipe' });
        trimmedMs += trimWav(base + '.wav', base + '-t.wav');
        execFileSync('afconvert', [base + '-t.wav', '-f', 'm4af', '-d', 'aac', '-b', '49152', '-c', '1', outFile], { stdio: 'pipe' });
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${urls.length}…`);
      } catch (e) {
        failed++; console.error(`  ✗ ${local}: ${e.message.slice(0, 80)}`);
      } finally {
        for (const ext of ['.src', '.wav', '-t.wav']) { try { fs.unlinkSync(base + ext); } catch {} }
      }
    }
  });
  await Promise.all(workers);
  const totalBytes = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`\n✅ converted ${done}, skipped ${skipped} existing, failed ${failed}`);
  console.log(`   total silence removed: ${(trimmedMs / 1000).toFixed(0)}s across the set`);
  console.log(`   guj-audio/: ${fs.readdirSync(OUT).length} files, ${(totalBytes / 1048576).toFixed(1)} MB`);
  if (failed) process.exit(1);
})();
