// server/services/automacoes/relatoriosService.js
// Services de relatórios, pastas e exportações.
// Extraído de server/index.js sem alterar endpoints, payloads, SQL ou arquivos gerados.

const XLSX = require("xlsx");
const pool = require("../../config/database");

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function csvEscape(valor) {
  if (valor === null || valor === undefined) return "";
  const texto = String(valor);
  if (texto.includes('"') || texto.includes(",") || texto.includes("\n")) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function montarNomeArquivoRelatorio(relatorio, extensao, prefixo = "relatorio") {
  const cliente = normalizarSlug(relatorio?.cliente_slug || "cliente");
  const base = normalizarSlug(relatorio?.base_slug || "base");
  const escopo = normalizarSlug(relatorio?.escopo || "escopo");
  const id = Number(relatorio?.id) || 0;
  return `${prefixo}-${cliente}-${base}-${escopo}-#${id}.${extensao}`;
}

// Duplicado aqui por extração; o diagnóstico ainda usa a versão do index.js.
function extrairSkuMl(body) {
  const direto = [body?.seller_custom_field, body?.sku]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direto) return direto;

  const nomeEhSku = (txt) => String(txt || "").toLowerCase().includes("sku");
  const attrs = Array.isArray(body?.attributes) ? body.attributes : [];
  for (const a of attrs) {
    const id = String(a?.id || "");
    const name = String(a?.name || "");
    if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
    const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
    const sku = String(val || "").trim();
    if (sku) return sku;
  }

  const vars = Array.isArray(body?.variations) ? body.variations : [];
  for (const v of vars) {
    const vDireto = [v?.seller_custom_field, v?.sku]
      .map((x) => String(x || "").trim())
      .find(Boolean);
    if (vDireto) return vDireto;

    const vAttrs = Array.isArray(v?.attributes) ? v.attributes : [];
    for (const a of vAttrs) {
      const id = String(a?.id || "");
      const name = String(a?.name || "");
      if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
      const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
      const sku = String(val || "").trim();
      if (sku) return sku;
    }
  }

  return null;
}

async function carregarRelatorioComItens(id) {
  const rel = await pool.query("SELECT * FROM relatorios WHERE id = $1", [id]);
  if (!rel.rows.length) return null;
  const itens = await pool.query(
    `SELECT id, item_id, sku, titulo, status_anuncio, listing_type_id,
            preco_original, preco_promocional, preco_efetivo,
            custo, imposto_percentual, taxa_fixa,
            frete, comissao, comissao_percentual,
            lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
            acao_recomendada, explicacao_calculo, diagnostico, tem_base
       FROM relatorio_itens
      WHERE relatorio_id = $1
      ORDER BY id ASC`,
    [id]
  );
  return { relatorio: rel.rows[0], itens: itens.rows };
}

