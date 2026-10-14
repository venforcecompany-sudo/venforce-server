// server/routes/meliAnunciosRoutes.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — rotas.
//
// Montagem esperada em server/index.js:
//   const meliAnunciosRoutes = require("./routes/meliAnunciosRoutes");
//   app.use("/anuncios-meli", meliAnunciosRoutes);
//
// Proteção base do módulo: authMiddleware + requireAutomacoesAccess
//   (admin | user | membro). As rotas do Otimizador IA têm trava extra
//   requireAdmin (admin-only) — temporária, ver mais abaixo.
//
// Endpoints finais:
//   GET    /anuncios-meli/clientes
//   POST   /anuncios-meli/sync
//   GET    /anuncios-meli/resumo
//   GET    /anuncios-meli/familias            (listagem unificada da tela)
//   GET    /anuncios-meli/familias/:familyId  (expansão de um agrupador)
//   GET    /anuncios-meli/performance         (métricas 7d + margem, assíncrono)
//   GET    /anuncios-meli
//   GET    /anuncios-meli/criacao/status
//   GET    /anuncios-meli/criacao/categorias
//   GET    /anuncios-meli/criacao/categorias/:categoryId/atributos
//   GET    /anuncios-meli/criacao/categorias/:categoryId/sale-terms
//   GET    /anuncios-meli/criacao/listing-types
//   POST   /anuncios-meli/criacao/publicar
//   POST   /anuncios-meli/:itemId/otimizar        (Otimizador IA — admin-only)
//   POST   /anuncios-meli/:itemId/seo/titulos     (Title Engine SEO — admin-only, sem escrita)
//   POST   /anuncios-meli/:itemId/seo/termos-complementares (Termos Complementares SEO — admin-only, sem IA, sem escrita)
//   POST   /anuncios-meli/:itemId/seo/descricao   (Description Engine SEO — admin-only, sem escrita)
//   GET    /anuncios-meli/:itemId/otimizacoes     (histórico — admin-only)
//   PATCH  /anuncios-meli/otimizacoes/:id/aprovar (aprovação — admin-only)
//   GET    /anuncios-meli/:itemId
//   GET    /anuncios-meli/:itemId/variacoes-legado (expansão do modelo legado)
//   GET    /anuncios-meli/:itemId/promocoes    (promoções oficiais do item, read-only)
//   POST   /anuncios-meli/:itemId/promocoes/:promotionId/aplicar (escrita real, DEAL/SELLER_CAMPAIGN)
//   POST   /anuncios-meli/:itemId/promocoes/:promotionId/participar (ACEITE — preço definido pelo ML)
//   POST   /anuncios-meli/:itemId/promocoes/:promotionId/sair       (ACEITE — deixar de participar)
//   PATCH  /anuncios-meli/:itemId/variacoes-legado/:variationId/estoque (escrita real)
//   POST   /anuncios-meli/:itemId/imagens       (adiciona uma imagem, anúncio sem variação)
//   GET    /anuncios-meli/:itemId/fotos/variacoes (editor de fotos: leitura ao vivo)
//   PUT    /anuncios-meli/:itemId/fotos         (editor de fotos: escrita real no ML)
//   PATCH  /anuncios-meli/:itemId/revisao
//   PATCH  /anuncios-meli/:itemId/conteudo      (edição real no Mercado Livre)
//   PATCH  /anuncios-meli/:itemId/estoque       (edição real no Mercado Livre)
//   PATCH  /anuncios-meli/:itemId/preco         (edição real no Mercado Livre)
//   POST   /anuncios-meli/:itemId/simular-margem (simulação local, sem escrita)
//   GET    /anuncios-meli/custos               (custo atual da Base por MLB da página)
//   POST   /anuncios-meli/custos/lote          (custo na Base de Custos, pela lista)
// -----------------------------------------------------------------------------

const express = require("express");
const multer = require("multer");
const router = express.Router();

const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteNaCarteira } = require("../middlewares/carteiraMiddleware");
const ctrl = require("../controllers/meliAnunciosController");
const imagemValidator = require("../services/designImage/designImageValidator");

// Upload de imagem do anúncio: memória, como o resto do servidor (o disco do
// Render é efêmero) — o arquivo só existe até ser repassado ao CDN do ML.
const uploadImagem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imagemValidator.MAX_UPLOAD_BYTES, files: 1 },
});

