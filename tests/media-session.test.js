import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const {
  MS_ACTION_MAP, resolveMediaAction, msShouldApply,
  buildMediaSessionMeta, computeAbPositionState,
} = require('../utils.js');

// One source at a time owns navigator.mediaSession. The CarPlay bug: while an
// audiobook played, lock-screen/CarPlay showed the last MUSIC track and its
// buttons controlled the paused music player. These tests lock down the
// routing matrix, the metadata contract, the scrubber math, the pause-race
// guard — and (below) the app.js wiring itself.

describe('resolveMediaAction — routing matrix', () => {
  it('THE BUG as an assertion: audiobook pause routes to the AUDIOBOOK, never music', () => {
    expect(resolveMediaAction('audiobook', 'pause')).toBe('ab.toggle');
    expect(resolveMediaAction('audiobook', 'pause')).not.toBe('music.toggle');
  });
  it('per-source commands', () => {
    expect(resolveMediaAction('music', 'nexttrack')).toBe('music.next');
    expect(resolveMediaAction('audiobook', 'seekbackward')).toBe('ab.back30');
    expect(resolveMediaAction('tts', 'play')).toBe('tts.toggle');
  });
  it('nulled slots and unknowns resolve to null', () => {
    expect(resolveMediaAction('tts', 'nexttrack')).toBeNull();
    expect(resolveMediaAction('audiobook', 'previoustrack')).toBeNull();
    expect(resolveMediaAction('ghost', 'play')).toBeNull();
    expect(resolveMediaAction('music', 'teleport')).toBeNull();
  });
});

describe('MS_ACTION_MAP — slot discipline', () => {
  const SUPERSET = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'];
  for (const src of ['music', 'audiobook', 'tts']) {
    it(`${src} declares every slot (null = explicit clear)`, () => {
      expect(Object.keys(MS_ACTION_MAP[src]).sort()).toEqual([...SUPERSET].sort());
    });
  }
  it('audiobook trades prev/next for ±30s (iOS slots compete)', () => {
    expect(MS_ACTION_MAP.audiobook.seekbackward).toBeTruthy();
    expect(MS_ACTION_MAP.audiobook.seekforward).toBeTruthy();
    expect(MS_ACTION_MAP.audiobook.previoustrack).toBeNull();
    expect(MS_ACTION_MAP.audiobook.nexttrack).toBeNull();
  });
  it('music is the inverse; tts is play/pause only', () => {
    expect(MS_ACTION_MAP.music.previoustrack).toBeTruthy();
    expect(MS_ACTION_MAP.music.seekbackward).toBeNull();
    expect(MS_ACTION_MAP.tts.seekforward).toBeNull();
  });
});

describe('msShouldApply — the pause-race guard', () => {
  it('a dying source may not stamp over the new owner', () => {
    expect(msShouldApply('music', 'audiobook')).toBe(false);
  });
  it('the owner may', () => expect(msShouldApply('audiobook', 'audiobook')).toBe(true));
  it('no owner → no stamping', () => expect(msShouldApply('music', null)).toBe(false));
});

describe('buildMediaSessionMeta — metadata contract', () => {
  it('music mirrors the track verbatim', () => {
    expect(buildMediaSessionMeta('music', { name: 'Arti', albumName: 'Arti' }))
      .toEqual({ title: 'Arti', artist: 'Arti', album: 'Arti' });
  });
  it('virtual part → book title + "Part N of M"', () => {
    const book = { name: 'Solid Starts', chapters: [{ realId: 'f', startTime: 0 }, { realId: 'f', startTime: 1800 }, { realId: 'f', startTime: 3600 }] };
    expect(buildMediaSessionMeta('audiobook', { book, idx: 1 }))
      .toEqual({ title: 'Solid Starts', artist: 'Part 2 of 3', album: 'Solid Starts' });
  });
  it('real chapter → chapter name + "Chapter N of M"', () => {
    const book = { name: 'B', chapters: [{ id: 'c1', name: 'Intro' }, { id: 'c2', name: 'Ch 2' }] };
    expect(buildMediaSessionMeta('audiobook', { book, idx: 0 }))
      .toEqual({ title: 'Intro', artist: 'Chapter 1 of 2', album: 'B' });
  });
  it('single-chapter book → empty artist (no "1 of 1")', () => {
    const book = { name: 'B', chapters: [{ id: 'c1', name: 'B' }] };
    expect(buildMediaSessionMeta('audiobook', { book, idx: 0 }).artist).toBe('');
  });
  it('never returns undefined fields', () => {
    for (const [src, info] of [['music', {}], ['audiobook', { book: { chapters: [] }, idx: 0 }], ['tts', {}]]) {
      const m = buildMediaSessionMeta(src, info);
      for (const v of Object.values(m)) expect(typeof v).toBe('string');
    }
  });
  it('tts → story title / Story time / mySanskar', () => {
    expect(buildMediaSessionMeta('tts', { title: 'The Honest Woodcutter' }))
      .toEqual({ title: 'The Honest Woodcutter', artist: 'Story time', album: 'mySanskar' });
  });
});

