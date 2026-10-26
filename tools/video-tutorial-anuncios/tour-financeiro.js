// Vídeo tutorial da página Financeiro (Portal/financeiro-v3.html): o
// fechamento de Setembro/2026 de ponta a ponta, com dados de demonstração
// (financeiro-mock.js — nenhuma chamada ao servidor real).
//
// Uso: node tools/video-tutorial-anuncios/tour-financeiro.js
// Saída em out/financeiro/tutorial-financeiro.mp4 (+ capitulos.json).
"use strict";
const fs = require("fs");
const path = require("path");
const { gravar } = require("./gravador");
const { rotear } = require("./financeiro-mock");

const DRAWER = ".vf-drawer";
const FECHAR_DRAWER = ".vf-drawer button[aria-label='Fechar']";
const ETAPAS = "aside[aria-label='Etapas do fechamento']";
const KPIS = "[data-testid='kpis-processamento']";

gravar({
  nome: "financeiro",
  caminho: "financeiro-v3.html?cliente=casabella&conta=42&periodo=2026-09",
  rotear,
  role: "admin",
  prontoQuando: (page) => page.waitForSelector(ETAPAS, { timeout: 20000 }),
  roteiro: async ({ page, wait, go, click, hl, hlOff, cap, capOff, card, scrollTo, scrollToEl, digitar, dir }) => {
    const botao = (nome, escopo) => (escopo ? page.locator(escopo) : page).getByRole("button", { name: nome }).first();

    // ── Abertura ─────────────────────────────────────────────────────────
    await card('<div class="k">VenForce · Guia rápido</div><div class="t">Financeiro</div><div class="s">Como processar, conferir, salvar e publicar o fechamento mensal de uma operação</div>', 4200);

    // ── 1. Contexto e competência ────────────────────────────────────────
    await cap("1", "O cliente e a operação vêm da barra lateral. No topo, escolha a <u>competência</u> (o mês do fechamento) e veja o status dela.");
    await hl(".vf-shell__sidebar .vf-shell__context, .vf-shell__sidebar [class*=context]", 6);
    await go("text=Casa Bella Utilidades >> nth=0");
    await wait(1600);
    await hl(".vf-fin-cabecalho-b__acoes", 6);
    await go(".vf-fin-cabecalho-b__acoes button >> nth=0");
    await wait(1400);
    await go("[data-testid='status-competencia']");
    await wait(1800);
    await hlOff();

    // ── 2. Painel de etapas ──────────────────────────────────────────────
    await cap("2", "O fechamento tem 6 etapas. O painel mostra o que já foi feito, o que falta e o botão do próximo passo.");
    await hl(ETAPAS, 4);
    await go(ETAPAS + " [data-etapa] >> nth=0");
    await wait(1500);
    await go(ETAPAS + " [data-etapa] >> nth=1");
    await wait(1500);
    await go(ETAPAS + " [data-etapa] >> nth=5");
    await wait(1500);
    await hlOff();

    // ── 3. Preparar: base, planilha e ajustes ───────────────────────────
    await click(botao(/Enviar planilha de vendas/));
    await wait(900);
    await cap("3", "A <u>base de custos</u> vinculada à conta é usada automaticamente — não precisa enviar planilha de custos.");
    await hl(".vf-fin-base", 4);
    await wait(2600);
    await hlOff();
    await cap("3", "Envie a <u>planilha de vendas</u> do Mercado Livre do mês: arraste o arquivo ou clique para selecionar.");
    await go(DRAWER + " .vf-fin-file >> nth=0");
    await wait(1200);
    await page.setInputFiles('input[aria-label^="Planilha de vendas"]', path.join(dir, "vendas-setembro-2026.xlsx"));
    await wait(1800);
    await cap("3", "Ajustes do período: o <u>ADS</u> vem do Mercado Ads automaticamente. Informe Venforce, afiliados, FULL e outros custos do mês.");
    await hl(DRAWER + " .vf-fin-ajuste__label >> nth=0", 40);
    await wait(2200);
    await hlOff();
    await digitar(page.getByLabel("Venforce"), "4500");
    await digitar(page.getByLabel("Afiliados"), "1240,30");
    await digitar(page.getByLabel("FULL"), "2700");
    await wait(900);
    await cap("3", "Tudo pronto: clique em <u>Processar fechamento</u>.");
    await click(botao("Processar fechamento", DRAWER));
    await page.waitForSelector(KPIS, { timeout: 20000 });
    await wait(1500);

    // ── 4. Resultado ─────────────────────────────────────────────────────
    await cap("4", "O resultado aparece na mesa: <u>Resultado final</u> do mês, receitas, lucro de contribuição, TACoS, TACoX e cobertura da base.");
    await hl(KPIS, 4);
    await wait(5200);
    await hlOff();
    await cap("5", "<u>Da receita ao resultado</u>: cada barra mostra o que sobra depois de cada despesa — comissão, ADS, Venforce, afiliados e FULL.");
    await hl(".vf-fin-mesa__principal section:has-text('Da receita ao resultado'), [class*=cascata]", 4);
    await wait(4400);
    await hlOff();
    await click(botao("Detalhes"));
    await wait(1200);
    await cap("5", "Em <u>Detalhes</u> está a leitura completa do fechamento: composição, deduções, custos e cobertura.");
    await wait(3000);
    await page.evaluate(() => {
      const corpo = document.querySelector(".vf-drawer .vf-drawer__body");
      const alvo = [...corpo.querySelectorAll("*")].find((e) => e.children.length === 0 && /Conciliação Mercado Pago/.test(e.textContent));
      if (alvo) corpo.scrollTo({ top: alvo.getBoundingClientRect().top - corpo.getBoundingClientRect().top + corpo.scrollTop - 120, behavior: "smooth" });
    });
    await wait(1000);
    await cap("5", "No fim dos Detalhes fica a <u>conciliação Mercado Pago</u>: quantos pedidos já bateram com os pagamentos recebidos.");
    await wait(3600);
    await click(FECHAR_DRAWER);
    await wait(600);

    // ── 6. Produtos ──────────────────────────────────────────────────────
    await scrollToEl(".vf-fin-mesa-produtos", 90);
    await cap("6", "<u>Produtos</u>: todos os anúncios do mês, ordenados por receita. Busque por título, MLB ou SKU e filtre por situação.");
    await digitar("input[aria-label='Buscar produto']", "garrafa");
    await wait(2000);
    await page.locator("input[aria-label='Buscar produto']").fill("");
    await wait(800);
    await click(page.locator(".vf-fin-mesa-filtros button").filter({ hasText: "Sem custo" }));
    await wait(2200);
    await click(page.locator(".vf-fin-mesa-filtros button").filter({ hasText: "Todos" }));
    await wait(800);
    await cap("6", "Clique numa linha para ver a composição: receita, repasse, custo, imposto, LC e MC daquele anúncio.");
    await click(page.locator(".vf-fin-mesa-lista__linha").first());
    await wait(3200);
    await click(page.locator(".vf-fin-mesa-lista__linha").first());
    await wait(600);

    // ── 7. Pendências ────────────────────────────────────────────────────
    await scrollTo(0);
    await cap("7", "Produtos <u>sem custo</u> ficam fora do lucro. Clique em <u>Ver e corrigir</u> para resolvê-los.");
    await go(botao("Ver e corrigir"));
    await wait(1600);
    await click(botao("Ver e corrigir"));
    await wait(1200);
    await cap("7", "Digite o custo unitário na própria linha e clique em <u>Salvar na base</u>. Muitos itens? Corrija todos por planilha.");
    const custo = page.locator("input[aria-label^='Novo custo unitário']").first();
    await digitar(custo, "41,90");
    await wait(700);
    await click(page.locator(DRAWER + " button").filter({ hasText: "Salvar na base" }).first());
    await wait(1800);
    await cap("7", "Depois de corrigir, clique em <u>Reprocessar fechamento</u> para o resultado considerar os novos custos.");
    await go(botao("Reprocessar fechamento", DRAWER));
    await wait(2200);
    await click(FECHAR_DRAWER);
    await wait(600);

    // ── 8. Salvar e publicar ─────────────────────────────────────────────
    await cap("8", "Confira tudo e salve. <u>Salvar como rascunho</u> guarda o fechamento sem mostrar ao cliente.");
    await hl(ETAPAS, 4);
    await click(botao("Salvar como rascunho", ETAPAS));
    await wait(2200);
    await hlOff();
    await cap("8", "<u>Publicar</u> gera o link de apresentação para o cliente. A tela pede confirmação antes de publicar.");
    await click(page.locator(ETAPAS + " button").filter({ hasText: /^Publicar/ }).first());
    await wait(1600);
    await click(page.locator(ETAPAS + " .vf-fin-mesa-confirmar button").filter({ hasText: /^Publicar$/ }).first());
    await wait(2200);
    await cap("8", "Publicado: copie ou abra o link do cliente. Em <u>Apresentação</u> você revisa o que o cliente vai ver.");
    await hl(ETAPAS, 4);
    await wait(2600);
    await hlOff();
    const apres = page.locator(ETAPAS + " button").filter({ hasText: /Apresentação|Editar apresentação/ }).first();
    if (await apres.count()) {
      await click(apres);
      await wait(2800);
      await click(FECHAR_DRAWER);
      await wait(600);
    }

    // ── 9. Histórico e Relatórios ───────────────────────────────────────
    await cap("9", "<u>Histórico</u> lista as competências desta operação mês a mês. Clique num mês para abri-lo.");
    await click(botao("Histórico", ".vf-fin-cabecalho-b__acoes"));
    await wait(3000);
    await click(FECHAR_DRAWER);
    await wait(500);
    await cap("9", "<u>Relatórios</u> reúne as entregas geradas para o cliente, com status, link e opção de publicar ou despublicar.");
    await click(botao("Relatórios", ".vf-fin-cabecalho-b__acoes"));
    await wait(3400);
    await click(FECHAR_DRAWER);
    await wait(600);
    await capOff();

    // ── Fechamento ───────────────────────────────────────────────────────
    await card('<div class="k">Resumo</div><div class="t">Financeiro</div><ul>' +
      '<li>Escolha a competência</li><li>Siga as 6 etapas do painel</li><li>Envie a planilha de vendas</li><li>Informe os ajustes do mês</li>' +
      '<li>Confira resultado e produtos</li><li>Corrija os custos pendentes</li><li>Salve e publique</li><li>Histórico e Relatórios</li></ul>', 5500);
  },
}).catch((e) => { console.error(e); process.exit(1); });

// O arquivo da planilha precisa existir para o setInputFiles (o conteúdo não
// importa: quem "processa" é o backend de demonstração).
const dirFin = path.join(__dirname, "out", "financeiro");
fs.mkdirSync(dirFin, { recursive: true });
fs.writeFileSync(path.join(dirFin, "vendas-setembro-2026.xlsx"), "planilha de demonstração");
