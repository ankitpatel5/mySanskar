// Vercel serverless function — scrapes BAPS calendar for Ekadashi fasting days.
// Pattern: day tooltip contains "Ekadashi" + ("(Fast)" OR "Nirjala Upvas")
//
// Previous split-based approach broke because html.split('<div class="cal_date')
// also splits on the inner <div class="cal_date_no"> day-number div, so the day
// number ended up in the wrong fragment. This version uses a window search around
// each tooltip match position instead — no dependencies needed.

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=64800');

  const now      = new Date();
  const todayStr = toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const results  = [];

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

      // Find every Ekadashi fast tooltip using a global regex.
      // Then for each match, search a window of nearby HTML for the day number —
      // this avoids the cal_date_no split-boundary problem.
      const tooltipRe = /data-tooltip="([^"]*Ekadashi[^"]*(?:\(Fast\)|Nirjala Upvas)[^"]*)"/g;
      let m;
      while ((m = tooltipRe.exec(html)) !== null) {
        const tooltip  = m[1];
        const matchPos = m.index;

        // Search a 600-char window around this tooltip for the day number.
        // cal_date_no (weekdays) or cal_date_Sun (Sundays) holds the day digit.
        const winStart = Math.max(0, matchPos - 100);
        const winEnd   = Math.min(html.length, matchPos + 600);
        const window   = html.slice(winStart, winEnd);

        const dayMatch = window.match(/cal_date_(?:no|Sun)"[^>]*>(\d+)</);
        if (!dayMatch) continue;
        const day = parseInt(dayMatch[1], 10);
        if (!day) continue;

        // Extract named Ekadashi:
        //   "… Ekadashi Apara Ekadashi (Fast)"
        //   "… Ekadashi/Baras Yogini Ekadashi (Fast)"
        //   "… Ekadashi Devshayani Ekadashi - Nirjala Upvas …"
        const nameMatch = tooltip.match(
          /Ekadashi(?:\/\w+)?\s+([A-Za-z][\w\s-]*Ekadashi)\s*[-–]?\s*(?:Nirjala Upvas|\(Fast\))/
        );
        const name     = nameMatch ? nameMatch[1].trim() : 'Ekadashi';
        const fastType = tooltip.includes('Nirjala Upvas') ? 'Nirjala Upvas' : 'Fast';

        const dateStr = toDateStr(year, monthNum, day);
        if (dateStr >= todayStr) {
          results.push({ date: dateStr, name, fastType });
        }
      }
    } catch (e) {
      console.error(`BAPS fetch failed for ${year}/${monthName}:`, e.message);
    }
  }

  // Sort ascending, deduplicate by date
  results.sort((a, b) => a.date.localeCompare(b.date));
  const seen   = new Set();
  const unique = results.filter((r) => {
    if (seen.has(r.date)) return false;
    seen.add(r.date);
    return true;
  });

  // Compute daysAway relative to today (UTC-safe)
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  unique.forEach((r) => {
    const [yr, mo, dy] = r.date.split('-').map(Number);
    r.daysAway = Math.round((Date.UTC(yr, mo - 1, dy) - todayMs) / 86400000);
  });

  res.status(200).json(unique);
};

function toDateStr(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
