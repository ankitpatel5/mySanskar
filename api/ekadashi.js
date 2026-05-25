// Vercel serverless function — scrapes BAPS calendar for Ekadashi fasting days.
//
// Source: monthly BAPS calendar pages (current + next 2 months).
// Fast markers: "(Fast)" or "Nirjal Upvas" / "Nirjala Upvas" (BAPS spells it both ways)
//
// Known gaps — dates the monthly page omits entirely (no tooltip at all).
// Add new entries here whenever a future year has a missing date.
const KNOWN_GAPS = {
  '2026-09-22': { name: 'Bhadarvo Sud Ekadashi', fastType: 'Fast' },
  '2026-11-21': { name: 'Prabodhini Ekadashi',   fastType: 'Nirjala Upvas' },
};

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=64800');

  const now      = new Date();
  const todayStr = toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());

  // ── 1. Scrape monthly pages (current + next 2 months) ──────────────────────
  const results = {}; // date → { name, fastType }

  for (let offset = 0; offset <= 2; offset++) {
    const d         = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const year      = d.getFullYear();
    const monthName = MONTH_NAMES[d.getMonth()];
    const monthNum  = d.getMonth() + 1;

    try {
      const resp = await fetch(
        `https://www.baps.org/Calendar/${year}/${monthName}.aspx`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mySanskar/1.0)' } }
      );
      if (!resp.ok) continue;
      const html = await resp.text();

      // Each Ekadashi fast tooltip contains "Ekadashi" + "(Fast)" or "Nirjal[a] Upvas"
      const tooltipRe = /data-tooltip="([^"]*Ekadashi[^"]*(?:Nirjala?\s+Upvas|\(Fast\))[^"]*)"/g;
      let m;
      while ((m = tooltipRe.exec(html)) !== null) {
        const tooltip  = m[1];
        const matchPos = m.index;

        // Search a 600-char window around the tooltip for the day number
        const winStart = Math.max(0, matchPos - 100);
        const winEnd   = Math.min(html.length, matchPos + 600);
        const window   = html.slice(winStart, winEnd);

        const dayMatch = window.match(/cal_date_(?:no|Sun)"[^>]*>(\d+)</);
        if (!dayMatch) continue;
        const day = parseInt(dayMatch[1], 10);
        if (!day) continue;

        // Extract named Ekadashi from tooltip
        // e.g. "Jeth Vad Ekadashi/Baras Yogini Ekadashi (Fast)"
        //   → "Yogini Ekadashi"
        // e.g. "Kartak Sud Ekadashi/Baras Prabodhini Ekadashi - Nirjal Upvas …"
        //   → "Prabodhini Ekadashi"
        const nameMatch = tooltip.match(
          /Ekadashi(?:\/\w+)?\s+([A-Za-z][\w\s-]*Ekadashi)\s*[-–]?\s*(?:Nirjala?\s+Upvas|\(Fast\))/
        );
        const name     = nameMatch ? nameMatch[1].trim() : 'Ekadashi';
        const fastType = tooltip.includes('Upvas') ? 'Nirjala Upvas' : 'Fast';

        const dateStr = toDateStr(year, monthNum, day);
        if (dateStr >= todayStr) {
          results[dateStr] = { name, fastType };
        }
      }
    } catch (e) {
      console.error(`Monthly scrape failed for ${monthName}:`, e.message);
    }
  }

  // ── 2. Fill known gaps ─────────────────────────────────────────────────────
  // These are dates the monthly BAPS page omits entirely (no tooltip exists).
  const windowEnd = toDateStr(
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getFullYear(),
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getMonth() + 1,
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getDate()
  );

  for (const [date, info] of Object.entries(KNOWN_GAPS)) {
    if (date >= todayStr && date <= windowEnd && !results[date]) {
      results[date] = info;
    }
  }

  // ── 3. Sort and add daysAway ───────────────────────────────────────────────
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  const sorted = Object.entries(results)
    .map(([date, { name, fastType }]) => {
      const [yr, mo, dy] = date.split('-').map(Number);
      const daysAway = Math.round((Date.UTC(yr, mo - 1, dy) - todayMs) / 86400000);
      return { date, name, fastType, daysAway };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  res.status(200).json(sorted);
};

function toDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
