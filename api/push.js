import webpush from "web-push";
import { cors, authorize } from "./_pluggy.js";

const SB_URL = process.env.SUPABASE_URL;
const SB_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

function initVapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:caixa@exemplo.com";
  if (!pub || !priv) throw new Error("faltam VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
  webpush.setVapidDetails(subject, pub, priv);
}
function brl(n) { return "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function sbHeaders() { return { apikey: SB_SECRET, Authorization: "Bearer " + SB_SECRET, "Content-Type": "application/json" }; }
async function sbSelect(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("supabase " + r.status + ": " + (await r.text()));
  return r.json();
}
async function sbDelete(path) { try { await fetch(`${SB_URL}/rest/v1/${path}`, { method: "DELETE", headers: sbHeaders() }); } catch (_) {} }

async function userFromToken(req) {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return null;
  const u = process.env.SUPABASE_URL, k = process.env.SUPABASE_ANON_KEY;
  if (!u || !k) return null;
  try {
    const r = await fetch(`${u}/auth/v1/user`, { headers: { apikey: k, Authorization: "Bearer " + tok } });
    if (!r.ok) return null;
    const d = await r.json();
    return { id: d.id, email: d.email };
  } catch (e) { return null; }
}
async function sendTo(userId, payloadObj) {
  const subs = await sbSelect(`push_subscriptions?user_id=eq.${userId}&select=endpoint,p256dh,auth`);
  const payload = JSON.stringify(payloadObj);
  let sent = 0;
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try { await webpush.sendNotification(sub, payload); sent++; }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) await sbDelete(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`); }
  }
  return sent;
}

// ---- lembretes a partir do app_state (jsonb) de cada usuário ----
function parseD(s) { const p = String(s || "").split("-").map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
function quando(dd) { return dd === 0 ? "hoje" : (dd === 1 ? "amanhã" : "em " + dd + " dias"); }
function remindersFor(data, mode) {
  if (!data || data.notifOff) return [];
  const evening = mode === "evening";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dUntil = (day) => { let d = new Date(today.getFullYear(), today.getMonth(), Math.min(day, 28)); if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(day, 28)); return Math.round((d - today) / 86400000); };
  const cards = data.cards || [], tx = data.transactions || [], fixos = data.fixos || [];
  const cardInvoice = (cid) => tx.reduce((s, t) => (t.card === cid && t.type === "expense" && !t.paid && !t.previsto) ? s + (+t.amount || 0) : s, 0);
  const payDay = (() => { const v = parseInt(data.payDay); return Number.isFinite(v) && v >= 1 && v <= 28 ? v : 0; })();
  const out = [];

  // fatura fechando (útil nos dois modos; só de manhã)
  if (!evening) cards.forEach((c) => { if (c.closingDay) { const dd = dUntil(c.closingDay); if (dd <= 2) out.push({ tag: "fecha-" + c.id, title: "Fatura do " + (c.name || "cartão"), body: "fecha " + quando(dd) + " — lembre de importar" }); } });

  if (payDay) {
    // ---- MODO "dia de pagamento" (ex.: paga tudo todo dia 5) ----
    const dp = dUntil(payDay);
    const within = evening ? (dp === 0) : (dp <= 3);
    cards.forEach((c) => {
      const inv = cardInvoice(c.id); if (!(inv > 0)) return;
      const closedByPay = !c.closingDay || c.closingDay <= payDay; // fatura já fechou até o dia de pagar?
      if (closedByPay) {
        if (within) {
          let nota = "";
          if (c.dueDay && c.dueDay > payDay) nota = " · ainda não venceu (vence dia " + c.dueDay + ")";
          else if (c.dueDay && c.dueDay < payDay) nota = " · venceu dia " + c.dueDay;
          out.push({ tag: (evening ? "pay-eve-" : "pay-") + c.id, title: (c.name || "Cartão"), body: "Seu dia de pagar " + quando(dp) + " · " + brl(inv) + nota });
        }
      } else {
        // ainda não fechou até o dia de pagar -> segue o vencimento normal
        if (c.dueDay) {
          const dd = dUntil(c.dueDay);
          if (evening) { if (dd === 0) out.push({ tag: "venc-eve-" + c.id, title: (c.name || "Cartão"), body: "Vence HOJE · " + brl(inv) }); }
          else { if (dd <= 5) out.push({ tag: "venc-" + c.id, title: (c.name || "Cartão"), body: "Fatura vence " + quando(dd) + " · " + brl(inv) }); }
        }
      }
    });
    if (within) {
      const fx = [];
      (fixos || []).filter((f) => f.active !== false).forEach((f) => { let nota = (f.day && f.day > payDay) ? " (vence dia " + f.day + ")" : ""; fx.push((f.name || "Fixo") + " " + brl(f.amount) + nota); });
      if (fx.length) out.push({ tag: evening ? "payfix-eve" : "payfix", title: "Seu dia de pagar — fixos", body: fx.slice(0, 4).join(" · ") });
    }
    return out;
  }

  // ---- MODO normal (no vencimento) ----
  cards.forEach((c) => {
    const inv = cardInvoice(c.id);
    if (c.dueDay && inv > 0) {
      const dd = dUntil(c.dueDay);
      if (evening) { if (dd === 0) out.push({ tag: "venc-eve-" + c.id, title: (c.name || "Cartão"), body: "Vence HOJE · " + brl(inv) + " — não esqueça de pagar" }); }
      else { if (dd <= 5) out.push({ tag: "venc-" + c.id, title: (c.name || "Cartão"), body: "Fatura vence " + quando(dd) + " · " + brl(inv) }); }
    }
  });
  const fx = [];
  (fixos || []).filter((f) => f.active !== false).forEach((f) => {
    const dd = dUntil(f.day || 1);
    if (evening) { if (dd === 0) fx.push((f.name || "Fixo") + " (" + brl(f.amount) + ")"); }
    else { if (dd <= 2) fx.push((f.name || "Fixo") + " " + quando(dd) + " (" + brl(f.amount) + ")"); }
  });
  if (fx.length) out.push({ tag: evening ? "fixos-eve" : "fixos", title: evening ? "Vencem HOJE" : "Gastos fixos a vencer", body: fx.slice(0, 4).join(" · ") });
  return out;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try { initVapid(); } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }

  // CRON (GET): Vercel envia Authorization: Bearer <CRON_SECRET> quando CRON_SECRET existe
  if (req.method === "GET") {
    const cs = process.env.CRON_SECRET;
    const h = req.headers["authorization"] || "";
    if (!cs || h !== "Bearer " + cs) return res.status(401).json({ error: "cron não autorizado" });
    if (!SB_URL || !SB_SECRET) return res.status(500).json({ error: "faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    try {
      const mode = ((req.query && req.query.when === "evening") || /[?&]when=evening/.test(req.url || "")) ? "evening" : "morning";
      const rows = await sbSelect(`app_state?select=user_id,data`);
      let users = 0, notifs = 0;
      for (const row of rows) {
        const rem = remindersFor(row.data, mode);
        if (!rem.length) continue;
        users++;
        for (const n of rem) notifs += await sendTo(row.user_id, { title: n.title, body: n.body, url: "/", tag: n.tag });
      }
      return res.status(200).json({ ok: true, users, notifs });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  if (!(await authorize(req))) return res.status(401).json({ error: "não autorizado" });

  const action = req.body?.action || "test";

  if (action === "test") {
    const sub = req.body?.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "envie 'subscription'" });
    const payload = JSON.stringify({ title: "Caixa", body: "Notificações ativadas! Tudo certo por aqui.", url: "/" });
    try { await webpush.sendNotification(sub, payload); return res.status(200).json({ ok: true }); }
    catch (e) { return res.status(502).json({ error: "falha ao enviar push: " + (e.statusCode || "") + " " + String(e.body || e.message || e) }); }
  }

  if (action === "notify") {
    if (!SB_URL || !SB_SECRET) return res.status(500).json({ error: "faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    const me = await userFromToken(req);
    if (!me) return res.status(401).json({ error: "token inválido" });
    const toUser = req.body?.toUser, title = req.body?.title, body = req.body?.body, url = req.body?.url || "/";
    if (!toUser) return res.status(400).json({ error: "faltou toUser" });
    // segurança: só pode notificar quem é do mesmo casal ativo
    try {
      const couples = await sbSelect(`couples?status=eq.active&or=(and(member_a.eq.${me.id},member_b.eq.${toUser}),and(member_a.eq.${toUser},member_b.eq.${me.id}))&select=id`);
      if (!couples.length) return res.status(403).json({ error: "sem vínculo com esse usuário" });
      const sent = await sendTo(toUser, { title: title || "Caixa", body: body || "", url });
      return res.status(200).json({ ok: true, sent });
    } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  }

  return res.status(400).json({ error: "ação desconhecida" });
}
