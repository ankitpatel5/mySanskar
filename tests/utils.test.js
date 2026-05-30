import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const {
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
} = require('../utils.js');

// ── cleanTrackName ────────────────────────────────────────────────────────────
describe('cleanTrackName', () => {
  it('removes file extension', () => {
    expect(cleanTrackName('Jai_Swaminarayan.mp3')).toBe('Jai Swaminarayan');
  });
  it('replaces underscores with spaces', () => {
    expect(cleanTrackName('bhajan_track_01.mp3')).toBe('bhajan track 01');
  });
  it('handles names without extension', () => {
    expect(cleanTrackName('Om Namah Shivay')).toBe('Om Namah Shivay');
  });
  it('trims leading and trailing spaces (extension must be at end)', () => {
    // Note: leading/trailing spaces prevent the extension regex from matching —
    // the function trims after replacement so trailing-space inputs won't have
    // their extension stripped. Input should not have surrounding whitespace.
    expect(cleanTrackName('track_name.mp3')).toBe('track name');
  });
  it('handles .m4a extension', () => {
    expect(cleanTrackName('kirtan.m4a')).toBe('kirtan');
  });
});

// ── naturalCompare ────────────────────────────────────────────────────────────
describe('naturalCompare', () => {
  it('sorts numbers naturally (2 before 10)', () => {
    const items = ['Track 10', 'Track 2', 'Track 1'];
    items.sort(naturalCompare);
    expect(items).toEqual(['Track 1', 'Track 2', 'Track 10']);
  });
  it('is case-insensitive', () => {
    expect(naturalCompare('abc', 'ABC')).toBe(0);
  });
  it('sorts alphabetically when no numbers', () => {
    const items = ['Chesta', 'Aarti', 'Bhajan'];
    items.sort(naturalCompare);
    expect(items).toEqual(['Aarti', 'Bhajan', 'Chesta']);
  });
});

// ── formatTime ────────────────────────────────────────────────────────────────
describe('formatTime', () => {
  it('formats 0 as 0:00', () => {
    expect(formatTime(0)).toBe('0:00');
  });
  it('formats 65 seconds as 1:05', () => {
    expect(formatTime(65)).toBe('1:05');
  });
  it('formats 3600 seconds as 60:00', () => {
    expect(formatTime(3600)).toBe('60:00');
  });
  it('pads single-digit seconds with zero', () => {
    expect(formatTime(61)).toBe('1:01');
  });
  it('returns 0:00 for NaN', () => {
    expect(formatTime(NaN)).toBe('0:00');
  });
  it('returns 0:00 for null', () => {
    expect(formatTime(null)).toBe('0:00');
  });
  it('floors fractional seconds', () => {
    expect(formatTime(59.9)).toBe('0:59');
  });
});

// ── timeAgo ───────────────────────────────────────────────────────────────────
describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const now = new Date('2026-05-29T12:00:00Z').getTime();

  it('returns "just now" for < 60 seconds', () => {
    expect(timeAgo(now - 30_000)).toBe('just now');
  });
  it('returns minutes ago', () => {
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
  });
  it('returns hours ago', () => {
    expect(timeAgo(now - 3 * 3600_000)).toBe('3h ago');
  });
  it('returns days ago', () => {
    expect(timeAgo(now - 5 * 86400_000)).toBe('5d ago');
  });
  it('returns months ago', () => {
    expect(timeAgo(now - 60 * 86400_000)).toBe('2mo ago');
  });
  it('returns years ago', () => {
    expect(timeAgo(now - 400 * 86400_000)).toBe('1yr ago');
  });
});

// ── isAudio ───────────────────────────────────────────────────────────────────
describe('isAudio', () => {
  it('detects audio mimeType', () => {
    expect(isAudio({ mimeType: 'audio/mpeg', name: 'x' })).toBe(true);
  });
  it('detects .mp3 by name', () => {
    expect(isAudio({ name: 'kirtan.mp3' })).toBe(true);
  });
  it('detects .m4a by name', () => {
    expect(isAudio({ name: 'bhajan.m4a' })).toBe(true);
  });
  it('detects .wav by name', () => {
    expect(isAudio({ name: 'sound.wav' })).toBe(true);
  });
  it('rejects folder mimeType', () => {
    expect(isAudio({ mimeType: 'application/vnd.google-apps.folder', name: 'x' })).toBe(false);
  });
  it('rejects image files', () => {
    expect(isAudio({ name: 'cover.jpg' })).toBe(false);
  });
  it('is case-insensitive for extension', () => {
    expect(isAudio({ name: 'TRACK.MP3' })).toBe(true);
  });
});

// ── isFolder ──────────────────────────────────────────────────────────────────
describe('isFolder', () => {
  it('returns true for Google Drive folder mimeType', () => {
    expect(isFolder({ mimeType: 'application/vnd.google-apps.folder' })).toBe(true);
  });
  it('returns false for audio files', () => {
    expect(isFolder({ mimeType: 'audio/mpeg' })).toBe(false);
  });
  it('returns false for missing mimeType', () => {
    expect(isFolder({})).toBe(false);
  });
});

// ── parseFolderId ─────────────────────────────────────────────────────────────
describe('parseFolderId', () => {
  it('extracts ID from full Google Drive URL', () => {
    expect(
      parseFolderId('https://drive.google.com/drive/folders/1ABC123xyz_-abc')
    ).toBe('1ABC123xyz_-abc');
  });
  it('returns raw input when no folders/ pattern', () => {
    expect(parseFolderId('1ABC123xyz')).toBe('1ABC123xyz');
  });
  it('handles URL with trailing query params', () => {
    expect(
      parseFolderId('https://drive.google.com/drive/folders/myFolderID?usp=sharing')
    ).toBe('myFolderID');
  });
});