async function salvarRelatorioAutomacoes({ userId, body }) {
  const {
    clienteSlug, baseSlug, margemAlvo, escopo, observacoes, linhas,
  } = body || {};

  if (!clienteSlug) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório." });
  if (!baseSlug) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório." });
  if (!Array.isArray(linhas) || linhas.length === 0) {
    throw criarErroHttp(400, { ok: false, erro: "linhas é obrigatório e não pode ser vazio." });
  }

  const clienteSlugNorm = normalizarSlug(clienteSlug);
  const baseSlugNorm = normalizarSlug(baseSlug);
  const escopoNorm = ["pagina_atual", "loja_completa"].includes(escopo) ? escopo : "pagina_atual";

  const c = await pool.query("SELECT id, slug FROM clientes WHERE slug = $1", [clienteSlugNorm]);
  if (!c.rows.length) throw criarErroHttp(404, { ok: false, erro: "Cliente não encontrado." });

  const b = await pool.query("SELECT id, slug FROM bases WHERE slug = $1", [baseSlugNorm]);
  if (!b.rows.length) throw criarErroHttp(404, { ok: false, erro: "Base não encontrada." });

  const margemNumber = Number(margemAlvo);
  const margem = Number.isFinite(margemNumber) && margemNumber > 0 && margemNumber < 1
    ? margemNumber
    : null;

  let comBase = 0, semBase = 0, criticos = 0, atencao = 0, saudaveis = 0;
  let mcSum = 0, mcCount = 0;
  for (const l of linhas) {
    if (l.temBase) comBase++; else semBase++;
    if (l.diagnostico === "critico") criticos++;
    if (l.diagnostico === "atencao") atencao++;
    if (l.diagnostico === "saudavel") saudaveis++;
    const mc = Number(l.mc);
    if (Number.isFinite(mc)) { mcSum += mc; mcCount++; }
  }
  const mcMedia = mcCount > 0 ? mcSum / mcCount : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO relatorios
         (user_id, cliente_id, cliente_slug, base_id, base_slug, margem_alvo,
          escopo, status, total_itens, itens_com_base, itens_sem_base,
          itens_criticos, itens_atencao, itens_saudaveis, mc_media, observacoes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'concluido',$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, created_at`,
      [
        userId,
        c.rows[0].id, c.rows[0].slug,
        b.rows[0].id, b.rows[0].slug,
        margem, escopoNorm,
        linhas.length, comBase, semBase,
        criticos, atencao, saudaveis,
        mcMedia, (observacoes || null),
      ]
    );
    const relatorioId = ins.rows[0].id;

    for (const l of linhas) {
      await client.query(
        `INSERT INTO relatorio_itens
           (relatorio_id, item_id, titulo, status_anuncio, listing_type_id,
            preco_original, preco_promocional, preco_efetivo,
            custo, imposto_percentual, taxa_fixa,
            frete, comissao, comissao_percentual,
            lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
            acao_recomendada, explicacao_calculo, diagnostico, tem_base)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          relatorioId,
          String(l.item_id || ""),
          l.titulo ?? null,
          l.statusAnuncio ?? null,
          l.listingTypeId ?? null,
          l.precoOriginal ?? null,
          l.precoPromocional ?? null,
          l.precoEfetivo ?? null,
          l.custo ?? null,
          l.impostoPercentual ?? null,
          l.taxaFixa ?? null,
          l.frete ?? null,
          l.comissao ?? null,
          l.comissaoPercentual ?? null,
          l.lc ?? null,
          l.mc ?? null,
          l.precoAlvo ?? null,
          l.precoSugerido ?? l.preco_sugerido ?? null,
          l.diferencaPreco ?? l.diferenca_preco ?? null,
          l.acaoRecomendada ?? l.acao_recomendada ?? null,
          l.explicacaoCalculo ?? l.explicacao_calculo ?? null,
          l.diagnostico ?? null,
          !!l.temBase,
        ]
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      relatorio_id: relatorioId,
      created_at: ins.rows[0].created_at,
      _logContext: {
        clienteSlugNorm,
        baseSlugNorm,
        escopoNorm,
        totalItens: linhas.length,
      },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listarRelatoriosAutomacoes({ query }) {
  const clienteSlug = String(query?.clienteSlug || "").trim();
  const pastaIdRaw = query?.pastaId;
  let pastaId = null;
  if (pastaIdRaw !== undefined && pastaIdRaw !== null && String(pastaIdRaw).trim() !== "") {
    const parsedPastaId = parseInt(pastaIdRaw, 10);
    if (!Number.isFinite(parsedPastaId) || parsedPastaId <= 0) {
      throw criarErroHttp(400, { ok: false, erro: "pastaId inválido." });
    }
    pastaId = parsedPastaId;
  }

  const limitRaw = parseInt(query?.limit, 10);
  const temLimit = Number.isFinite(limitRaw) && limitRaw > 0;
  const limit = temLimit ? Math.min(Math.max(limitRaw, 1), 500) : null;

  const params = [];
  const where = [];
  if (clienteSlug) {
    params.push(normalizarSlug(clienteSlug));
    where.push(`r.cliente_slug = $${params.length}`);
  }
  if (pastaId !== null) {
    params.push(pastaId);
    where.push(`r.pasta_id = $${params.length}`);
  }

  let sql = `
      SELECT r.id, r.user_id, r.cliente_slug, r.base_slug, r.escopo, r.status,
             r.margem_alvo, r.total_itens, r.itens_com_base, r.itens_sem_base,
             r.itens_criticos, r.itens_atencao, r.itens_saudaveis,
             r.mc_media, r.observacoes, r.created_at, r.pasta_id,
             p.nome AS pasta_nome
        FROM relatorios r
        LEFT JOIN relatorio_pastas p ON p.id = r.pasta_id
    `;

  if (where.length) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }

  sql += ` ORDER BY r.created_at DESC`;
  if (temLimit) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await pool.query(sql, params);

  return { ok: true, total: result.rows.length, relatorios: result.rows };
}

