import { cors, authed } from "./_pluggy.js";

// POST /api/parse-fatura   body: { pdf: "<base64 sem prefixo data:>" }
// Lê a fatura (PDF) com o Gemini e devolve as compras já estruturadas:
// { fatura_vencimento, compras: [{descricao, data, valor_total, parcela_atual, parcelas_total, valor_parcela}] }
// A GEMINI_API_KEY fica só aqui, no servidor (variável de ambiente).

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const PROMPT = `Você é um extrator de dados de faturas de cartão de crédito brasileiras.
Analise o PDF da fatura e extraia TODAS as compras/lançamentos de despesa.
Para cada compra retorne:
- descricao: nome do estabelecimento ou da compra
- data: data da compra no formato YYYY-MM-DD (se só houver dia/mês, use o ano da fatura)
- valor_total: valor TOTAL da compra, em número decimal com ponto (ex.: 1234.56)
- parcela_atual: número da parcela atual (1 se for à vista)
- parcelas_total: total de parcelas (1 se for à vista)
- valor_parcela: valor desta parcela, em número decimal com ponto

Regras importantes:
- Valores SEMPRE como número decimal com ponto. Nunca use "R$" nem vírgula.
- Quando a linha indicar parcelamento (ex.: "03/10", "PARC 3/10", "3 de 10"), preencha parcela_atual e parcelas_total.
- Se o valor_total não estiver explícito numa compra parcelada, calcule valor_parcela multiplicado por parcelas_total.
- Para compras à vista: parcela_atual = 1, parcelas_total = 1, valor_parcela = valor_total.
- IGNORE pagamentos, estornos, créditos, juros, encargos, IOF e anuidade. Apenas compras de despesa.
- Se identificar o vencimento ou o mês de referência da fatura, inclua em fatura_vencimento (YYYY-MM-DD).`;

const SCHEMA = {
  type: "object",
  properties: {
    fatura_vencimento: { type: "string" },
    compras: {
      type: "array",
      items: {
        type: "object",
        properties: {
          descricao: { type: "string" },
          data: { type: "string" },
          valor_total: { type: "number" },
          parcela_atual: { type: "integer" },
          parcelas_total: { type: "integer" },
          valor_parcela: { type: "number" },
        },
        required: ["descricao", "valor_parcela"],
      },
    },
  },
  required: ["compras"],
};

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY não configurada no servidor" });

  let pdf = req.body?.pdf;
  if (!pdf) return res.status(400).json({ error: "envie o PDF em base64 no campo 'pdf'" });
  // aceita com ou sem prefixo data:
  const comma = pdf.indexOf(",");
  if (pdf.startsWith("data:") && comma !== -1) pdf = pdf.slice(comma + 1);

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "application/pdf", data: pdf } },
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "falha no Gemini", raw: data });
    }
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // fallback: tenta achar o primeiro { ... } no texto
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { compras: [] };
    }
    const compras = normalize(parsed.compras || []);
    return res.status(200).json({ fatura_vencimento: parsed.fatura_vencimento || null, compras });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

function normalize(list) {
  return list
    .map((c) => {
      const total = Math.max(1, parseInt(c.parcelas_total) || 1);
      const atual = Math.min(Math.max(1, parseInt(c.parcela_atual) || 1), total);
      let vParc = num(c.valor_parcela);
      let vTotal = num(c.valor_total);
      if (!vParc && vTotal) vParc = total ? vTotal / total : vTotal;
      if (!vTotal && vParc) vTotal = vParc * total;
      return {
        descricao: String(c.descricao || "Compra").trim(),
        data: /^\d{4}-\d{2}-\d{2}$/.test(c.data || "") ? c.data : null,
        valor_total: round2(vTotal),
        valor_parcela: round2(vParc),
        parcela_atual: atual,
        parcelas_total: total,
      };
    })
    .filter((c) => c.valor_parcela > 0);
}
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
