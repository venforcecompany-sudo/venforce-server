#!/usr/bin/env node
// server/sql/squads-migrate.js
// VenForce V3 — P2.3. Ferramenta de linha de comando para migração de Squads.
//
// SEGURO POR PADRÃO: sem --apply, só faz dry-run (valida, não escreve).
//
// Uso:
//   node server/sql/squads-migrate.js --plan <arquivo.json>            # dry-run
//   node server/sql/squads-migrate.js --plan <arquivo.json> --apply    # executa (transacional)
//   node server/sql/squads-migrate.js --audit                          # só a auditoria atual
//   node server/sql/squads-migrate.js --plan <arquivo.json> --json     # saída JSON crua
//
// Env: DATABASE_URL obrigatória. --actor <id> registra alterado_por.
//
// Idempotente: rodar o mesmo plano de novo não duplica squads / memberships /
// vínculos / histórico. Falha em qualquer passo → ROLLBACK total.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { plan: null, apply: false, audit: false, json: false, actor: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--plan" || t === "-p") a.plan = argv[++i];
    else if (t === "--apply") a.apply = true;
    else if (t === "--dry-run") a.apply = false;
    else if (t === "--audit") a.audit = true;
    else if (t === "--json") a.json = true;
    else if (t === "--actor") a.actor = Number(argv[++i]);
    else if (t === "-h" || t === "--help") a.help = true;
  }
  return a;
}

function linha(txt = "") { process.stdout.write(txt + "\n"); }

function imprimirRelatorio(r) {
  linha("");
  linha("═══════════════════════════════════════════════════════════");
  linha(`  MIGRAÇÃO DE SQUADS — ${r.dryRun ? "DRY-RUN (nada escrito)" : r.aplicado ? "APLICADO" : "NÃO APLICADO"}`);
  linha("═══════════════════════════════════════════════════════════");

  const a = r.antes.auditoria;
  linha("");
  linha("ANTES:");
  linha(`  squads: ${r.antes.totais.squads} (${r.antes.totais.squads_ativos} ativos) · memberships ativas: ${r.antes.totais.memberships_ativas} · vínculos ativos: ${r.antes.totais.vinculos_ativos}`);
  linha(`  clientes ativos: ${a.clientesAtivos.total} — com squad ativo: ${a.clientesAtivos.comSquadAtivo} · em squad inativo: ${a.clientesAtivos.emSquadInativo} · sem squad: ${a.clientesAtivos.semSquad}`);
  linha(`  internos: ${a.usuariosInternos.total} — com membership: ${a.usuariosInternos.comMembership} · sem membership: ${a.usuariosInternos.semMembership} · só em squad inativo: ${a.usuariosInternos.apenasEmSquadInativo} · sem principal: ${a.usuariosInternos.semPrincipal}`);
  linha(`  auditoria.pronto: ${a.pronto}`);

  const p = r.planejado;
  linha("");
  linha("PLANEJADO:");
  linha(`  squads      → criar: ${p.squads.criar.length} ${p.squads.criar.join(", ")} | atualizar: ${p.squads.atualizar.length} | inalterado: ${p.squads.inalterado.length}`);
  linha(`  membros     → criar: ${p.membros.criar} · reativar: ${p.membros.reativar} · atualizar: ${p.membros.atualizar} · inalterado: ${p.membros.inalterado}`);
  linha(`  clientes    → atribuir: ${p.clientes.atribuir.length} · transferir: ${p.clientes.transferir.length} · inalterado: ${p.clientes.inalterado.length}`);
  linha(`  responsáveis → upsert: ${p.responsaveis.criar}`);

  if (r.avisos.length) {
    linha("");
    linha(`AVISOS (${r.avisos.length}):`);
    for (const w of r.avisos) linha(`  ⚠ [${w.contexto}] ${w.msg}`);
  }
  if (r.erros.length) {
    linha("");
    linha(`ERROS (${r.erros.length}) — plano inválido, nada foi escrito:`);
    for (const e of r.erros) linha(`  ✗ [${e.contexto}] ${e.msg}`);
  }

  if (r.aplicado) {
    linha("");
    linha("APLICADO:");
    linha(`  ${JSON.stringify(r.resumo)}`);
    const d = r.depois.auditoria;
    linha("");
    linha("DEPOIS:");
    linha(`  clientes sem squad: ${d.clientesAtivos.semSquad} · em squad inativo: ${d.clientesAtivos.emSquadInativo}`);
    linha(`  internos sem membership: ${d.usuariosInternos.semMembership} · sem principal: ${d.usuariosInternos.semPrincipal}`);
    linha(`  auditoria.pronto: ${d.pronto}`);
  }
  if (r.erroExecucao) {
    linha("");
    linha(`✗ ERRO DE EXECUÇÃO (ROLLBACK): ${r.erroExecucao}`);
  }
  linha("");
  linha(`>> ${r.motivo || (r.aplicado ? "concluído." : "")}`);
  linha("");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    linha(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 18).join("\n").replace(/^\/\/ ?/gm, "").trimEnd());
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const migImport = require("../services/squads/squadsMigracaoImportService");

  // P2.9 T-3: `--audit` existe para ser inofensivo. Antes ele aplicava DDL via
  // ensureSquadsTables; agora só CONFERE o schema com to_regclass.
  if (args.audit) {
    const snap = await migImport.snapshot(require("../config/database"), { garantirSchema: false });
    linha(JSON.stringify(snap, null, 2));
    process.exit(snap?.auditoria?.schemaAusente ? 2 : 0);
  }

  if (!args.plan) {
    console.error("Erro: informe --plan <arquivo.json> (ou --audit). Use --help.");
    process.exit(1);
  }
  const planPath = path.resolve(args.plan);
  if (!fs.existsSync(planPath)) {
    console.error(`Erro: arquivo não encontrado: ${planPath}`);
    process.exit(1);
  }

  let plano;
  try {
    plano = JSON.parse(fs.readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(`Erro: JSON inválido em ${planPath}: ${e.message}`);
    process.exit(1);
  }

  // P2.9 T-3: sem --apply, a operação inteira é ZERO-WRITE — nem o DDL de
  // schema é emitido. "Simular" não pode mudar nada, especialmente em produção.
  const r = await migImport.importar(plano, {
    actorId: args.actor,
    dryRun: !args.apply,
    garantirSchema: Boolean(args.apply),
  });

  if (args.json) {
    linha(JSON.stringify(r, null, 2));
  } else {
    imprimirRelatorio(r);
  }

  // Exit code: 0 se ok (dry-run válido ou aplicado); 2 se plano inválido; 3 se erro de execução.
  if (r.erroExecucao) process.exit(3);
  if (!r.ok) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
