import { apiKey, pluggyFetch, cors, authed } from "./_pluggy.js";

// GET /api/sync?itemId=...&from=YYYY-MM-DD
// Reads the connection's accounts and transactions and returns them normalized
// in the shape the Caixa app imports.
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });

  const itemId = req.query.itemId;
  if (!itemId) return res.status(400).json({ error: "itemId obrigatório" });
  const from = req.query.from || defaultFrom();

  try {
    const key = await apiKey();

    // Accounts of this item
    const aRes = await pluggyFetch(`/accounts?itemId=${encodeURIComponent(itemId)}`, key);
    const aData = await aRes.json();
    if (!aRes.ok) return res.status(aRes.status).json(aData);
    const rawAccounts = aData.results || [];

    const accounts = rawAccounts.map((a) => ({
      extId: a.id,
      name: a.name || a.marketingName || (a.type === "CREDIT" ? "Cartão" : "Conta"),
      type: a.type, // "BANK" | "CREDIT"
      balance: num(a.balance),
      limit: num(a.creditData?.creditLimit ?? a.creditData?.limit ?? null),
      closingDay: dayOf(a.creditData?.balanceCloseDate),
      dueDay: dayOf(a.creditData?.balanceDueDate),
    }));

    // Transactions per account (paginated)
    let transactions = [];
    for (const a of rawAccounts) {
      const txs = await listTransactions(key, a.id, from);
      transactions = transactions.concat(
        txs.map((t) => ({
          extId: t.id,
          accountExtId: a.id,
          accountType: a.type,
          date: (t.date || "").slice(0, 10),
          description: t.description || t.descriptionRaw || "",
          amount: Math.abs(num(t.amount)),
          kind: isExpense(t) ? "expense" : "income",
          category: t.category || null,
        }))
      );
    }

    return res.status(200).json({ itemId, from, accounts, transactions });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}

async function listTransactions(key, accountId, from) {
  let page = 1,
    totalPages = 1,
    out = [];
  do {
    const u = new URL("https://api.pluggy.ai/transactions");
    u.searchParams.set("accountId", accountId);
    u.searchParams.set("pageSize", "500");
    u.searchParams.set("page", String(page));
    if (from) u.searchParams.set("from", from);
    const r = await pluggyFetch(u.pathname + u.search, key);
    const d = await r.json();
    if (!r.ok) break;
    out = out.concat(d.results || []);
    totalPages = d.totalPages || 1;
    page++;
  } while (page <= totalPages && page <= 40); // safety cap
  return out;
}

// Pluggy marks debits with type "DEBIT"; fall back to the sign of amount.
function isExpense(t) {
  if (t.type === "DEBIT") return true;
  if (t.type === "CREDIT") return false;
  return num(t.amount) < 0;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getDate();
}
function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}
