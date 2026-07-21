import { describe, it, expect } from 'vitest';
const AppUtils = require('../utils.js');

const NOW = new Date(2026, 6, 20, 14, 30); // Jul 20 2026, 14:30 local

describe('buildApiUsageSeries', () => {
  const docs = [
    { id: '2026-07-20', data: { '13': { drive: 5, r2: 2 }, '14': { drive: 1 } } },
    { id: '2026-07-19', data: { '22': { gemini: 3 } } },
    { id: '2026-07-01', data: { '08': { tts: 7 } } },
  ];

  it('24h mode: hourly buckets ending at now, correct lookups', () => {
    const { labels, buckets, apis } = AppUtils.buildApiUsageSeries(docs, '24h', NOW);
    expect(labels).toHaveLength(24);
    expect(labels[23]).toBe('14:00');
    expect(buckets[23]).toEqual({ drive: 1 });
    expect(buckets[22]).toEqual({ drive: 5, r2: 2 });
    // yesterday 22:00 is 16h before 14:00 → index 23-16=7
    expect(buckets[7]).toEqual({ gemini: 3 });
    expect(apis[0]).toBe('drive'); // largest total first
  });

  it('7d mode: daily sums; too-old days excluded', () => {
    const { labels, buckets, totals } = AppUtils.buildApiUsageSeries(docs, '7d', NOW);
    expect(labels).toHaveLength(7);
    expect(labels[6]).toBe('7/20');
    expect(buckets[6]).toEqual({ drive: 6, r2: 2 });
    expect(buckets[5]).toEqual({ gemini: 3 });
    expect(totals.tts).toBeUndefined(); // Jul 1 outside 7d window
  });

  it('30d mode includes the old day', () => {
    const { totals } = AppUtils.buildApiUsageSeries(docs, '30d', NOW);
    expect(totals.tts).toBe(7);
  });

  it('empty docs → zeroed series', () => {
    const { labels, buckets, apis } = AppUtils.buildApiUsageSeries([], '24h', NOW);
    expect(labels).toHaveLength(24);
    expect(buckets.every((b) => Object.keys(b).length === 0)).toBe(true);
    expect(apis).toEqual([]);
  });
});
