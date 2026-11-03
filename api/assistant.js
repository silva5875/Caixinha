import { cors, authed } from "./_pluggy.js";

// POST /api/assistant  body: { mode, ... }
//  mode "summary": { data }            -> { text }
//  mode "ask":     { question, data }  -> { text }
//  mode "categorize": { items:[{i,desc}], categories:[{id,name}] } -> { results:[{i,categoryId}] }
// A GEMINI_API_KEY fica só no servidor.

const PRIMARY = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const CASCADE = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
];
const MODELS = [...new Set([PRIMARY, ...CASCADE])].filter((m) => !/2\.5|2\.0|1\.5/.test(m));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(model, prompt, key, schema) {
  const gen = { temperature: 0.4 };
  if (schema) { gen.responseMimeType = "application/json"; gen.responseSchema = schema; }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gen }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function runCascade(prompt, key, schema) {
  const start = Date.now();
  let lastErr = "";
  for (let pass = 0; pass < 2; pass++) {
    for (const model of MODELS) {
      if (Date.now() - start > 50000) break;
      let g;
      try { g = await callGemini(model, prompt, key, schema); }
      catch (e) { lastErr = String(e.message || e); continue; }
      if (g.ok) {
        const text = g.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
        return { text };
      }
      lastErr = g.data?.error?.message || "HTTP " + g.status;
      if (g.status === 401 || g.status === 403) return { error: "Credencial do Gemini inválida." };
    }
    await sleep(800 * (pass + 1));
  }
  return { error: /quota|resource_exhausted|429/i.test(lastErr) ? "Limite de uso da IA atingido. Tente mais tarde." : "A IA está ocupada. Tente novamente em instantes." };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY não configurada" });

  const mode = req.body?.mode;
  try {
    if (mode === "summary") {
      const prompt = `Você é um consultor financeiro pessoal. Com base nestes dados do mês (em JSON), escreva um resumo curto e amigável em português do Brasil, com 3 a 5 frases: destaque os maiores gastos, diga se a pessoa gastou mais ou menos que o mês anterior, comente a taxa de poupança e dê UMA dica prática de economia. Não invente números além dos fornecidos; fale em reais.\n\nDADOS:\n${JSON.stringify(req.body.data || {})}`;
      const r = await runCascade(prompt, key);
      return r.error ? res.status(503).json({ error: r.error }) : res.status(200).json({ text: r.text.trim() });
    }
    if (mode === "ask") {
      const prompt = `Você é um assistente financeiro pessoal. Responda à PERGUNTA do usuário usando SOMENTE os DADOS fornecidos (em JSON, valores em reais). Seja direto, curto e em português do Brasil. Faça as contas necessárias a partir dos lançamentos. Se os dados não permitirem responder, diga isso claramente. Não invente informações.\n\nPERGUNTA: ${String(req.body.question || "").slice(0, 500)}\n\nDADOS:\n${JSON.stringify(req.body.data || {})}`;
      const r = await runCascade(prompt, key);
      return r.error ? res.status(503).json({ error: r.error }) : res.status(200).json({ text: r.text.trim() });
    }
    if (mode === "categorize") {
      const items = (req.body.items || []).slice(0, 200);
      const cats = (req.body.categories || []).slice(0, 60);
      const schema = {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: { type: "object", properties: { i: { type: "integer" }, categoryId: { type: "string" } }, required: ["i", "categoryId"] },
          },
        },
        required: ["results"],
      };
      const prompt = `Classifique cada LANÇAMENTO na melhor CATEGORIA da lista, pela descrição. Responda em JSON com results: lista de {i, categoryId}. Use só categoryId que exista na lista. Se não tiver certeza, use a categoria "Outros" se existir.\n\nCATEGORIAS: ${JSON.stringify(cats)}\n\nLANÇAMENTOS: ${JSON.stringify(items)}`;
      const r = await runCascade(prompt, key, schema);
      if (r.error) return res.status(503).json({ error: r.error });
      let parsed; try { parsed = JSON.parse(r.text); } catch { const m = r.text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { results: [] }; }
      return res.status(200).json({ results: Array.isArray(parsed.results) ? parsed.results : [] });
    }
    return res.status(400).json({ error: "mode inválido" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
