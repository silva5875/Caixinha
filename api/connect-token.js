import { apiKey, pluggyFetch, cors, authed } from "./_pluggy.js";

// POST /api/connect-token
// Issues a short-lived (30 min) connect token for the Pluggy Connect widget.
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  try {
    const key = await apiKey();
    const body = {};
    if (process.env.WEBHOOK_URL) body.options = { webhookUrl: process.env.WEBHOOK_URL };

    const r = await pluggyFetch("/connect_token", key, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);

    // The widget expects this value as `connectToken`.
    return res.status(200).json({ accessToken: d.accessToken });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
