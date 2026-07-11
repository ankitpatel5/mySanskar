import { describe, it, expect } from 'vitest';
const { virtualChapterIdxForPos } = require('../utils.js');

// Single-file audiobooks are split into virtual Parts (startTime/endTime offsets
// into one file). A ±30s seek can cross a Part boundary: the audio position is
// right but the UI must re-derive which Part it's in. This resolver is that
// derivation — the -30s-at-start-of-Part-2 tracker desync came from its absence.
const parts = (secs, total) => {
  const out = [];
  for (let i = 0; i < Math.ceil(total / secs); i++) {
    out.push({ id: `f_vp${i}`, startTime: i * secs, endTime: Math.min((i + 1) * secs, total) });
  }
  return out;
};

describe('virtualChapterIdxForPos', () => {
  const chs = parts(1800, 5400); // 3 parts: [0,1800) [1800,3600) [3600,5400)

  it('THE BUG: 3s into Part 2, -30s → lands in Part 1', () => {
    expect(virtualChapterIdxForPos(chs, 1803 - 30, 1)).toBe(0);
  });
  it('+30s near end of Part 1 → lands in Part 2', () => {
    expect(virtualChapterIdxForPos(chs, 1795 + 30, 0)).toBe(1);
  });
  it('stays put when the seek does not cross', () => {
    expect(virtualChapterIdxForPos(chs, 900, 0)).toBe(0);
    expect(virtualChapterIdxForPos(chs, 2000, 1)).toBe(1);
  });
  it('boundary belongs to the NEXT part (start-inclusive, end-exclusive)', () => {
    expect(virtualChapterIdxForPos(chs, 1800, 0)).toBe(1);
    expect(virtualChapterIdxForPos(chs, 3599.9, 1)).toBe(1);
  });
  it('clamps: before first part → 0, past final end → last', () => {
    expect(virtualChapterIdxForPos(chs, -5, 2)).toBe(0);
    expect(virtualChapterIdxForPos(chs, 99999, 0)).toBe(2);
  });
  it('real (multi-file) chapters have no startTime → fallback unchanged', () => {
    const real = [{ id: 'ch1' }, { id: 'ch2' }];
    expect(virtualChapterIdxForPos(real, 500, 1)).toBe(1);
  });
  it('tolerates empty/garbage input', () => {
    expect(virtualChapterIdxForPos([], 10, 4)).toBe(4);
    expect(virtualChapterIdxForPos(null, 10, 2)).toBe(2);
  });
  it('final part with open endTime still resolves', () => {
    const open = [{ startTime: 0, endTime: 100 }, { startTime: 100 }];
    expect(virtualChapterIdxForPos(open, 250, 0)).toBe(1);
  });
});
