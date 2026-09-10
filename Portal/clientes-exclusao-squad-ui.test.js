// Portal/clientes-exclusao-squad-ui.test.js
//
// mission "admin precisa poder excluir cliente de verdade" (set/2026):
// a versão anterior só permitia PATCH /desativar quando o cliente tinha
// dependências — o admin nunca tinha a opção real de apagar tudo. Agora,
// quando há dependências, o modal oferece DUAS escolhas (nunca decide
// sozinho por trás):
//   [Remover da operação]      -> PATCH /clientes/:slug/desativar (preserva)
//   [Excluir permanentemente]  -> 2ª confirmação (digitar nome/slug) ->
//                                  DELETE /clientes/:slug?confirmarPurge=true
//                                  com body {confirmar}
// Cliente vazio continua indo direto para hard delete (nada a escolher).
//
// Teste de leitura de fonte — mesmo padrão dos demais *-ui.test.js desta
// tela.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const js = fs.readFileSync(path.join(__dirname, "clientes.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "clientes.html"), "utf8");

ok("botão de remoção continua existindo na linha do cliente (data-action=\"delete\")", /data-action="delete"/.test(js));

// ── abrirModalRemoverCliente: decide o caminho ANTES de abrir modal ──────
{
  const inicio = js.indexOf("async function abrirModalRemoverCliente");
  assert.ok(inicio >= 0, "abrirModalRemoverCliente não encontrada");
  const fim = js.indexOf("\n// ── Modal dedicado", inicio);
  assert.ok(fim > inicio, "fim de abrirModalRemoverCliente não encontrado");
  const trecho = js.slice(inicio, fim);

  ok("busca o cliente em CLIENTES_LISTA pelo slug (nome/squad para o modal)", /CLIENTES_LISTA\.find/.test(trecho));
  ok("consulta GET /clientes/:slug/dependencias ANTES de abrir qualquer modal", /apiFetch\(`\/clientes\/\$\{encodeURIComponent\(slug\)\}\/dependencias`\)/.test(trecho));
  ok(
    "cliente SEM dependências: oferece exclusão permanente direta (hard delete)",
    /dependencias\.length\)\s*\{[\s\S]*?confirmLabel:\s*"Excluir permanentemente"[\s\S]*?method:\s*"DELETE"/.test(trecho)
  );
  ok(
    "cliente COM dependências: abre o modal dedicado com as duas escolhas (não decide sozinho)",
    /abrirModalRemoverComDependencias\(\{\s*slug,\s*nomeCliente,\s*squadLabel,\s*dependencias\s*\}\)/.test(trecho)
  );
}

// ── abrirModalRemoverComDependencias: Cliente + Squad + dependências ─────
{
  const inicio = js.indexOf("function abrirModalRemoverComDependencias");
  assert.ok(inicio >= 0, "abrirModalRemoverComDependencias não encontrada");
  const fim = js.indexOf("\nasync function confirmarRemoverDaOperacao", inicio);
  const trecho = js.slice(inicio, fim > 0 ? fim : inicio + 1500);

  ok("subtitle do modal mostra Cliente e Squad (não só o slug)", /subtitle.*=\s*`\$\{nomeCliente\}.*Squad.*\$\{squadLabel\}`/.test(trecho));
  ok("lista as dependências reais (não esconde o que existe)", /vf-clientes-remover-deps.*innerHTML/.test(trecho) && /dependencias\.map/.test(trecho));
  ok(
    "mensagem explica que os dados NÃO serão apagados fisicamente por padrão (não é \"tem certeza?\" genérico)",
    /não será apagado fisicamente/.test(trecho)
  );
}

// ── as duas ações: soft (desativar) e hard (purge com 2ª confirmação) ────
{
  const inicioSoft = js.indexOf("async function confirmarRemoverDaOperacao");
  const fimSoft = js.indexOf("\nasync function confirmarExcluirPermanentemente", inicioSoft);
  const trechoSoft = js.slice(inicioSoft, fimSoft);
  ok("\"Remover da operação\" chama PATCH /clientes/:slug/desativar (preserva tudo)", /\/desativar`,\s*\{\s*method:\s*"PATCH"/.test(trechoSoft));

  const inicioHard = js.indexOf("async function confirmarExcluirPermanentemente");
  const trechoHard = js.slice(inicioHard, inicioHard + 1500);
  ok(
    "\"Excluir permanentemente\" chama DELETE com ?confirmarPurge=true",
    /method:\s*"DELETE"/.test(trechoHard) && /confirmarPurge=true/.test(trechoHard)
  );
  ok(
    "envia o texto digitado pelo admin como confirmação (body.confirmar)",
    /body:\s*JSON\.stringify\(\{\s*confirmar:\s*input\.value\.trim\(\)\s*\}\)/.test(trechoHard)
  );
}

// ── 2ª confirmação: botão só libera quando nome/slug bate ────────────────
{
  const inicio = js.indexOf("function atualizarBotaoPurgeHabilitado");
  const trecho = js.slice(inicio, inicio + 800);
  ok("botão final começa desabilitado e só libera se o texto digitado bater com nome OU slug", /btn\.disabled\s*=\s*!digitado\s*\|\|\s*\(digitado\s*!==\s*alvoNome\s*&&\s*digitado\s*!==\s*alvoSlug\)/.test(trecho));
}

// ── HTML: as duas opções + o passo de 2ª confirmação existem ─────────────
ok("modal dedicado de remoção existe no HTML", /id="vf-clientes-remover-modal"/.test(html));
ok("HTML tem o botão \"Remover da operação\" (soft)", /id="vf-clientes-remover-btn-desativar"[^>]*>\s*Remover da operação/.test(html));
ok("HTML tem o botão \"Excluir permanentemente\" visualmente perigoso (vf-btn--danger)", /id="vf-clientes-remover-btn-ir-purge"\s+class="vf-btn vf-btn--danger"/.test(html));
ok("HTML tem o input de 2ª confirmação (digitar nome/slug)", /id="vf-clientes-remover-input"/.test(html));
ok("botão final de purge nasce desabilitado (disabled) até o texto bater", /id="vf-clientes-remover-btn-purge"[^>]*disabled/.test(html));
ok("passo de purge avisa que a ação é irreversível", /irrevers[íi]vel/i.test(html));

console.log(`\nclientes-exclusao-squad-ui.test.js: ${checks} verificações passaram.`);