// Editor de fotos: várias imagens novas num único salvar.
const MAX_FOTOS_POR_SALVAR = 10;
const uploadFotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: imagemValidator.MAX_UPLOAD_BYTES, files: MAX_FOTOS_POR_SALVAR },
});

// Planilha de custos ("Importar base de custo"): memória, um arquivo só.
const MAX_PLANILHA_CUSTOS_BYTES = 10 * 1024 * 1024;
const uploadPlanilhaCustos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PLANILHA_CUSTOS_BYTES, files: 1 },
});

function tratarErroUploadPlanilha(err, req, res, next) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, codigo: "ARQUIVO_GRANDE", motivo: "Planilha muito grande. O limite é de 10 MB." });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({ ok: false, codigo: "CAMPO_INVALIDO", motivo: 'Envie exatamente um arquivo no campo "arquivo".' });
  }
  return next(err);
}

// Erros do Multer no mesmo formato de recusa da rota (codigo/motivo/etapa),
// em vez de estourar como 500 no handler global.
function tratarErroUploadImagem(err, req, res, next) {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    const limite = Math.round(imagemValidator.MAX_UPLOAD_BYTES / (1024 * 1024));
    return res.status(413).json({
      ok: false, codigo: "ARQUIVO_GRANDE", etapa: "validacao",
      motivo: `Imagem muito grande. O limite é de ${limite} MB.`,
    });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
    const editor = req.method === "PUT";
    return res.status(400).json({
      ok: false, codigo: "CAMPO_INVALIDO", etapa: "validacao",
      motivo: editor
        ? `Envie as imagens no campo "novas", até ${MAX_FOTOS_POR_SALVAR} por vez.`
        : 'Envie exatamente um arquivo no campo "imagem".',
    });
  }
  return next(err);
}

// Todas as rotas exigem usuário autenticado com acesso a automações.
router.use(authMiddleware, requireAutomacoesAccess);

// P2.1 — seam de carteira no router. Todo endpoint client-scoped recebe
// `clienteSlug` (query nas leituras, body nas escritas/sync/criação) e o usa
// para resolver o cliente e o grant ML. `/clientes` (lista) e
// `/otimizacoes/:id/aprovar` (admin-only, sem clienteSlug) passam direto —
// o guard é pass-through quando não há referência de cliente.
router.use(requireClienteNaCarteira({ query: "clienteSlug", body: "clienteSlug" }));

// Rotas estáticas declaradas ANTES de "/:itemId" para evitar conflito.

// Custo do produto editado na lista (pontual e "Editar custos" em massa) —
// grava na Base de Custos resolvida pelo contexto do Motor (nunca por slug do
// front). Mesmo acesso das demais escritas do módulo + carteira do cliente.
router.get("/custos", ctrl.lerCustos);
router.post("/custos/lote", ctrl.salvarCustosLote);
// "Importar base de custo": XLSX da conta inteira (com e sem custo) e a prévia
// do preenchido. Nenhuma grava — a gravação é /custos/lote. clienteSlug na
// QUERY no POST, pelo mesmo motivo do POST /imagens.
router.get("/custos/planilha", ctrl.baixarPlanilhaCustos);
router.post(
  "/custos/planilha/previa",
  uploadPlanilhaCustos.single("arquivo"),
  tratarErroUploadPlanilha,
  ctrl.previaPlanilhaCustos
);
router.get("/clientes", ctrl.listarClientes);
router.post("/sync", ctrl.sincronizar);
router.get("/resumo", ctrl.resumo);
router.get("/", ctrl.listar);

