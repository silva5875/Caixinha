import { cors, authed } from "./_pluggy.js";

// POST /api/parse-fatura   body: { pdf: "<base64 sem prefixo data:>" }
// Lê a fatura (PDF) com o Gemini e devolve as compras já estruturadas.
// A GEMINI_API_KEY fica só aqui, no servidor (variável de ambiente).
// Tenta novamente de forma automática quando o modelo está sobrecarregado,
// e cai para um modelo alternativo se o principal continuar indisponível.

const PRIMARY = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// Cascata: tenta na ordem; se um estiver sobrecarregado, pula pro próximo na hora.
// Os "lite" costumam ter mais capacidade livre nos picos.
const CASCADE = [
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-flash-latest",
];
const MODELS = [...new Set([PRIMARY, ...CASCADE])];

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
- Se identificar o vencimento ou o mês de referência da fatura, inclua em fatura_vencimento (YYYY-MM-DD).
- Identifique o banco/emissor do cartão (ex.: Nubank, Banco Inter, Itaú, Bradesco, C6 Bank, Santander, Caixa, BTG, XP, PicPay, Will, Neon, etc.) e coloque em "emissor".
- Se aparecerem os 4 últimos dígitos do cartão, coloque em "cartao_final" (só os 4 dígitos).
- Se identificar a bandeira (Visa, Mastercard, Elo, Amex, Hipercard), coloque em "bandeira".`;

const SCHEMA = {
  type: "object",
  properties: {
    fatura_vencimento: { type: "string" },
    emissor: { type: "string" },
    cartao_final: { type: "string" },
    bandeira: { type: "string" },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const supportsThinking = (model) => !/2\.0/.test(model);

function buildBody(pdf, model) {
  const g = { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 };
  if (supportsThinking(model)) g.thinkingConfig = { thinkingBudget: 0 };
  return {
    contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: pdf } }, { text: PROMPT }] }],
    generationConfig: g,
  };
}

function isTransient(status, msg) {
  if (status === 429 || status === 500 || status === 503) return true;
  const m = (msg || "").toLowerCase();
  return (
    m.includes("high demand") ||
    m.includes("overloaded") ||
    m.includes("unavailable") ||
    m.includes("try again") ||
    m.includes("resource_exhausted")
  );
}

async function callGemini(model, pdf, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(pdf, model)),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY não configurada no servidor" });

  let pdf = req.body?.pdf;
  if (!pdf) return res.status(400).json({ error: "envie o PDF em base64 no campo 'pdf'" });
  const comma = pdf.indexOf(",");
  if (pdf.startsWith("data:") && comma !== -1) pdf = pdf.slice(comma + 1);

  const start = Date.now();
  const DEADLINE = 50000; // para antes do limite de 60s da Vercel
  const PASSES = 4; // repete a cascata inteira até dar certo (dentro do tempo)
  let lastErr = "";
  let triedModels = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    for (const model of MODELS) {
      if (Date.now() - start > DEADLINE) break;
      triedModels++;
      let g;
      try {
        g = await callGemini(model, pdf, key);
      } catch (e) {
        lastErr = String(e.message || e);
        continue; // falha de rede: próximo modelo na hora
      }
      if (g.ok) {
        const text =
          g.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const m = text.match(/\{[\s\S]*\}/);
          parsed = m ? JSON.parse(m[0]) : { compras: [] };
        }
        const compras = normalize(parsed.compras || []);
        return res.status(200).json({
          fatura_vencimento: parsed.fatura_vencimento || null,
          emissor: parsed.emissor || null,
          cartao_final: parsed.cartao_final || null,
          bandeira: parsed.bandeira || null,
          compras,
          modelo: model, // qual modelo da cascata respondeu
        });
      }
      const status = g.status;
      const msg = g.data?.error?.message || "HTTP " + status;
      lastErr = msg;
      // Credencial/permissão inválida: trocar de modelo não resolve -> aborta.
      if (status === 401 || status === 403) {
        return res.status(status).json({ error: msg });
      }
      // Qualquer outra falha (sobrecarga, 404, 400, 429, 500...): CASCATA -> próximo modelo imediatamente.
    }
    if (Date.now() - start > DEADLINE) break;
    await sleep(800 * (pass + 1)); // respiro curto entre passadas completas
  }
  const overloaded = /high demand|overloaded|unavailable|resource_exhausted|try again|429|503/i.test(lastErr);
  return res.status(503).json({
    error: overloaded
      ? "Todos os modelos de IA estão ocupados neste momento. Tente novamente em alguns segundos."
      : lastErr || "Não consegui processar a fatura. Tente novamente.",
    modelos_tentados: triedModels,
  });
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
