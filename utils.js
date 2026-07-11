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

// ── Audio focus (single-player rule) ────────────────────────────────────────
// The app has three audio sources — music, audiobook, story TTS — that must be
// mutually exclusive. Given the source that is starting and a map of
// { name: { playing: () => bool, stop: () => void } }, stops every OTHER source
// that reports playing. Pure coordination logic (the app supplies the handles)
// so the exclusion matrix is unit-testable — this rule regressed once when a
// play path skipped it (see tests/audio-focus.test.js).
function enforceSingleAudio(starting, sources) {
  const stopped = [];
  Object.keys(sources || {}).forEach((name) => {
    if (name === starting) return;
    const src = sources[name];
    if (!src) return;
    try {
      if (src.playing()) { src.stop(); stopped.push(name); }
    } catch (e) { /* one bad source must not block stopping the rest */ }
  });
  return stopped;
}

// ── Library sections ────────────────────────────────────────────────────────
// A "[NS]" prefix on a Drive folder name marks non-satsang content (the
// "Fun & Rhymes" section). The marker is a data contract only — it is stripped
// here and must never render. Other bracket tags ("[Eng]") are left intact.
function parseAlbumFolderName(name) {
  const nsMatch = /^\s*\[\s*ns\s*\]\s*/i.exec(name || '');
  return {
    name: nsMatch ? (name || '').slice(nsMatch[0].length).trim() : (name || ''),
    section: nsMatch ? 'fun' : 'satsang',
  };
}

// ── Audiobook virtual parts ─────────────────────────────────────────────────
// Single-file audiobooks are split into virtual "Parts" (startTime/endTime
// offsets into one audio file). After a manual seek (±30s) the absolute
// position may land in a DIFFERENT part than the UI shows — this resolves
// which part contains a position. Chapters without startTime (real multi-file
// books) can't cross, so the caller's current index is returned unchanged.
function virtualChapterIdxForPos(chapters, absPos, fallbackIdx) {
  if (!Array.isArray(chapters) || !chapters.length) return fallbackIdx;
  if (!chapters[0] || chapters[0].startTime === undefined) return fallbackIdx;
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    if (c && absPos >= c.startTime && (c.endTime === undefined || absPos < c.endTime)) return i;
  }
  if (absPos < chapters[0].startTime) return 0;
  return chapters.length - 1; // past the final endTime
}

// ── Media-session router (pure logic; see app.js msClaim/msPaused) ──────────
// One source at a time owns navigator.mediaSession (lock screen / CarPlay).
// These tables + resolvers are pure so the routing matrix is unit-testable —
// the CarPlay-controls-the-wrong-player bug lived exactly here.
// Every source declares ALL actions; null means "explicitly clear that slot"
// (iOS maps handlers onto fixed button slots — prev/next and seek± compete,
// so audiobook nulls prev/next to surface the ±30s glyphs).
const MS_ACTION_MAP = {
  music:     { play: 'music.toggle', pause: 'music.toggle', previoustrack: 'music.prev', nexttrack: 'music.next', seekbackward: null, seekforward: null },
  audiobook: { play: 'ab.toggle',    pause: 'ab.toggle',    previoustrack: null,         nexttrack: null,         seekbackward: 'ab.back30', seekforward: 'ab.fwd30' },
  tts:       { play: 'tts.toggle',   pause: 'tts.pause',    previoustrack: null,         nexttrack: null,         seekbackward: null, seekforward: null },
};

function resolveMediaAction(source, action) {
  const map = MS_ACTION_MAP[source];
  return (map && map[action]) || null;
}

// Race guard: element 'pause' events are queued tasks — when source B starts,
// the single-audio rule pauses A, and A's pause listener runs AFTER B claimed
// the session. Only the CURRENT owner may stamp playbackState.
function msShouldApply(source, activeSource) {
  return source === activeSource;
}

// MediaMetadata fields must always be strings (never undefined — it can throw).
function buildMediaSessionMeta(source, info) {
  if (source === 'music') {
    const t = info || {};
    return { title: t.name || '', artist: t.albumName || '', album: t.albumName || '' };
  }
  if (source === 'audiobook') {
    const book = (info && info.book) || { chapters: [] };
    const idx = (info && info.idx) || 0;
    const ch = book.chapters[idx] || {};
    const total = book.chapters.length;
    const isVirtual = ch.realId != null || ch.startTime != null;
    return {
      title: (isVirtual ? book.name : ch.name) || '',
      artist: total <= 1 ? '' : `${isVirtual ? 'Part' : 'Chapter'} ${idx + 1} of ${total}`,
      album: book.name || '',
    };
  }
  const story = info || {};
  return { title: story.title || story.name || 'Story', artist: 'Story time', album: 'mySanskar' };
}

// Lock-screen scrubber math for virtual audiobook parts. Returns null unless
// everything is finite (Drive streams report Infinity/NaN before metadata;
// setPositionState throws on non-finite values or position > duration).
function computeAbPositionState({ currentTime, duration, startTime, endTime, playbackRate }) {
  const chStart = startTime ?? 0;
  const chEnd = (endTime !== undefined && isFinite(endTime)) ? endTime : duration;
  const chDur = chEnd - chStart;
  if (!isFinite(chDur) || chDur <= 0 || !isFinite(currentTime)) return null;
  return {
    duration: chDur,
    position: Math.min(Math.max(currentTime - chStart, 0), chDur),
    playbackRate: playbackRate || 1,
  };
}

const AppUtils = {
  enforceSingleAudio,
  parseAlbumFolderName,
  virtualChapterIdxForPos,
  MS_ACTION_MAP,
  resolveMediaAction,
  msShouldApply,
  buildMediaSessionMeta,
  computeAbPositionState,
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
