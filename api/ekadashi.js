// Vercel serverless function — scrapes BAPS calendar for Ekadashi fasting days.
//
// Two-source strategy:
//  1. Monthly calendar pages  → name + fast type (most dates)
//  2. EkadashiNomPunam.aspx  → authoritative date list used to catch dates
//     the monthly page omits (e.g. Sep 22 2026 where BAPS skips the tooltip)
//
// Fast markers: "(Fast)" or "Nirjal Upvas" / "Nirjala Upvas" (BAPS spells it both ways)

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
const MONTH_MAP = {
  Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6,
  Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=64800');

  const now      = new Date();
  const todayStr = toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());

  // ── 1. Scrape monthly pages (current + next 2 months) ──────────────────────
  const monthlyResults = {}; // date → { name, fastType }

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
          monthlyResults[dateStr] = { name, fastType };
        }
      }
    } catch (e) {
      console.error(`Monthly scrape failed for ${monthName}:`, e.message);
    }
  }

  // ── 2. Scrape EkadashiNomPunam.aspx — authoritative date list ──────────────
  // Catches dates the monthly page omits (like Sep 22 2026).
  const authDates = new Set();
  const yearsToFetch = new Set([now.getFullYear()]);
  if (now.getMonth() >= 10) yearsToFetch.add(now.getFullYear() + 1); // Nov/Dec → also next year

  for (const year of yearsToFetch) {
    try {
      const resp = await fetch(
        `https://www.baps.org/Calendar/${year}/EkadashiNomPunam.aspx`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mySanskar/1.0)' } }
      );
      if (!resp.ok) continue;
      const html = await resp.text();

      // Pattern: "Sep 22:&nbsp;&nbsp;\n  Bhadarvo Sud Ekadashi"
      const re = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}):[\s\S]{1,70}?(?:Vad|Sud)\s+Ekadashi/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const monthNum = MONTH_MAP[m[1]];
        const day      = parseInt(m[2], 10);
        authDates.add(toDateStr(year, monthNum, day));
      }
    } catch (e) {
      console.error('EkadashiNomPunam scrape failed:', e.message);
    }
  }

  // ── 3. Merge — auth dates fill gaps left by monthly scraping ───────────────
  // Compute the 3-month lookahead window end
  const windowEnd = toDateStr(
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getFullYear(),
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getMonth() + 1,
    new Date(now.getFullYear(), now.getMonth() + 3, 0).getDate()
  );

  for (const date of authDates) {
    if (date < todayStr || date > windowEnd) continue;
    if (!monthlyResults[date]) {
      // Monthly page had no fast tooltip for this date — add with generic name
      monthlyResults[date] = { name: 'Ekadashi', fastType: 'Fast' };
    }
  }

  // ── 4. Sort, deduplicate, add daysAway ─────────────────────────────────────
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  const results = Object.entries(monthlyResults)
    .map(([date, { name, fastType }]) => {
      const [yr, mo, dy] = date.split('-').map(Number);
      const daysAway = Math.round((Date.UTC(yr, mo - 1, dy) - todayMs) / 86400000);
      return { date, name, fastType, daysAway };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  res.status(200).json(results);
};

function toDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
