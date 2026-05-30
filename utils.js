/**
 * utils.js — Pure utility functions for mySanskar
 *
 * These functions have no side effects, no DOM access, no Firebase, no network.
 * They are the single source of truth — app.js delegates to window.AppUtils,
 * and tests import directly via module.exports.
 */

// ── Track / filename helpers ────────────────────────────────────────────────

function cleanTrackName(filename) {
  return filename.replace(/\.[a-zA-Z0-9]+$/, '').replace(/_/g, ' ').trim();
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ── Time formatting ──────────────────────────────────────────────────────────

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}yr ago`;
}

// ── File type detection ──────────────────────────────────────────────────────

function isAudio(file) {
  if (file.mimeType && file.mimeType.startsWith('audio/')) return true;
  const name = (file.name || '').toLowerCase();
  return (
    name.endsWith('.mp3') ||
    name.endsWith('.m4a') ||
    name.endsWith('.wav') ||
    name.endsWith('.ogg') ||
    name.endsWith('.flac') ||
    name.endsWith('.aac')
  );
}

function isFolder(file) {
  return file.mimeType === 'application/vnd.google-apps.folder';
}

// ── Google Drive URL helpers ─────────────────────────────────────────────────

function parseFolderId(input) {
  const m = input.match(/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : input;
}

// ── HTML / string helpers ────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── Child profile helpers ────────────────────────────────────────────────────

function calcAgeFromDob(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : null;
}

function buildChildCharacterString(profile) {
  const { name, gender } = profile;
  if (!name) return '';
  const genderWord = gender === 'girl' ? 'girl' : gender === 'boy' ? 'boy' : 'child';
  return `a ${genderWord} named ${name}`;
}

// ── TTS / Gujarati text helpers ──────────────────────────────────────────────

function preprocessGujaratiForTTS(text) {
  return text
    .replace(/\.+/g, '।')      // "..." or "." → Gujarati danda
    .replace(/,/g, ' ')        // Comma → pause space
    .replace(/["""'']/g, '')   // Strip curly/straight quotes
    .replace(/\s{2,}/g, ' ')   // Collapse extra spaces
    .trim();
}

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
        let remainder = s;
        while (remainder.length > maxChars) {
          const cut = remainder.lastIndexOf(' ', maxChars);
          const splitAt = cut > 0 ? cut : maxChars;
          chunks.push(remainder.substring(0, splitAt).trim());
          remainder = remainder.substring(splitAt).trim();
        }
        current = remainder;
      } else {
        current = s;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}

// ── Exports ──────────────────────────────────────────────────────────────────

const AppUtils = {
  cleanTrackName,
  naturalCompare,
  formatTime,
  timeAgo,
  isAudio,
  isFolder,
  parseFolderId,
  escapeHtml,
  hashStr,
  calcAgeFromDob,
  buildChildCharacterString,
  preprocessGujaratiForTTS,
  splitTextForSarvam,
};

// Browser: expose as global
if (typeof window !== 'undefined') window.AppUtils = AppUtils;

// Node.js / Vitest: export as module
if (typeof module !== 'undefined') module.exports = AppUtils;
