// Live token feed (Creations / Graduating / Graduated) backed by the Solana
// Tracker Data API. Replaces the previously-embedded Raze iframe's
// proprietary, PoW-gated, undocumented data source with our own.
//
// SECURITY: the API key lives here, server-side, and is never sent to the
// browser — the frontend calls our /api/feed/* routes, which proxy through
// this in-memory cache.
//
// Free-tier budget: 10,000 requests/month, 3 req/sec. The default poll
// interval (15 min) across 3 endpoints works out to ~8,640 requests/month,
// leaving headroom under the cap. Tune via SOLANA_TRACKER_POLL_INTERVAL_MS
// if the plan changes.

const SOLANA_TRACKER_BASE =
  process.env.SOLANA_TRACKER_BASE_URL || 'https://data.solanatracker.io';
// SECURITY: never hardcode a real key. Provide SOLANA_TRACKER_API_KEY via the
// environment (.env is git-ignored).
const SOLANA_TRACKER_API_KEY = process.env.SOLANA_TRACKER_API_KEY || '';
const POLL_INTERVAL_MS =
  parseInt(process.env.SOLANA_TRACKER_POLL_INTERVAL_MS, 10) || 15 * 60 * 1000;

const FEEDS = {
  creations: '/tokens/latest',
  graduating: '/tokens/multi/graduating?limit=100',
  graduated: '/tokens/multi/graduated?limit=100',
};

const cache = {
  creations: { data: [], updatedAt: null, error: null },
  graduating: { data: [], updatedAt: null, error: null },
  graduated: { data: [], updatedAt: null, error: null },
};

const fetchFeed = async (name, path) => {
  const url = `${SOLANA_TRACKER_BASE}${path}`;
  try {
    const response = await fetch(url, {
      headers: { 'x-api-key': SOLANA_TRACKER_API_KEY },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    cache[name] = { data, updatedAt: new Date().toISOString(), error: null };
  } catch (err) {
    // Keep the last-known-good data on a transient failure; only record the
    // error. Never silently wipe a working feed just because one poll failed.
    cache[name] = { ...cache[name], error: err.message };
    console.warn(`[solanaTrackerFeed] ${name} poll failed:`, err.message);
  }
};

const pollAll = () =>
  Promise.all(Object.entries(FEEDS).map(([name, path]) => fetchFeed(name, path)));

let pollTimer = null;

const startPolling = () => {
  if (!SOLANA_TRACKER_API_KEY) {
    console.warn(
      '[solanaTrackerFeed] SOLANA_TRACKER_API_KEY not set — /api/feed/* will report unconfigured.',
    );
    return;
  }
  if (pollTimer) return;
  pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
};

// A feed is "stale" once it's more than 2 poll cycles old — lets the
// frontend flag outdated data instead of silently presenting it as fresh.
const getFeedSnapshot = (name) => {
  if (!SOLANA_TRACKER_API_KEY) {
    return { data: [], updatedAt: null, error: 'SOLANA_TRACKER_API_KEY not configured', stale: true };
  }
  const entry = cache[name];
  if (!entry) return null;
  const staleAfterMs = POLL_INTERVAL_MS * 2;
  const stale = !entry.updatedAt || Date.now() - new Date(entry.updatedAt).getTime() > staleAfterMs;
  return { ...entry, stale };
};

module.exports = { startPolling, getFeedSnapshot, POLL_INTERVAL_MS };
