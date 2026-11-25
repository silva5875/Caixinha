import webpush from "web-push";
import { cors, authorize } from "./_pluggy.js";

function initVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:caixa@exemplo.com";
  if (!pub || !priv) throw new Error("faltam VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no servidor");
  webpush.setVapidDetails(subject, pub, priv);
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  if (!(await authorize(req))) return res.status(401).json({ error: "não autorizado" });

  try { initVapid(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }

  const action = req.body?.action || "test";

  if (action === "test") {
    const sub = req.body?.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "envie 'subscription'" });
    const payload = JSON.stringify({ title: "Caixa", body: "Notificações ativadas! Tudo certo por aqui.", url: "/" });
    try {
      await webpush.sendNotification(sub, payload);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: "falha ao enviar push: " + (e.statusCode || "") + " " + String(e.body || e.message || e) });
    }
  }

  return res.status(400).json({ error: "ação desconhecida" });
}
