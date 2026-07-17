// server/controllers/meliAnunciosController.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — controller.
//
// Orquestra os services e responde os endpoints. Padrão de resposta:
//   - sucesso .................. { ok: true, ... }
//   - erro de validação ........ HTTP 400/404 + { ok: false, motivo }
//   - falha "esperada" de sync . HTTP 200 + { ok: false, codigo, motivo }
//
// Sincronização, detalhe e otimizador são read-only no Mercado Livre.
// A criação de anúncios (meliCriacaoService) é a única escrita intencional.
// -----------------------------------------------------------------------------

const anunciosService = require("../services/meliAnuncios/meliAnunciosService");
const syncService = require("../services/meliAnuncios/meliSyncService");
const otimizadorService = require("../services/meliAnuncios/otimizadorMeliService");
const criacaoService = require("../services/meliAnuncios/meliCriacaoService");
const { mlFetch } = require("../utils/mlClient");

// ----------------------------------------------------------------------------
// GET /anuncios-meli/clientes
// ----------------------------------------------------------------------------
async function listarClientes(req, res) {
  try {
    const clientes = await anunciosService.listarClientes();
    return res.json({ ok: true, clientes });
  } catch (err) {
    console.error("[anuncios-meli] listarClientes:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao carregar a lista de clientes." });
  }
}

// ----------------------------------------------------------------------------
// POST /anuncios-meli/sync   body: { clienteSlug, modo }
// ----------------------------------------------------------------------------
async function sincronizar(req, res) {
  try {
    const { clienteSlug, modo } = req.body || {};

    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({
        ok: false,
        codigo: "NO_CLIENT",
        motivo: "Cliente não encontrado.",
      });
    }

    const resultado = await syncService.sincronizar({
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      modo,
    });

    // Falhas esperadas (sem token, erro de API) voltam como 200 + ok:false
    // para o frontend tratar com mensagem amigável.
    return res.json(resultado);
  } catch (err) {
    console.error("[anuncios-meli] sincronizar:", err.message);
    return res.status(500).json({
      ok: false,
      codigo: "ERRO_INTERNO",
      motivo: "Erro interno ao sincronizar os anúncios.",
    });
  }
}

// ----------------------------------------------------------------------------
// GET /anuncios-meli/resumo?clienteSlug=
// ----------------------------------------------------------------------------
async function resumo(req, res) {
  try {
    const { clienteSlug } = req.query || {};
    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res
        .status(404)
        .json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const dados = await anunciosService.obterResumo(cliente.id);
    return res.json({
      ok: true,
      cliente: { slug: cliente.slug, nome: cliente.nome },
      resumo: dados,
    });
  } catch (err) {
    console.error("[anuncios-meli] resumo:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao montar o resumo." });
  }
}

// ----------------------------------------------------------------------------
// GET /anuncios-meli?clienteSlug=&q=&status=&filtro=&page=&limit=
// ----------------------------------------------------------------------------
async function listar(req, res) {
  try {
    const { clienteSlug, q, status, filtro, page, limit } = req.query || {};
    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res
        .status(404)
        .json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await anunciosService.listarAnuncios({
      clienteId: cliente.id,
      q,
      status,
      filtro,
      page,
      limit,
    });

    return res.json({
      ok: true,
      cliente: { slug: cliente.slug, nome: cliente.nome },
      anuncios: resultado.anuncios,
      paginacao: resultado.paginacao,
    });
  } catch (err) {
    console.error("[anuncios-meli] listar:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao listar os anúncios." });
  }
}

// ----------------------------------------------------------------------------
// GET /anuncios-meli/:itemId?clienteSlug=
// Busca o anúncio no banco e enriquece com a descrição ao vivo da API ML.
// ----------------------------------------------------------------------------
async function detalhe(req, res) {
  try {
    const { itemId } = req.params;
    const { clienteSlug } = req.query || {};

    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res
        .status(404)
        .json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const anuncio = await anunciosService.obterAnuncio(cliente.id, itemId);
    if (!anuncio) {
      return res.status(404).json({
        ok: false,
        motivo:
          "Anúncio não encontrado no banco. Sincronize os anúncios deste cliente.",
      });
    }

    // Descrição buscada sob demanda (não é salva na sincronização em massa).
    let descricao = null;
    try {
      const resp = await mlFetch(
        cliente.id,
        `/items/${encodeURIComponent(itemId)}/description`
      );
      if (resp && resp.ok && resp.data) {
        descricao = resp.data.plain_text || resp.data.text || null;
      }
    } catch (e) {
      // descrição é opcional — segue sem ela
      descricao = null;
    }

    return res.json({
      ok: true,
      cliente: { slug: cliente.slug, nome: cliente.nome },
      anuncio,
      descricao,
    });
  } catch (err) {
    console.error("[anuncios-meli] detalhe:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao carregar o detalhe do anúncio." });
  }
}

