// Mantém o projeto Supabase (plano free) ativo: faz uma leitura no banco.
// Chamado automaticamente pelo Vercel Cron (ver vercel.json).
export default async function handler(req, res) {
  const u = process.env.SUPABASE_URL;
  const k = process.env.SUPABASE_ANON_KEY;
  if (!u || !k) return res.status(500).json({ error: "faltam SUPABASE_URL / SUPABASE_ANON_KEY" });
  try {
    const r = await fetch(`${u}/rest/v1/keepalive?select=id&limit=1`, {
      headers: { apikey: k, Authorization: "Bearer " + k },
    });
    return res.status(200).json({ ok: r.ok, status: r.status, at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
