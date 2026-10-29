// Shared helpers for the Pluggy backend.
// The CLIENT_SECRET lives ONLY here, on the server, read from environment variables.

const PLUGGY = "https://api.pluggy.ai";

// Cache the API key in memory for the lifetime of a warm function instance.
let cache = { key: null, exp: 0 };

export async function apiKey() {
  if (cache.key && Date.now() < cache.exp) return cache.key;
  const r = await fetch(`${PLUGGY}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Pluggy /auth falhou (${r.status}): ${t}`);
  }
  const d = await r.json();
  // API key is valid for 2h; refresh a bit early.
  cache = { key: d.apiKey, exp: Date.now() + 100 * 60 * 1000 };
  return d.apiKey;
}

export function pluggyFetch(path, key, init = {}) {
  return fetch(`${PLUGGY}${path}`, {
    ...init,
    headers: { "X-API-KEY": key, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// Minimal CORS. Set ALLOWED_ORIGIN to your site to lock it down (default: any).
export function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// Simple shared-secret gate so only your app can call these endpoints.
// Set APP_TOKEN in the environment and in the app's Open Finance settings.
export function authed(req) {
  const need = process.env.APP_TOKEN;
  if (!need) return true; // no token configured -> open (fine for quick tests only)
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${need}`;
}