// DÍVIDA DE NOMENCLATURA — o caminho "/familias" está vencido.
//
// Histórico: a rota nasceu listando FAMÍLIAS. A tela tinha duas abas
// ("Anúncios em Família" e "Anúncios sem agrupamento") e esta rota servia a
// primeira, devolvendo `{ familias: [], sem_user_product: {} }`.
//
// Hoje: depois da unificação da listagem, ela devolve GRUPOS DE ANÚNCIOS —
// uma lista só, em `{ anuncios: [], paginacao }`. Cada grupo é uma de duas
// formas, e `tipo` é o único campo que as distingue:
//
//   tipo: "familia"  -> família com user_products/items abaixo (expansível
//                       por GET /familias/:familyId);
//   tipo: "item"     -> anúncio individual, sem agrupamento (o registro
//                       inteiro de meli_anuncios; nada para expandir, porque
//                       no modelo do ML a relação ali é 1:1).
//
// Renomear exige MIGRAÇÃO DOS CONSUMIDORES, não um alias: criar o caminho
// novo, migrar Portal/anuncios-meli.js (hoje o único consumidor da listagem
// e da expansão) e só então remover o antigo — ou seja, criar um endpoint e
// remover outro. Fora do escopo desta entrega, que se limitou a tratamento
// de dados e renderização. Não confundir com GET /anuncios-meli (raiz), que
// é a listagem PLANA e segue sendo contrato do Motor de Margem
// (Portal/central-margem-api.js) — aquela não mudou.
//
// Ver docs/AUDITORIA_ANUNCIOS_ML_LISTAGEM_UNIFICADA.md (§4.5, contrato).
//
// Ambas precisam vir ANTES de "/:itemId" (linha mais abaixo) — senão a rota
// dinâmica captura "/familias" como se fosse um itemId.
router.get("/familias", ctrl.listarAgrupado);
router.get("/familias/:familyId", ctrl.detalheFamilia);

// Enriquecimento assíncrono de performance (métricas últ. 7 dias + margem por
// MLB) — chamado pelo frontend DEPOIS que a listagem já pintou, nunca antes.
// Read-only nos dois sentidos: só lê o Mercado Livre e o Motor de Margem já
// existentes, não escreve em nada. Ver meliMetricas7dService/motorMargemService.
router.get("/performance", ctrl.performance);

// Criação de anúncios (escrita no Mercado Livre via POST /items).
router.get("/criacao/status", ctrl.criacaoStatus);
router.get("/criacao/categorias", ctrl.criacaoCategorias);
router.get(
  "/criacao/categorias/:categoryId/atributos",
  ctrl.criacaoAtributos
);
router.get(
  "/criacao/categorias/:categoryId/sale-terms",
  ctrl.criacaoSaleTerms
);
router.get("/criacao/listing-types", ctrl.criacaoListingTypes);
router.post("/criacao/publicar", ctrl.publicarAnuncio);
router.post(
  "/criacao/:itemId/precos-atacado",
  ctrl.retryPrecosAtacado
);

// Rota de aprovação — precisa vir antes de "/:itemId" pra não bater.
// Admin-only enquanto o otimizador está em validação.
router.patch("/otimizacoes/:id/aprovar", requireAdmin, ctrl.aprovarOtimizacao);

// Rotas com sub-caminho declaradas ANTES da rota genérica "/:itemId".
//
// ETAPA 1 do Otimizador: as rotas que chamam IA ficam ADMIN-ONLY
// (authMiddleware do router + requireAdmin por rota). É uma trava
// temporária — quando o otimizador sair da fase de testes, basta
// remover o requireAdmin destas linhas para voltar ao acesso
// padrão do módulo (automações: admin | user | membro).
router.post("/:itemId/otimizar", requireAdmin, ctrl.otimizar);
// Title Engine (SEO · F3): sugestões de título com score do código. Mesma
// trava admin-only do otimizador (a IA segue em validação). Não escreve no ML.
router.post("/:itemId/seo/titulos", requireAdmin, ctrl.gerarTitulosSeo);
// Termos Complementares (SEO · F4R): análise determinística, só leitura, sem
// vínculo com o MODEL. Mesma trava admin-only do restante do SEO.
router.post("/:itemId/seo/termos-complementares", requireAdmin, ctrl.gerarTermosComplementaresSeo);
// Description Engine (SEO · F5): UMA descrição por chamada, validada contra os
// fatos do anúncio, sem score. Admin-only como o resto da IA; não escreve no
// Mercado Livre (só lê descrição e categoria) nem no banco.
router.post("/:itemId/seo/descricao", requireAdmin, ctrl.gerarDescricaoSeo);
router.get("/:itemId/otimizacoes", requireAdmin, ctrl.listarOtimizacoes);

router.patch("/:itemId/revisao", ctrl.marcarRevisado);

// Edição de conteúdo do anúncio (título / modelo / descrição) NO MERCADO LIVRE.
// Fica no acesso padrão do módulo (automações + carteira), o mesmo de
// /criacao/publicar — que também escreve no ML. Não é admin-only: o
// requireAdmin do otimizador existe porque a IA está em validação, não porque
// escrever no anúncio seja privilégio de admin.
router.patch("/:itemId/conteudo", ctrl.atualizarConteudo);