// ----------------------------------------------------------------------------
// PATCH /anuncios-meli/:itemId/revisao   body: { clienteSlug, revisado }
// ----------------------------------------------------------------------------
async function marcarRevisado(req, res) {
  try {
    const { itemId } = req.params;
    const { clienteSlug, revisado } = req.body || {};

    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res
        .status(404)
        .json({ ok: false, motivo: "Cliente não encontrado." });
    }

    await anunciosService.marcarRevisado(cliente.id, itemId, revisado);
    return res.json({ ok: true, revisado: !!revisado });
  } catch (err) {
    console.error("[anuncios-meli] marcarRevisado:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao atualizar a revisão." });
  }
}

// ----------------------------------------------------------------------------
// POST /anuncios-meli/:itemId/otimizar
// body: { clienteSlug, tipo }   tipo = seo | descricao | ficha_tecnica
// Gera sugestão textual com IA e salva no banco. NÃO atualiza o Mercado Livre.
// ----------------------------------------------------------------------------
async function otimizar(req, res) {
  try {
    const { itemId } = req.params;
    const { clienteSlug, tipo } = req.body || {};

    const resultado = await otimizadorService.otimizar({
      clienteSlug: clienteSlug,
      itemId: itemId,
      tipo: tipo,
      userId: req.user && req.user.id,
    });

    // o service devolve o http status apropriado (400/404/200/500)
    const http = resultado.http || (resultado.ok ? 200 : 400);
    if (resultado.ok) {
      return res.json({
        ok: true,
        tipo: resultado.tipo,
        otimizacao: resultado.otimizacao,
      });
    }
    return res.status(http).json({
      ok: false,
      codigo: resultado.codigo,
      motivo: resultado.motivo,
    });
  } catch (err) {
    console.error("[anuncios-meli] otimizar:", err.message);
    return res.status(500).json({
      ok: false,
      codigo: "ERRO_INTERNO",
      motivo: "Erro interno ao gerar a otimização.",
    });
  }
}

// ----------------------------------------------------------------------------
// GET /anuncios-meli/:itemId/otimizacoes?clienteSlug=&tipo=
// Histórico de sugestões já geradas para um anúncio.
// ----------------------------------------------------------------------------
async function listarOtimizacoes(req, res) {
  try {
    const { itemId } = req.params;
    const { clienteSlug, tipo } = req.query || {};

    if (!clienteSlug) {
      return res
        .status(400)
        .json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const resultado = await otimizadorService.listarOtimizacoes({
      clienteSlug: clienteSlug,
      itemId: itemId,
      tipo: tipo,
    });

    if (!resultado.ok) {
      return res
        .status(resultado.http || 400)
        .json({ ok: false, motivo: resultado.motivo });
    }
    return res.json({ ok: true, otimizacoes: resultado.otimizacoes });
  } catch (err) {
    console.error("[anuncios-meli] listarOtimizacoes:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao listar as otimizações." });
  }
}

// ----------------------------------------------------------------------------
// PATCH /anuncios-meli/otimizacoes/:id/aprovar
// body: { tituloAprovado?, modeloAprovado?, descricaoAprovada?,
//         fichaAprovadaJson?, observacao? }
// Registra escolha humana sobre a sugestão. NÃO envia nada ao Mercado Livre.
// ----------------------------------------------------------------------------
async function aprovarOtimizacao(req, res) {
  try {
    const { id } = req.params;
    const resultado = await otimizadorService.aprovar({
      id: parseInt(id, 10),
      dados: req.body || {},
      userId: req.user && req.user.id,
    });
    if (!resultado.ok) {
      return res
        .status(resultado.http || 400)
        .json({ ok: false, motivo: resultado.motivo });
    }
    return res.json({ ok: true, otimizacao: resultado.otimizacao });
  } catch (err) {
    console.error("[anuncios-meli] aprovarOtimizacao:", err.message);
    return res
      .status(500)
      .json({ ok: false, motivo: "Erro ao aprovar a otimização." });
  }
}

// ----------------------------------------------------------------------------
// Criação de Anúncios ML
// ----------------------------------------------------------------------------