async function listarPastasRelatorios() {
  const result = await pool.query(
    `SELECT p.id, p.nome, p.descricao, p.created_at,
              COUNT(r.id)::int AS total_relatorios
         FROM relatorio_pastas p
         LEFT JOIN relatorios r ON r.pasta_id = p.id
        GROUP BY p.id, p.nome, p.descricao, p.created_at
        ORDER BY p.nome ASC, p.id ASC`
  );
  return { ok: true, total: result.rows.length, pastas: result.rows };
}

async function criarPastaRelatorios({ body }) {
  const nome = String(body?.nome || "").trim();
  const descricaoRaw = body?.descricao;
  const descricao = descricaoRaw == null || String(descricaoRaw).trim() === ""
    ? null
    : String(descricaoRaw).trim();

  if (!nome) {
    throw criarErroHttp(400, { ok: false, erro: "nome é obrigatório." });
  }

  const ins = await pool.query(
    `INSERT INTO relatorio_pastas (nome, descricao)
       VALUES ($1, $2)
       RETURNING id, nome, descricao, created_at`,
    [nome, descricao]
  );

  return { ok: true, pasta: ins.rows[0] };
}

async function atualizarPastaRelatorios({ idRaw, body }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const atual = await pool.query("SELECT id, nome, descricao, created_at FROM relatorio_pastas WHERE id = $1", [id]);
  if (!atual.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Pasta não encontrada." });
  }

  const temNome = Object.prototype.hasOwnProperty.call(body || {}, "nome");
  const temDescricao = Object.prototype.hasOwnProperty.call(body || {}, "descricao");
  if (!temNome && !temDescricao) {
    throw criarErroHttp(400, { ok: false, erro: "Informe nome e/ou descricao para atualizar." });
  }

  const nome = temNome ? String(body?.nome || "").trim() : atual.rows[0].nome;
  if (temNome && !nome) {
    throw criarErroHttp(400, { ok: false, erro: "nome é obrigatório." });
  }

  const descricao = temDescricao
    ? (body?.descricao == null || String(body.descricao).trim() === "" ? null : String(body.descricao).trim())
    : atual.rows[0].descricao;

  const upd = await pool.query(
    `UPDATE relatorio_pastas
          SET nome = $1,
              descricao = $2
        WHERE id = $3
      RETURNING id, nome, descricao, created_at`,
    [nome, descricao, id]
  );

  return { ok: true, pasta: upd.rows[0] };
}