// ADICIONAR imagem ao anúncio NO MERCADO LIVRE (upload ao CDN do ML +
// POST /items/{id}/pictures). Fluxo próprio, separado do /conteudo: é
// multipart. O clienteSlug vai na QUERY — o guard de carteira acima roda
// antes do multer, então só a query está disponível para ele checar. Mesmo
// acesso de /conteudo. Ver meliImagensService.
router.post(
  "/:itemId/imagens",
  uploadImagem.single("imagem"),
  tratarErroUploadImagem,
  ctrl.adicionarImagem
);
// Editor de fotos por grupo de variação (adicionar / excluir / ordenar num
// único salvar). GET lê ao vivo; PUT vira UM PUT /items completo no ML — ver
// meliFotosService. clienteSlug na QUERY, pelo mesmo motivo do POST /imagens.
router.get("/:itemId/fotos/variacoes", ctrl.lerFotosAnuncio);
router.put(
  "/:itemId/fotos",
  uploadFotos.array("novas", MAX_FOTOS_POR_SALVAR),
  tratarErroUploadImagem,
  ctrl.salvarFotosAnuncio
);

// Edição de ESTOQUE do anúncio NO MERCADO LIVRE (PUT /items { available_quantity }).
// Mesmo acesso de /conteudo, pelo mesmo motivo: é escrita no anúncio, não
// privilégio de admin. O estoque no ML pertence ao User Product, então esta
// rota também devolve os irmãos do mesmo MLBU que passam a valer o mesmo
// número — ver meliEstoqueService para a regra e a fonte na doc do ML.
router.patch("/:itemId/estoque", ctrl.atualizarEstoque);

// Edição de PREÇO do anúncio NO MERCADO LIVRE (PUT /items/{id} { price } —
// ver meliPrecoService: a API dedicada de Preços ainda não está disponível
// por doc do ML; bloqueia antes de escrever quando há variação ou promoção
// ativa). Mesmo acesso de /conteudo e /estoque.
router.patch("/:itemId/preco", ctrl.atualizarPreco);

// Simulação pura de margem (preço/custo/custos adicionais) para a composição
// do modal — sem escrita no Mercado Livre, sem persistência na Base.
router.post("/:itemId/simular-margem", ctrl.simularMargem);

// Expansão do modelo LEGADO de variações (ver meliVariacoesLegadoService) —
// precisa vir ANTES de "/:itemId" pelo mesmo motivo de sempre.
router.get("/:itemId/variacoes-legado", ctrl.variacoesLegado);

// Promoções oficiais do item (GET /seller-promotions/items/{id}, ver
// meliPromocoesService) — bloco "Promoções disponíveis" do modal. Read-only;
// precisa vir ANTES de "/:itemId" pelo mesmo motivo de sempre.
router.get("/:itemId/promocoes", ctrl.promocoes);

// Escrita REAL de participação (POST)/alteração (PUT) numa promoção — só
// DEAL/SELLER_CAMPAIGN nesta v1 (ver meliPromocoesEscritaService). Nunca
// chamado sem confirmação explícita do operador no frontend. Precisa vir
// ANTES de "/:itemId" pelo mesmo motivo de sempre.
router.post("/:itemId/promocoes/:promotionId/aplicar", ctrl.aplicarPromocao);

// Promoções em que o Mercado Livre define o preço (ACEITE — SMART,
// MARKETPLACE_CAMPAIGN, PRICE_MATCHING, PRE_NEGOTIATED, UNHEALTHY_STOCK): só
// participar (POST sem preço) ou deixar de participar (DELETE). Mesmo acesso
// e mesma confirmação explícita de /aplicar.
router.post("/:itemId/promocoes/:promotionId/participar", ctrl.participarPromocao);
router.post("/:itemId/promocoes/:promotionId/sair", ctrl.sairPromocao);

// Edição de ESTOQUE de uma variação do modelo LEGADO NO MERCADO LIVRE (ver
// meliVariacoesLegadoEstoqueService — GET fresco -> PUT /items { variations
// inteiro } -> GET de confirmação). Mesmo acesso de /estoque e /conteudo.
router.patch("/:itemId/variacoes-legado/:variationId/estoque", ctrl.atualizarEstoqueVariacaoLegado);

router.get("/:itemId", ctrl.detalhe);

module.exports = router;
