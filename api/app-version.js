// Vercel serverless function — serves the update manifest at /app-version.json
// (via a rewrite in vercel.json, so every already-installed app gets this
// dynamic version at the URL it has always fetched).
//
// iOS `latest` is looked up LIVE from the App Store (iTunes Lookup API) so a new
// release surfaces without a manual bump — BUT the lookup is edge-cached per region
// and can lag (Apple's API returned a stale 1.4 from Vercel's iad1 region while the
// store already showed 1.5). So we take the HIGHER of the static fallback and the
// live lookup: a stale lookup can never drag the version DOWN below the known-good
// fallback in app-version-defaults.json, while a genuinely newer release still wins.
// Keep app-version-defaults.json's `latest` current with each release.
const defaults = require('../app-version-defaults.json');

// Semver-ish compare: 1 if a>b, -1 if a<b, 0 if equal. Tolerates "1.5" vs "1.5.0".
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at the CDN for 30 min — a fresh release shows up within half an hour
  // without hammering Apple's API on every app launch.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  const out = JSON.parse(JSON.stringify(defaults));
  delete out._comment;

  const fallback = defaults.ios && defaults.ios.latest;
  let live = null;
  try {
    const id = defaults.ios && defaults.ios.appStoreId;
    if (id) {
      const r = await fetch(
        `https://itunes.apple.com/lookup?id=${id}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const data = await r.json();
        live = (data.results && data.results[0] && data.results[0].version) || null;
      }
    }
  } catch (e) {
    // Lookup failed/timed out — fall back to the static default silently.
    console.warn('itunes lookup failed:', e.message);
  }

  // Take the higher of fallback vs live — never let a stale lookup lower it.
  if (live && cmpVersion(live, fallback) > 0) out.ios.latest = live;

  if (req.query && req.query.debug) {
    out._diag = { fallback, live, chosen: out.ios.latest, region: process.env.VERCEL_REGION || null };
  }

  res.status(200).json(out);
};