describe('computeAbPositionState — scrubber math', () => {
  it('position is part-relative', () => {
    expect(computeAbPositionState({ currentTime: 3720, duration: 9000, startTime: 3600, endTime: 5400, playbackRate: 1 }))
      .toEqual({ duration: 1800, position: 120, playbackRate: 1 });
  });
  it('clamps below chStart and past chEnd', () => {
    expect(computeAbPositionState({ currentTime: 3590, duration: 9000, startTime: 3600, endTime: 5400 }).position).toBe(0);
    expect(computeAbPositionState({ currentTime: 5500, duration: 9000, startTime: 3600, endTime: 5400 }).position).toBe(1800);
  });
  it('passes playbackRate through (scrubber drifts at 1.25x otherwise)', () => {
    expect(computeAbPositionState({ currentTime: 10, duration: 100, startTime: 0, endTime: 100, playbackRate: 1.25 }).playbackRate).toBe(1.25);
  });
  it('null on non-finite inputs (setPositionState throws on them)', () => {
    expect(computeAbPositionState({ currentTime: 10, duration: NaN, startTime: 0, endTime: undefined })).toBeNull();
    expect(computeAbPositionState({ currentTime: 10, duration: Infinity, startTime: 0, endTime: Infinity })).toBeNull();
    expect(computeAbPositionState({ currentTime: NaN, duration: 100, startTime: 0, endTime: 100 })).toBeNull();
    expect(computeAbPositionState({ currentTime: 10, duration: 100, startTime: 100, endTime: 100 })).toBeNull();
  });
});

// ── Wiring guard — a play path can't ship without claiming the session ──────
describe('app.js wiring — media-session router', () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8');

  it('router exists on top of the pure logic', () => {
    expect(appSrc).toMatch(/function msClaim\s*\(/);
    expect(appSrc).toMatch(/AppUtils\.resolveMediaAction\(/);
    expect(appSrc).toMatch(/AppUtils\.msShouldApply\(/);
  });
  it('music claims + stamps pause', () => {
    expect(appSrc.includes("msClaim('music')")).toBe(true);
    expect(appSrc.includes("msPaused('music')")).toBe(true);
  });
  it('audiobook claims + stamps pause', () => {
    expect(appSrc.includes("msClaim('audiobook')")).toBe(true);
    expect(appSrc.includes("msPaused('audiobook')")).toBe(true);
  });
  it('tts claims at start, resume AND every paragraph element (≥5 sites)', () => {
    expect(appSrc.split("msClaim('tts')").length - 1).toBeGreaterThanOrEqual(5);
    expect(appSrc.includes("msPaused('tts')")).toBe(true);
  });
  it('the static music-only handlers (the literal bug) are GONE', () => {
    expect(appSrc.includes("setActionHandler('play', () => togglePlay())")).toBe(false);
  });
  it('updateMediaSession can no longer overwrite another source', () => {
    const i = appSrc.indexOf('function updateMediaSession');
    expect(appSrc.slice(i, i + 400)).toMatch(/_msSource\s*&&\s*_msSource\s*!==\s*'music'/);
  });
});