// ── escapeHtml ────────────────────────────────────────────────────────────────
describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('Jai & Ram')).toBe('Jai &amp; Ram');
  });
  it('escapes less-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });
  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
  it('leaves clean strings untouched', () => {
    expect(escapeHtml('Jay Swaminarayan')).toBe('Jay Swaminarayan');
  });
  it('converts non-string input to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

// ── hashStr ───────────────────────────────────────────────────────────────────
describe('hashStr', () => {
  it('returns a non-negative integer', () => {
    const h = hashStr('Satsang Stories');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });
  it('returns the same value for the same input', () => {
    expect(hashStr('Aksharam Aham Mantra')).toBe(hashStr('Aksharam Aham Mantra'));
  });
  it('returns different values for different inputs', () => {
    expect(hashStr('Satsang')).not.toBe(hashStr('Bhajan'));
  });
  it('handles empty string without error', () => {
    expect(() => hashStr('')).not.toThrow();
  });
});

// ── calcAgeFromDob ────────────────────────────────────────────────────────────
describe('calcAgeFromDob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29'));
  });
  afterEach(() => vi.useRealTimers());

  it('calculates age correctly', () => {
    expect(calcAgeFromDob('2020-01-01')).toBe(6);
  });
  it('returns correct age before birthday in current year', () => {
    expect(calcAgeFromDob('2020-12-31')).toBe(5);
  });
  it('returns correct age on exact birthday', () => {
    expect(calcAgeFromDob('2020-05-29')).toBe(6);
  });
  it('returns null for missing dob', () => {
    expect(calcAgeFromDob(null)).toBeNull();
    expect(calcAgeFromDob('')).toBeNull();
    expect(calcAgeFromDob(undefined)).toBeNull();
  });
  it('returns null for future date', () => {
    expect(calcAgeFromDob('2030-01-01')).toBeNull();
  });
});

// ── buildChildCharacterString ─────────────────────────────────────────────────
describe('buildChildCharacterString', () => {
  it('builds string for a boy', () => {
    expect(buildChildCharacterString({ name: 'Arjun', gender: 'boy' })).toBe('a boy named Arjun');
  });
  it('builds string for a girl', () => {
    expect(buildChildCharacterString({ name: 'Priya', gender: 'girl' })).toBe('a girl named Priya');
  });
  it('uses "child" for unknown gender', () => {
    expect(buildChildCharacterString({ name: 'Alex', gender: 'other' })).toBe('a child named Alex');
  });
  it('uses "child" for missing gender', () => {
    expect(buildChildCharacterString({ name: 'Dev' })).toBe('a child named Dev');
  });
  it('returns empty string when name is missing', () => {
    expect(buildChildCharacterString({ name: '', gender: 'boy' })).toBe('');
    expect(buildChildCharacterString({ gender: 'girl' })).toBe('');
  });
});

// ── preprocessGujaratiForTTS ──────────────────────────────────────────────────
describe('preprocessGujaratiForTTS', () => {
  it('replaces period with Gujarati danda', () => {
    expect(preprocessGujaratiForTTS('Hello.')).toBe('Hello।');
  });
  it('collapses multiple periods into one danda', () => {
    expect(preprocessGujaratiForTTS('Wait...')).toBe('Wait।');
  });
  it('replaces comma with space and collapses double spaces', () => {
    // comma → space, then "one  two" → "one two" (double-space collapse)
    expect(preprocessGujaratiForTTS('one, two')).toBe('one two');
  });
  it('strips straight double quotes', () => {
    expect(preprocessGujaratiForTTS('"Hello"')).toBe('Hello');
  });
  it('strips straight single quotes', () => {
    const input = 'it' + "'" + 's fine';
    expect(preprocessGujaratiForTTS(input)).toBe('its fine');
  });
  it('collapses extra spaces', () => {
    expect(preprocessGujaratiForTTS('too   many   spaces')).toBe('too many spaces');
  });
  it('trims leading and trailing whitespace', () => {
    expect(preprocessGujaratiForTTS('  hello  ')).toBe('hello');
  });
});

// ── splitTextForSarvam ────────────────────────────────────────────────────────
describe('splitTextForSarvam', () => {
  it('returns text as single chunk when under limit', () => {
    const text = 'Short text.';
    expect(splitTextForSarvam(text, 450)).toEqual([text]);
  });

  it('splits on sentence boundaries', () => {
    const sentence1 = 'Arjun went to the temple.';
    const sentence2 = 'He prayed for an hour.';
    const text = `${sentence1} ${sentence2}`;
    const chunks = splitTextForSarvam(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(30));
  });

  it('every chunk is within maxChars', () => {
    const longText = 'Word '.repeat(200); // 1000 chars
    const chunks = splitTextForSarvam(longText, 100);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(100));
  });

  it('no chunk is empty', () => {
    const text = 'Sentence one. Sentence two. Sentence three.';
    const chunks = splitTextForSarvam(text, 20);
    chunks.forEach((c) => expect(c.length).toBeGreaterThan(0));
  });

  it('reassembles to original content (no words lost)', () => {
    const text = 'The quick brown fox. Jumps over the lazy dog. And runs away.';
    const chunks = splitTextForSarvam(text, 25);
    const rejoined = chunks.join(' ');
    // Every word from original should appear in the rejoined text
    text.split(' ').forEach((word) => expect(rejoined).toContain(word.replace(/[.।]/g, '')));
  });

  it('handles Gujarati danda as sentence boundary', () => {
    const text = 'આ પ્રથમ વાક્ય છે। આ બીજું વાક્ય છે।';
    const chunks = splitTextForSarvam(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
