import { cors, authed } from "./_pluggy.js";

// POST /api/parse-fatura   body: { pdf: "<base64 sem prefixo data:>" }
// Lê a fatura (PDF) com o Gemini e devolve as compras já estruturadas.
// A GEMINI_API_KEY fica só aqui, no servidor (variável de ambiente).
// Tenta novamente de forma automática quando o modelo está sobrecarregado,
// e cai para um modelo alternativo se o principal continuar indisponível.

const PRIMARY = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
// Cascata com modelos ATUAIS (Gemini 3, out/2026). Os "lite" vêm primeiro:
// são rápidos e têm mais capacidade livre em horário de pico. Flash como reforço.
const CASCADE = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
];
// Ignora automaticamente famílias já aposentadas (2.5 / 2.0 / 1.5),
// mesmo que GEMINI_MODEL ainda esteja com um valor antigo.
const MODELS = [...new Set([PRIMARY, ...CASCADE])].filter((m) => !/2\.5|2\.0|1\.5/.test(m));

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
- Marque "assinatura": true quando a compra for um serviço recorrente de assinatura (streaming e afins: Netflix, HBO Max, Max, Prime Video, Amazon Prime, Disney+, Star+, Globoplay, Paramount+, Apple TV, Spotify, Deezer, YouTube Premium, Apple, iCloud, Google One, academias, e softwares/apps por assinatura). Em "servico", escreva o nome normalizado do serviço (ex.: "Netflix", "Spotify", "Amazon Prime"). Para compras comuns, "assinatura": false.
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
          assinatura: { type: "boolean" },
          servico: { type: "string" },
        },
        required: ["descricao", "valor_parcela"],
      },
    },
  },
  required: ["compras"],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const supportsThinking = (model) => !/2\.0/.test(model);

function buildBody(pdf) {
  return {
    contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: pdf } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
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
  const PASSES = 2;
  let lastErr = "", sawQuota = false, sawOverload = false;
  const tried = [];
  for (let pass = 0; pass < PASSES; pass++) {
    for (const model of MODELS) {
      if (Date.now() - start > DEADLINE) break;
      let g;
      try {
        g = await callGemini(model, pdf, key);
      } catch (e) {
        lastErr = String(e.message || e);
        tried.push(model.replace("gemini-", "") + ":rede");
        console.error(`[parse-fatura] ${model} rede: ${lastErr}`);
        continue;
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
          modelo: model,
        });
      }
      const status = g.status;
      lastErr = g.data?.error?.message || "HTTP " + status;
      tried.push(model.replace("gemini-", "") + ":" + status);
      console.error(`[parse-fatura] ${model} -> ${status}: ${lastErr}`);
      if (status === 401 || status === 403) {
        return res.status(status).json({ error: "Credencial do Gemini inválida ou sem permissão.", detalhe: lastErr });
      }
      if (status === 429 || /quota|resource_exhausted/i.test(lastErr)) sawQuota = true;
      else if (status === 503 || status === 500 || /overloaded|high demand|unavailable/i.test(lastErr)) sawOverload = true;
      // cascata -> próximo modelo imediatamente
    }
    if (sawQuota || Date.now() - start > DEADLINE) break; // cota não se recupera em segundos
    await sleep(900 * (pass + 1));
  }
  let friendly;
  if (sawQuota) {
    friendly = "Limite de uso da API do Gemini atingido (cota do plano gratuito). Aguarde alguns minutos, ou ative um plano pago / aumente a cota no Google AI Studio.";
  } else if (sawOverload) {
    friendly = "Os modelos de IA estão ocupados agora. Tente novamente em alguns segundos.";
  } else {
    friendly = lastErr || "Não consegui processar a fatura. Tente novamente.";
  }
  return res.status(503).json({ error: friendly + "  ·  [" + tried.join(", ") + "]", detalhe: lastErr });
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
        assinatura: !!c.assinatura,
        servico: String(c.servico || "").trim(),
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
