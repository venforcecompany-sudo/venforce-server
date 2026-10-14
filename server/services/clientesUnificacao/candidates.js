// Triagem explicável de #254, compartilhada com inventory.py. Nunca aprova
// empresa/canônico. Entrada e saída são dados locais; nenhuma conexão/API.
function stem(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/(?:\s+(?:ml|meli|mercado livre|shopee|tiktok))?\s*\d+$/, "")
    .trim();
}
// Matching blocks usados pelo SequenceMatcher (difflib), com autojunk para
// strings longas. O catálogo nunca usa similaridade como autorização.
function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const positions = new Map();
  for (let j = 0; j < b.length; j++) {
    if (!positions.has(b[j])) positions.set(b[j], []);
    positions.get(b[j]).push(j);
  }
  if (b.length >= 200)
    for (const [ch, indices] of positions)
      if (indices.length > Math.floor(b.length / 100) + 1) positions.delete(ch);
  const queue = [[0, a.length, 0, b.length]];
  let matched = 0;
  while (queue.length) {
    const [lo, hi, blo, bhi] = queue.pop();
    let bestI = lo,
      bestJ = blo,
      best = 0,
      previous = new Map();
    for (let i = lo; i < hi; i++) {
      const next = new Map();
      for (const j of positions.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const n = (previous.get(j - 1) || 0) + 1;
        next.set(j, n);
        if (n > best) {
          bestI = i - n + 1;
          bestJ = j - n + 1;
          best = n;
        }
      }
      previous = next;
    }
    while (bestI > lo && bestJ > blo && a[bestI - 1] === b[bestJ - 1]) {
      bestI--;
      bestJ--;
      best++;
    }
    while (
      bestI + best < hi &&
      bestJ + best < bhi &&
      a[bestI + best] === b[bestJ + best]
    )
      best++;
    if (!best) continue;
    matched += best;
    if (lo < bestI && blo < bestJ) queue.push([lo, bestI, blo, bestJ]);
    if (bestI + best < hi && bestJ + best < bhi)
      queue.push([bestI + best, hi, bestJ + best, bhi]);
  }
  return (2 * matched) / (a.length + b.length);
}
function candidatePairs(tables) {
  const clients = tables.clientes || [],
    accounts = tables.cliente_contas || [],
    grants = tables.ml_tokens || [],
    history = tables.cliente_squad_history || [];
  const squad = (cid) =>
    history
      .filter((h) => Number(h.cliente_id) === Number(cid) && h.fim_em == null)
      .map((h) => Number(h.squad_id));
  const sellers = (cid) =>
    new Set(
      [
        ...accounts
          .filter((a) => Number(a.cliente_id) === Number(cid))
          .map((a) => a.external_account_id),
        ...grants
          .filter((g) => Number(g.cliente_id) === Number(cid))
          .map((g) => g.ml_user_id),
      ]
        .filter(Boolean)
        .map(String),
    );
  const indexed = clients.map((c) => ({
      c,
      n: stem(c.nome),
      s: stem(c.slug),
      sellers: sellers(c.id),
      squads: squad(c.id),
    })),
    pairs = [];
  for (let i = 0; i < indexed.length; i++)
    for (let j = i + 1; j < indexed.length; j++) {
      const a = indexed[i],
        b = indexed[j],
        shared = [...a.sellers].filter((x) => b.sellers.has(x)).sort();
      const same = (a.n === b.n || a.s === b.s) && a.n.length >= 3,
        ratio = Math.max(similarity(a.n, b.n), similarity(a.s, b.s));
      if (!shared.length && !same && ratio < 0.86) continue;
      const reasons = [];
      const reason = (motivo, pontos) => reasons.push({ motivo, pontos });
      if (shared.length)
        reason(
          "seller compartilhado comprova identidade externa, não empresa",
          30,
        );
      if (same) reason("mesma raiz de nome/slug", 10);
      else if (ratio >= 0.86) reason("similaridade textual >=0.86", 5);
      const squadSame = JSON.stringify(a.squads) === JSON.stringify(b.squads);
      if (a.squads.length === 1 && b.squads.length === 1 && squadSame)
        reason("Squad atual igual, sem prova empresarial", 10);
      else if (!squadSame)
        reason("carteiras distintas sem decisão de acesso", -50);
      const classification =
        shared.length && (!same || !squadSame)
          ? "DECISAO_HUMANA"
          : shared.length && same
            ? "MUITO_PROVAVEL"
            : same
              ? "PROVAVEL"
              : "POSSIVEL";
      pairs.push({
        cliente_a: a.c.id,
        cliente_b: b.c.id,
        classificacao: classification,
        score_priorizacao: reasons.reduce((n, r) => n + r.pontos, 0),
        motivos: reasons,
        sellers_compartilhados: shared,
        decisao: "PENDENTE",
        cliente_canonico_aprovado: null,
      });
    }
  return pairs;
}
if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
    if (data.length > 4 * 1024 * 1024) process.exit(64);
  });
  process.stdin.on("end", () => {
    try {
      const t = JSON.parse(data);
      if (!Array.isArray(t.clientes) || t.clientes.length > 500)
        throw new Error();
      process.stdout.write(JSON.stringify(candidatePairs(t)) + "\n");
    } catch (_) {
      process.stderr.write("CANDIDATE_INPUT_INVALID\n");
      process.exitCode = 64;
    }
  });
}
module.exports = { stem, similarity, candidatePairs };
