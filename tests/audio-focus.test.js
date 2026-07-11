import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { enforceSingleAudio } = require('../utils.js');

// ── The single-audio rule ────────────────────────────────────────────────────
// Music, audiobook, and story TTS must be mutually exclusive. This regressed
// once (music + story TTS played simultaneously) because TTS was left out of
// the cross-stop wiring. These tests lock down BOTH layers:
//   1. the pure exclusion logic (enforceSingleAudio)
//   2. the app.js wiring (every play path must call stopAllOtherAudio)

const SOURCES = ['music', 'audiobook', 'tts'];

function makeHandles(playingSet) {
  const handles = {};
  for (const name of SOURCES) {
    handles[name] = {
      playing: vi.fn(() => playingSet.includes(name)),
      stop: vi.fn(),
    };
  }
  return handles;
}

describe('enforceSingleAudio — exclusion matrix', () => {
  // Every ordered pair: starting X while Y is playing must stop Y.
  for (const starting of SOURCES) {
    for (const other of SOURCES.filter((s) => s !== starting)) {
      it(`starting ${starting} stops a playing ${other}`, () => {
        const h = makeHandles([other]);
        const stopped = enforceSingleAudio(starting, h);
        expect(h[other].stop).toHaveBeenCalledTimes(1);
        expect(stopped).toContain(other);
      });
    }
  }

  it('stops BOTH others when both are playing (worst case)', () => {
    for (const starting of SOURCES) {
      const others = SOURCES.filter((s) => s !== starting);
      const h = makeHandles(others);
      const stopped = enforceSingleAudio(starting, h);
      for (const o of others) expect(h[o].stop).toHaveBeenCalledTimes(1);
      expect(stopped.sort()).toEqual(others.sort());
    }
  });

  it('never stops the source that is starting', () => {
    for (const starting of SOURCES) {
      const h = makeHandles(SOURCES); // everything "playing"
      enforceSingleAudio(starting, h);
      expect(h[starting].stop).not.toHaveBeenCalled();
    }
  });

  it('does not stop sources that are not playing', () => {
    const h = makeHandles([]); // nothing playing
    const stopped = enforceSingleAudio('music', h);
    expect(h.audiobook.stop).not.toHaveBeenCalled();
    expect(h.tts.stop).not.toHaveBeenCalled();
    expect(stopped).toEqual([]);
  });

  it('a throwing source does not prevent stopping the rest', () => {
    const h = makeHandles(['audiobook', 'tts']);
    h.audiobook.stop.mockImplementation(() => { throw new Error('boom'); });
    const stopped = enforceSingleAudio('music', h);
    expect(h.tts.stop).toHaveBeenCalledTimes(1); // still stopped
    expect(stopped).toContain('tts');
  });

  it('tolerates missing/null handles and empty input', () => {
    expect(() => enforceSingleAudio('music', null)).not.toThrow();
    expect(() => enforceSingleAudio('music', { tts: null })).not.toThrow();
    expect(enforceSingleAudio('music', {})).toEqual([]);
  });
});

// ── Wiring guard ─────────────────────────────────────────────────────────────
// The pure logic being correct is not enough — the original regression was a
// play path that never CALLED the rule. Assert every play path in app.js is
// wired. If one of these fails, a play path lost its stopAllOtherAudio call.
describe('app.js wiring — every play path calls stopAllOtherAudio', () => {
  const appSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'app.js'), 'utf8'
  );

  it('defines the choke point on top of AppUtils.enforceSingleAudio', () => {
    expect(appSrc).toMatch(/function stopAllOtherAudio\s*\(/);
    expect(appSrc).toMatch(/AppUtils\.enforceSingleAudio\(/);
  });

  it('music play path is wired', () => {
    expect(appSrc.includes("stopAllOtherAudio('music')")).toBe(true);
  });

  it('audiobook play path is wired', () => {
    expect(appSrc.includes("stopAllOtherAudio('audiobook')")).toBe(true);
  });

  it('TTS start AND resume paths are wired', () => {
    const ttsCalls = appSrc.split("stopAllOtherAudio('tts')").length - 1;
    expect(ttsCalls).toBeGreaterThanOrEqual(2); // startTTS + resumeTTS
  });

  it('the choke point covers all three sources', () => {
    // The handle map must name all three — losing one silently recreates the bug.
    const chokeIdx = appSrc.indexOf('function stopAllOtherAudio');
    const block = appSrc.slice(chokeIdx, chokeIdx + 1200);
    for (const src of SOURCES) expect(block.includes(`${src}:`)).toBe(true);
  });
});
