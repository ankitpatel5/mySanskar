// Vercel serverless function — serves the update manifest at /app-version.json
// (via a rewrite in vercel.json, so every already-installed app gets this
// dynamic version at the URL it has always fetched).
//
// iOS `latest` is looked up LIVE from the App Store (iTunes Lookup API), so
// nobody has to remember to bump the manifest when a release is approved —
// Apple is the source of truth. `app-version-defaults.json` provides the
// fallback values (and Android, which has no public version API).
const defaults = require('../app-version-defaults.json');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at the CDN for 30 min — a fresh release shows up within half an hour
  // without hammering Apple's API on every app launch.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  const out = JSON.parse(JSON.stringify(defaults));
  delete out._comment;

  try {
    const id = defaults.ios && defaults.ios.appStoreId;
    if (id) {
      const r = await fetch(
        `https://itunes.apple.com/lookup?id=${id}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const data = await r.json();
        const live = data.results && data.results[0] && data.results[0].version;
        if (live) out.ios.latest = live; // live App Store version wins
      }
    }
  } catch (e) {
    // Lookup failed/timed out — fall back to the static defaults silently.
    console.warn('itunes lookup failed:', e.message);
  }

  res.status(200).json(out);
};