async function criacaoStatus(req, res) {
  try {
    const { clienteSlug } = req.query || {};
    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const status = await criacaoService.obterStatusConta(cliente.id);
    return res.json({
      ok: !!status.ok,
      cliente: { slug: cliente.slug, nome: cliente.nome },
      ...status,
    });
  } catch (err) {
    console.error("[anuncios-meli] criacaoStatus:", err.message);
    return res.status(500).json({
      ok: false,
      motivo: "Erro ao validar a conta Mercado Livre.",
    });
  }
}

async function criacaoCategorias(req, res) {
  try {
    const { clienteSlug, q } = req.query || {};
    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await criacaoService.buscarCategorias(cliente.id, q);
    if (!resultado.ok) {
      return res.status(resultado.statusMl || 400).json(resultado);
    }
    return res.json(resultado);
  } catch (err) {
    console.error("[anuncios-meli] criacaoCategorias:", err.message);
    return res.status(500).json({
      ok: false,
      motivo: "Erro ao buscar categorias no Mercado Livre.",
    });
  }
}

async function criacaoAtributos(req, res) {
  try {
    const { categoryId } = req.params;
    const { clienteSlug } = req.query || {};
    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await criacaoService.obterAtributosCategoria(
      cliente.id,
      categoryId
    );
    if (!resultado.ok) {
      return res.status(resultado.statusMl || 400).json(resultado);
    }
    return res.json(resultado);
  } catch (err) {
    console.error("[anuncios-meli] criacaoAtributos:", err.message);
    return res.status(500).json({
      ok: false,
      motivo: "Erro ao carregar atributos da categoria.",
    });
  }
}

async function criacaoSaleTerms(req, res) {
  try {
    const { categoryId } = req.params;
    const { clienteSlug } = req.query || {};
    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await criacaoService.obterSaleTermsCategoria(
      cliente.id,
      categoryId
    );
    if (!resultado.ok) {
      return res.status(resultado.statusMl || 400).json(resultado);
    }
    return res.json(resultado);
  } catch (err) {
    console.error("[anuncios-meli] criacaoSaleTerms:", err.message);
    return res.status(500).json({
      ok: false,
      motivo: "Erro ao carregar termos comerciais da categoria.",
    });
  }
}

async function criacaoListingTypes(req, res) {
  try {
    const { clienteSlug } = req.query || {};
    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await criacaoService.obterTiposAnuncio(cliente.id);
    if (!resultado.ok) {
      return res.status(resultado.statusMl || 400).json(resultado);
    }
    return res.json(resultado);
  } catch (err) {
    console.error("[anuncios-meli] criacaoListingTypes:", err.message);
    return res.status(500).json({
      ok: false,
      motivo: "Erro ao carregar tipos de anúncio.",
    });
  }
}

async function publicarAnuncio(req, res) {
  try {
    const body = req.body || {};
    const { clienteSlug } = body;

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, motivo: "Informe o clienteSlug." });
    }

    const cliente = await anunciosService.resolverCliente(clienteSlug);
    if (!cliente) {
      return res.status(404).json({ ok: false, motivo: "Cliente não encontrado." });
    }

    const resultado = await criacaoService.createMercadoLivreItem({
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      dados: body,
      createdBy: req.user && req.user.id,
    });

    if (!resultado.ok) {
      return res.status(resultado.http || 400).json({
        ok: false,
        codigo: resultado.codigo,
        motivo: resultado.motivo,
        erros: resultado.erros || [],
        statusMl: resultado.statusMl || null,
      });
    }

    return res.status(201).json({
      ok: true,
      item_id: resultado.item_id,
      permalink: resultado.permalink,
      status: resultado.status,
      listing_type_id: resultado.listing_type_id,
      category_id: resultado.category_id,
      descricaoSalva: resultado.descricaoSalva,
      descricaoErro: resultado.descricaoErro,
      publicacaoId: resultado.publicacaoId,
      cliente: { slug: cliente.slug, nome: cliente.nome },
    });
  } catch (err) {
    console.error("[anuncios-meli] publicarAnuncio:", err.message);
    return res.status(500).json({
      ok: false,
      codigo: "ERRO_INTERNO",
      motivo: "Erro interno ao publicar o anúncio.",
    });
  }
}

module.exports = {
  listarClientes,
  sincronizar,
  resumo,
  listar,
  detalhe,
  marcarRevisado,
  otimizar,
  listarOtimizacoes,
  aprovarOtimizacao,
  criacaoStatus,
  criacaoCategorias,
  criacaoAtributos,
  criacaoSaleTerms,
  criacaoListingTypes,
  publicarAnuncio,
};