async function excluirPastaRelatorios({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const pasta = await pool.query("SELECT id FROM relatorio_pastas WHERE id = $1", [id]);
  if (!pasta.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Pasta não encontrada." });
  }

  const refs = await pool.query("SELECT COUNT(*)::int AS total FROM relatorios WHERE pasta_id = $1", [id]);
  if ((refs.rows[0]?.total || 0) > 0) {
    throw criarErroHttp(400, { ok: false, erro: "Não é possível excluir uma pasta com relatórios." });
  }

  await pool.query("DELETE FROM relatorio_pastas WHERE id = $1", [id]);
  return { ok: true };
}

async function moverRelatorioParaPasta({ idRaw, body }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const rel = await pool.query("SELECT id FROM relatorios WHERE id = $1", [id]);
  if (!rel.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Relatório não encontrado." });
  }

  const pastaIdBody = body?.pastaId;
  if (pastaIdBody === null) {
    await pool.query("UPDATE relatorios SET pasta_id = NULL WHERE id = $1", [id]);
    return { ok: true };
  }

  const pastaId = parseInt(pastaIdBody, 10);
  if (!Number.isFinite(pastaId) || pastaId <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "pastaId inválido." });
  }

  const pasta = await pool.query("SELECT id FROM relatorio_pastas WHERE id = $1", [pastaId]);
  if (!pasta.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Pasta não encontrada." });
  }

  await pool.query("UPDATE relatorios SET pasta_id = $1 WHERE id = $2", [pastaId, id]);
  return { ok: true };
}

