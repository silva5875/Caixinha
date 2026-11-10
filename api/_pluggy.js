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

// Gate antigo por token fixo (mantido por compatibilidade).
export function authed(req) {
  const need = process.env.APP_TOKEN;
  if (!need) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${need}`;
}

// Autorização automática: aceita o APP_TOKEN (dono) OU um token de sessão válido
// do Supabase (qualquer usuário logado com Google no seu projeto). Assim um amigo
// só precisa entrar com o Google — nada de configurar token na mão.
export async function authorize(req) {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return false;
  if (process.env.APP_TOKEN && tok === process.env.APP_TOKEN) return true;
  const u = process.env.SUPABASE_URL, k = process.env.SUPABASE_ANON_KEY;
  if (!u || !k) return false;
  try {
    const r = await fetch(`${u}/auth/v1/user`, { headers: { apikey: k, Authorization: "Bearer " + tok } });
    return r.ok; // 200 = token de usuário logado válido
  } catch (e) {
    return false;
  }
}
