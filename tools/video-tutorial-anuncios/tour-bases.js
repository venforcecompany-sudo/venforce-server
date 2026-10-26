// Vídeo tutorial da página Bases de Custo (Portal/bases.html): clientes e
// contas, itens da base, edição, atualização por planilha e importação de uma
// base nova, com dados de demonstração (bases-mock.js — nenhuma chamada ao
// servidor real).
//
// Uso: node tools/video-tutorial-anuncios/tour-bases.js
// Saída em out/bases/tutorial-bases.mp4 (+ capitulos.json).
"use strict";
const { gravar } = require("./gravador");
const { rotear } = require("./bases-mock");

const CARTOES = "#bases-contas";
const CARTAO_OFICIAL = ".vf-bases-conta:has-text('CASABELLA OFICIAL')";
const CARTAO_OUTLET = ".vf-bases-conta:has-text('CASABELLA OUTLET')";
const CARTAO_SHOPEE = ".vf-bases-conta:has-text('casabella.shop')";
const planilha = (nome) => ({ name: nome, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("planilha de demonstração") });

gravar({
  nome: "bases",
  caminho: "bases.html",
  rotear,
  role: "admin",
  prontoQuando: (page) => page.waitForSelector(".vf-bases-cli", { timeout: 20000 }),
  roteiro: async ({ page, wait, go, click, hl, hlOff, cap, capOff, card, scrollTo, scrollToEl, digitar }) => {
    // Rola até o elemento mesmo dentro de painéis com rolagem própria.
    const centralizar = async (sel) => {
      await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ behavior: "smooth", block: "center" }), sel);
      await wait(1000);
    };
    // Nos modais o rodapé (botões) fica atrás da legenda: ela sobe para o topo.
    const legendaNoTopo = (topo) => page.evaluate((topo) => {
      Object.assign(document.getElementById("tv-cap").style, topo ? { top: "28px", bottom: "auto" } : { top: "", bottom: "" });
    }, topo);

    // ── Abertura ─────────────────────────────────────────────────────────
    await card('<div class="k">VenForce · Guia rápido</div><div class="t">Bases de Custo</div><div class="s">Como conferir, corrigir e importar o custo, o imposto e a taxa de cada produto</div>', 4200);

    // ── 1. Lista de clientes ─────────────────────────────────────────────
    await cap("1", "A tela é organizada por <u>cliente</u>. À esquerda ficam os clientes, com os marketplaces e o número de bases de cada um.");
    await hl(".vf-bases-clientes", 6);
    await go(".vf-bases-cli >> nth=1");
    await wait(2600);
    await cap("1", "O <u>ponto laranja</u> indica pendência: conta sem base ou base desatualizada. Busque por cliente, conta ou nome da base.");
    await go(".vf-bases-cli >> nth=0", 270);
    await wait(1600);
    await click("[data-cli-filtro='pendencia']");
    await wait(2000);
    await click("[data-cli-filtro='']");
    await wait(600);
    await digitar("#bases-busca", "casa bella");
    await wait(1600);
    await hlOff();
    await click(".vf-bases-cli[data-cli-key='c:87']");
    await page.locator("#bases-busca").fill("");
    await wait(1400);

    // ── 2. Contas do cliente ─────────────────────────────────────────────
    await cap("2", "À direita, <u>um cartão por conta conectada</u>, com a base de custo vinculada a ela, o número de itens e a idade da base.");
    await hl(CARTOES, 6);
    await wait(4200);
    await hlOff();
    await cap("2", "Nas contas do Mercado Livre, a barra mostra quantos <u>anúncios têm custo</u> na base. O link leva aos sem custo em Anúncios ML.");
    await hl(CARTAO_OFICIAL + " .vf-bases-cov", 8);
    await go(CARTAO_OFICIAL + " .vf-bases-cov__link");
    await wait(4200);
    await cap("2", "Base sem atualização há mais de <u>30 dias</u> aparece em laranja: vale pedir a planilha nova ao cliente.");
    await hl(CARTAO_OUTLET + " .vf-status", 8);
    await wait(3600);
    await cap("2", "Conta <u>sem base</u> fica tracejada: a margem dos anúncios dela não é calculada. Vamos resolver isso mais adiante.");
    await hl(CARTAO_SHOPEE, 4);
    await wait(3800);
    await hlOff();

    // ── 3. Itens da base ─────────────────────────────────────────────────
    await click(CARTAO_OFICIAL + " .vf-bases-conta__abrir");
    await scrollToEl("#bases-drawer", 20);
    await cap("3", "Clique no nome da conta para abrir os <u>itens da base</u>: custo, imposto e taxa fixa de cada produto.");
    await hl("#bases-drawer .vf-bases-itens__head", 4);
    await wait(3600);
    await hlOff();
    await cap("3", "Os filtros ficam no cabeçalho da tabela: busque um MLB ou filtre <u>Custo → Zerado</u> para achar o que falta.");
    await digitar("#cost-filter-produto", "MLB345679");
    await wait(1800);
    await page.locator("#cost-filter-produto").fill("");
    await page.dispatchEvent("#cost-filter-produto", "input");
    await go("#cost-filter-custo");
    await page.selectOption("#cost-filter-custo", "zerado");
    await wait(900);
    await hl("#bases-costs-table", 4);
    await wait(2600);
    await hlOff();

    // ── 4. Editar e adicionar item ───────────────────────────────────────
    await cap("4", "Clique no <u>lápis</u> (ou na linha) para editar. Digite o custo e clique em <u>Salvar alterações</u>.");
    await click(page.locator(".b-cost-edit").first());
    await wait(900);
    await digitar("#cost-form-custo", "29.90");
    await wait(700);
    await click("#cost-form-save");
    await wait(1600);
    await cap("4", "Salvo: o item já saiu da lista de custo zerado.");
    await hl("#bases-costs-table", 4);
    await wait(2800);
    await hlOff();
    await page.selectOption("#cost-filter-custo", "todos");
    await page.dispatchEvent("#cost-filter-custo", "change");
    await wait(600);
    await cap("4", "<u>+ Adicionar item</u> cadastra um produto novo. Se o MLB já existir na base, os valores são atualizados.");
    await click("#bases-drawer-add");
    await wait(800);
    await digitar("#cost-form-produto", "MLB4012345703");
    await digitar("#cost-form-custo", "45.50");
    await digitar("#cost-form-imposto", "6");
    await digitar("#cost-form-taxa", "6.75");
    await wait(600);
    await click("#cost-form-save");
    await wait(1400);
    await hl("#bases-cost-panel .vf-bases-cost-feedback", 6);
    await wait(2400);
    await hlOff();
    await click("#cost-form-close");
    await wait(600);

    // ── 5. Atualizar por planilha ────────────────────────────────────────
    await cap("5", "Para muitos itens, use <u>Atualizar por planilha</u>: atualiza os produtos existentes e adiciona os novos.");
    await click("#bases-drawer-planilha");
    await wait(1000);
    await hl("#bases-cost-panel .vf-banner >> nth=0", 6);
    await wait(2600);
    await hlOff();
    await go("#cost-planilha-label");
    await page.setInputFiles("#cost-planilha-arquivo", planilha("custos-casabella-outubro.xlsx"));
    await wait(1200);
    await click("#cost-planilha-preview");
    await page.waitForSelector("#cost-planilha-confirm", { timeout: 15000 });
    await wait(600);
    await cap("5", "A <u>pré-visualização</u> mostra o que será atualizado e o que será adicionado. Nenhum item que ficou fora da planilha é apagado.");
    await centralizar("#cost-planilha-preview-box .vf-bases-resumo");
    await hl("#cost-planilha-preview-box .vf-bases-resumo", 8);
    await wait(4400);
    await hlOff();
    await centralizar("#cost-planilha-preview-box .vf-bases-planilha-wrap");
    await wait(2200);
    await cap("5", "Confira e clique em <u>Confirmar atualização incremental</u>.");
    await centralizar("#cost-planilha-confirm");
    await click("#cost-planilha-confirm");
    await page.waitForSelector("#cost-planilha-result:not([style*='none'])", { timeout: 20000 });
    await centralizar("#cost-planilha-result");
    await hl("#cost-planilha-result", 6);
    await wait(3200);
    await hlOff();
    await click("#cost-planilha-close");
    await wait(500);
    await scrollTo(0);
    await cap("5", "Com os custos completos, a conta passa a ter <u>100% dos anúncios com custo</u>.");
    await hl(CARTAO_OFICIAL + " .vf-bases-cov", 8);
    await wait(3400);
    await hlOff();

    // ── 6. Importar base para conta sem base ─────────────────────────────
    await cap("6", "Na conta sem base, clique em <u>Importar planilha</u>: a importação já abre com marketplace, cliente e conta escolhidos.");
    await click(CARTAO_SHOPEE + " [data-import-conta]");
    await legendaNoTopo(true);
    await page.waitForFunction(() => document.getElementById("import-conta").value === "44", null, { timeout: 15000 });
    await wait(600);
    await hl("#bases-import-backdrop .vf-modal__body .vf-field >> nth=0", 4);
    await wait(1200);
    await hl("#import-conta-field", 4);
    await wait(2400);
    await hlOff();
    await cap("6", "Dê um <u>nome à base</u>, escolha a planilha de custos e clique em <u>Pré-visualizar</u>.");
    await digitar("#import-nome", "casabella_shopee");
    await go("#file-label");
    await page.setInputFiles("#import-arquivo", planilha("custos-shopee-casabella.xlsx"));
    await wait(1400);
    await click("#btn-importar");
    await page.waitForSelector("#preview-overlay[style*='flex']", { timeout: 15000 });
    await capOff();
    await legendaNoTopo(false);
    await wait(600);
    await cap("6", "A pré-visualização mostra as linhas lidas e os IDs válidos. Confira e clique em <u>Confirmar importação</u>.");
    await hl("#preview-meta", 6);
    await wait(3200);
    await hlOff();
    await capOff();
    await click("#preview-confirm");
    await page.waitForSelector("#bases-feedback:not([style*='none'])", { timeout: 20000 });
    await scrollTo(0);
    await cap("6", "Pronto: a base foi criada <u>já vinculada à conta</u>, e o cartão deixa de ser tracejado.");
    await hl("#bases-feedback", 4);
    await wait(2200);
    await hl(CARTAO_SHOPEE, 4);
    await wait(3000);
    await hlOff();

    // ── 7. Mais ações ────────────────────────────────────────────────────
    await cap("7", "No <u>⋯</u> de cada cartão: alterar o cliente/vínculo, baixar a base em CSV ou desativá-la (custos e histórico são preservados).");
    await click(CARTAO_SHOPEE + " .b-menu-trigger");
    await wait(4800);
    await click(".vf-page-header__title");
    await wait(500);

    // ── 8. Importar nova base ────────────────────────────────────────────
    await cap("8", "<u>Importar nova base</u>, no topo, cria uma base do zero: escolha marketplace, cliente, conta e envie a planilha.");
    await click("#btn-abrir-importar");
    await wait(1200);
    await page.selectOption("#import-marketplace", "meli");
    await page.dispatchEvent("#import-marketplace", "change");
    await wait(1600);
    await cap("8", "Planilha fora do padrão? <u>Normalizar com assistente</u> identifica ID, custo e imposto antes de importar.");
    await hl("#bases-assist-toggle", 8);
    await wait(3600);
    await hlOff();
    await capOff();
    await click("#bases-import-cancel");
    await wait(600);

    // ── Fechamento ───────────────────────────────────────────────────────
    await card('<div class="k">Resumo</div><div class="t">Bases de Custo</div><ul>' +
      '<li>Escolha o cliente na lista</li><li>Um cartão por conta conectada</li><li>Barra: anúncios com custo</li><li>Laranja: base com +30 dias</li>' +
      '<li>Filtre custo zerado e edite</li><li>Adicione itens um a um</li><li>Atualize por planilha</li><li>Importe base na conta sem base</li></ul>', 5500);
  },
}).catch((e) => { console.error(e); process.exit(1); });