async function buscarDetalheRelatorioAutomacoes({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const rel = await pool.query("SELECT * FROM relatorios WHERE id = $1", [id]);
  if (!rel.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Relatório não encontrado." });
  }

  const itens = await pool.query(
    `SELECT id, item_id, sku, titulo, status_anuncio, listing_type_id,
              preco_original, preco_promocional, preco_efetivo,
              custo, imposto_percentual, taxa_fixa,
              frete, comissao, comissao_percentual,
              lc, mc, preco_alvo, preco_sugerido, diferenca_preco,
              acao_recomendada, explicacao_calculo, diagnostico, tem_base
         FROM relatorio_itens
        WHERE relatorio_id = $1
        ORDER BY id ASC`,
    [id]
  );

  return {
    ok: true,
    relatorio: rel.rows[0],
    itens: itens.rows,
    total_itens: itens.rows.length,
  };
}

async function excluirRelatorioAutomacoes({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const rel = await pool.query("SELECT id FROM relatorios WHERE id = $1", [id]);
  if (!rel.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Relatório não encontrado." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM relatorio_itens WHERE relatorio_id = $1", [id]);
    await client.query("DELETE FROM relatorios WHERE id = $1", [id]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function gerarExportRelatorioCsv({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const dados = await carregarRelatorioComItens(id);
  if (!dados) {
    throw criarErroHttp(404, { ok: false, erro: "Relatório não encontrado." });
  }
  const { relatorio, itens } = dados;

  const linhas = [];
  linhas.push("Resumo do relatório");
  linhas.push(`ID,${csvEscape(relatorio.id)}`);
  linhas.push(`Cliente,${csvEscape(relatorio.cliente_slug)}`);
  linhas.push(`Base,${csvEscape(relatorio.base_slug)}`);
  linhas.push(`Escopo,${csvEscape(relatorio.escopo)}`);
  linhas.push(`Status,${csvEscape(relatorio.status)}`);
  linhas.push(`Margem alvo,${csvEscape(relatorio.margem_alvo)}`);
  linhas.push(`Total itens,${csvEscape(relatorio.total_itens)}`);
  linhas.push(`Itens com base,${csvEscape(relatorio.itens_com_base)}`);
  linhas.push(`Itens sem base,${csvEscape(relatorio.itens_sem_base)}`);
  linhas.push(`Itens críticos,${csvEscape(relatorio.itens_criticos)}`);
  linhas.push(`Itens atenção,${csvEscape(relatorio.itens_atencao)}`);
  linhas.push(`Itens saudáveis,${csvEscape(relatorio.itens_saudaveis)}`);
  linhas.push(`MC média,${csvEscape(relatorio.mc_media)}`);
  linhas.push(`Observações,${csvEscape(relatorio.observacoes)}`);
  linhas.push(`Criado em,${csvEscape(relatorio.created_at)}`);
  linhas.push("");
  linhas.push("Itens");
  linhas.push([
    "item_id", "titulo", "status_anuncio", "listing_type_id",
    "preco_original", "preco_promocional", "preco_efetivo",
    "custo", "imposto_percentual", "taxa_fixa",
    "frete", "comissao", "comissao_percentual",
    "lc", "mc", "preco_alvo", "preco_sugerido", "diferenca_preco",
    "acao_recomendada", "explicacao_calculo", "diagnostico", "tem_base",
  ].join(","));

  itens.forEach((it) => {
    linhas.push([
      it.item_id, it.titulo, it.status_anuncio, it.listing_type_id,
      it.preco_original, it.preco_promocional, it.preco_efetivo,
      it.custo, it.imposto_percentual, it.taxa_fixa,
      it.frete, it.comissao, it.comissao_percentual,
      it.lc, it.mc, it.preco_alvo, it.preco_sugerido, it.diferenca_preco,
      it.acao_recomendada, it.explicacao_calculo, it.diagnostico, it.tem_base,
    ].map(csvEscape).join(","));
  });

  const csv = linhas.join("\n");
  const filename = montarNomeArquivoRelatorio(relatorio, "csv");

  return {
    contentType: "text/csv; charset=utf-8",
    filename,
    bufferOrText: `\uFEFF${csv}`,
  };
}

async function gerarExportRelatorioXlsx({ idRaw }) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw criarErroHttp(400, { ok: false, erro: "id inválido." });
  }

  const dados = await carregarRelatorioComItens(id);
  if (!dados) {
    throw criarErroHttp(404, { ok: false, erro: "Relatório não encontrado." });
  }
  const { relatorio, itens } = dados;

  const paraDecimalPct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
  };
  const numeroOuNulo = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const resumoRows = [
    ["Resumo do relatório", ""],
    ["Cliente", relatorio.cliente_slug || "—"],
    ["Base", relatorio.base_slug || "—"],
    ["Escopo", relatorio.escopo || "—"],
    ["Margem alvo", paraDecimalPct(relatorio.margem_alvo)],
    ["Total de itens", numeroOuNulo(relatorio.total_itens)],
    ["Com base", numeroOuNulo(relatorio.itens_com_base)],
    ["Sem base", numeroOuNulo(relatorio.itens_sem_base)],
    ["Críticos", numeroOuNulo(relatorio.itens_criticos)],
    ["Atenção", numeroOuNulo(relatorio.itens_atencao)],
    ["Saudáveis", numeroOuNulo(relatorio.itens_saudaveis)],
    ["MC média", paraDecimalPct(relatorio.mc_media)],
    ["Data do relatório", relatorio.created_at ? new Date(relatorio.created_at).toLocaleString("pt-BR") : "—"],
  ];

  const matrizRows = [
    [
      "Edite custo, frete, comissão, preço ou margem alvo para simular novas decisões.",
      ...Array(29).fill(""),
    ],
    [
      "Dados do anúncio", "", "", "",
      "",
      "Cálculo atual", "", "", "", "", "", "",
      "",
      "Promoção", "", "", "",
      "",
      "Preço sugerido", "", "",
      "",
      "Decisão", "", "", "", "", "", "",
    ],
    [
      "ID", "SKU/Base", "Título", "Marketplace",
      "",
      "Preço Custo", "Imposto %", "Frete R$", "Comissão %", "", "Preço Original", "Lucro Original", "MC Original",
      "",
      "Preço Promocional", "Lucro Promocional", "MC Promocional", "Preço Efetivo",
      "",
      "Margem Alvo", "Preço Sugerido", "Lucro no Sugerido",
      "",
      "Ação", "Preço Adotado", "Diferença R$", "Diferença %",
      "Diagnóstico", "Ação Recomendada", "Observação",
    ],
  ];

  itens.forEach((it) => {
    const impostoPct = paraDecimalPct(it.imposto_percentual);
    const freteNum = numeroOuNulo(it.frete);
    matrizRows.push([
      it.item_id || "",
      it.sku || "",
      it.titulo || "",
      "MeLi",
      "",
      numeroOuNulo(it.custo),
      impostoPct,
      freteNum,
      paraDecimalPct(it.comissao_percentual),
      "",
      numeroOuNulo(it.preco_original),
      "",
      "",
      "",
      numeroOuNulo(it.preco_promocional),
      "",
      "",
      numeroOuNulo(it.preco_efetivo),
      "",
      paraDecimalPct(relatorio.margem_alvo),
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      it.diagnostico || "",
      it.acao_recomendada || "",
      it.explicacao_calculo || "",
    ]);
  });

  const workbook = XLSX.utils.book_new();
  const resumoSheet = XLSX.utils.aoa_to_sheet(resumoRows);
  const matrizSheet = XLSX.utils.aoa_to_sheet(matrizRows);

  const setFormula = (ws, addr, formula, format) => {
    ws[addr] = { ...(ws[addr] || {}), f: formula };
    if (format) ws[addr].z = format;
  };
  const setFormat = (ws, addr, format) => {
    if (!ws[addr]) return;
    ws[addr].z = format;
  };
  const setStyle = (ws, addr, style) => {
    ws[addr] = { ...(ws[addr] || { t: "s", v: "" }), s: style };
  };
  const paintRange = (ws, startCol, endCol, row, style) => {
    for (let c = startCol; c <= endCol; c++) {
      const addr = XLSX.utils.encode_cell({ c, r: row - 1 });
      setStyle(ws, addr, style);
    }
  };

  for (let row = 4; row < 4 + itens.length; row++) {
    setFormula(matrizSheet, `L${row}`, `IFERROR(K${row}-K${row}*G${row}-K${row}*I${row}-H${row}-F${row},"")`, "R$ #,##0.00");
    setFormula(matrizSheet, `M${row}`, `IFERROR(L${row}/K${row},"")`, "0.00%");
    setFormula(matrizSheet, `P${row}`, `IFERROR(O${row}-O${row}*G${row}-O${row}*I${row}-H${row}-F${row},"")`, "R$ #,##0.00");
    setFormula(matrizSheet, `Q${row}`, `IFERROR(P${row}/O${row},"")`, "0.00%");
    setFormula(matrizSheet, `U${row}`, `IFERROR((F${row}+H${row})/(1-G${row}-I${row}-T${row}),"")`, "R$ #,##0.00");
    setFormula(matrizSheet, `V${row}`, `IFERROR(U${row}*T${row},"")`, "R$ #,##0.00");
    setFormula(matrizSheet, `X${row}`, `IF(AB${row}="sem_base","Revisar custo/base",IF(AB${row}="sem_frete","Revisar frete",IF(AB${row}="sem_comissao","Revisar comissão",IF(R${row}<U${row},"Subir preço",IF(R${row}>U${row},"Avaliar redução","Manter")))))`);
    setFormula(matrizSheet, `Y${row}`, `IF(X${row}="Subir preço",U${row},R${row})`, "R$ #,##0.00");
    setFormula(matrizSheet, `Z${row}`, `IFERROR(Y${row}-R${row},"")`, "R$ #,##0.00");
    setFormula(matrizSheet, `AA${row}`, `IFERROR(Z${row}/R${row},"")`, "0.00%");

    ["F", "H", "K", "L", "O", "P", "R", "U", "V", "Y", "Z"].forEach((col) => setFormat(matrizSheet, `${col}${row}`, "R$ #,##0.00"));
    ["G", "I", "M", "Q", "T", "AA"].forEach((col) => setFormat(matrizSheet, `${col}${row}`, "0.00%"));
  }

  setFormat(resumoSheet, "B5", "0.00%");
  setFormat(resumoSheet, "B12", "0.00%");

  matrizSheet["!autofilter"] = { ref: `A3:AD${Math.max(3, 3 + itens.length)}` };
  matrizSheet["!freeze"] = { xSplit: 0, ySplit: 3, topLeftCell: "A4", activePane: "bottomLeft", state: "frozen" };
  matrizSheet["!merges"] = [
    XLSX.utils.decode_range("A1:AD1"),
    XLSX.utils.decode_range("A2:D2"),
    XLSX.utils.decode_range("F2:M2"),
    XLSX.utils.decode_range("O2:R2"),
    XLSX.utils.decode_range("T2:V2"),
    XLSX.utils.decode_range("X2:AD2"),
  ];
  matrizSheet["!cols"] = [
    { wch: 14 }, { wch: 12 }, { wch: 48 }, { wch: 12 }, { wch: 3 },
    { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 3 }, { wch: 13 }, { wch: 13 }, { wch: 11 }, { wch: 3 },
    { wch: 14 }, { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 3 },
    { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 3 },
    { wch: 18 }, { wch: 13 }, { wch: 12 }, { wch: 11 }, { wch: 12 }, { wch: 24 }, { wch: 30 },
  ];

  const styleInstrucao = {
    font: { bold: true, color: { rgb: "374151" } },
    fill: { patternType: "solid", fgColor: { rgb: "F3F4F6" } },
    alignment: { horizontal: "left", vertical: "center" },
  };
  const styleHeaderBase = {
    font: { bold: true, color: { rgb: "1F2937" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
  };
  const styleDados = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "E5E7EB" } } };
  const styleCalc = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "DBEAFE" } } };
  const stylePromo = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "EDE9FE" } } };
  const styleSug = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "DCFCE7" } } };
  const styleDec = { ...styleHeaderBase, fill: { patternType: "solid", fgColor: { rgb: "FEF3C7" } } };
  const styleSeparador = { fill: { patternType: "solid", fgColor: { rgb: "FFFFFF" } } };

  paintRange(matrizSheet, 0, 29, 1, styleInstrucao);
  paintRange(matrizSheet, 0, 3, 2, styleDados);
  paintRange(matrizSheet, 5, 12, 2, styleCalc);
  paintRange(matrizSheet, 14, 17, 2, stylePromo);
  paintRange(matrizSheet, 19, 21, 2, styleSug);
  paintRange(matrizSheet, 23, 29, 2, styleDec);
  paintRange(matrizSheet, 4, 4, 2, styleSeparador);
  paintRange(matrizSheet, 9, 9, 2, styleSeparador);
  paintRange(matrizSheet, 13, 13, 2, styleSeparador);
  paintRange(matrizSheet, 18, 18, 2, styleSeparador);
  paintRange(matrizSheet, 22, 22, 2, styleSeparador);

  paintRange(matrizSheet, 0, 3, 3, styleDados);
  paintRange(matrizSheet, 5, 12, 3, styleCalc);
  paintRange(matrizSheet, 14, 17, 3, stylePromo);
  paintRange(matrizSheet, 19, 21, 3, styleSug);
  paintRange(matrizSheet, 23, 29, 3, styleDec);
  paintRange(matrizSheet, 4, 4, 3, styleSeparador);
  paintRange(matrizSheet, 9, 9, 3, styleSeparador);
  paintRange(matrizSheet, 13, 13, 3, styleSeparador);
  paintRange(matrizSheet, 18, 18, 3, styleSeparador);
  paintRange(matrizSheet, 22, 22, 3, styleSeparador);
  resumoSheet["!cols"] = [{ wch: 22 }, { wch: 28 }];

  XLSX.utils.book_append_sheet(workbook, resumoSheet, "Resumo");
  XLSX.utils.book_append_sheet(workbook, matrizSheet, "Matriz Mercado Livre");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  });

  const filename = montarNomeArquivoRelatorio(relatorio, "xlsx", "matriz-precificacao");

  return {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename,
    buffer,
  };
}

module.exports = {
  salvarRelatorioAutomacoes,
  listarRelatoriosAutomacoes,
  listarPastasRelatorios,
  criarPastaRelatorios,
  atualizarPastaRelatorios,
  excluirPastaRelatorios,
  moverRelatorioParaPasta,
  buscarDetalheRelatorioAutomacoes,
  excluirRelatorioAutomacoes,
  gerarExportRelatorioCsv,
  gerarExportRelatorioXlsx,
};

