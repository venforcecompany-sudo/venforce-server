// Teste mínimo (lógica pura) da bancada técnica standalone + guardas de escopo:
// a página NÃO pode estar registrada no Shell V3.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

(async () => {
  const m = await import("./integracoes-externas.js");

  const vazio = m.buildStatusModel({ ok: true, configured: false, baseUrlConfigured: false, authenticationConfigured: false, shopee: { externalContract: "pending" } });
  assert.deepStrictEqual(vazio, { api: { ok: false, label: "Não configurada" }, auth: { ok: false, label: "Não configurada" }, contrato: { ok: false, label: "Pendente" } });

  const cfg = m.buildStatusModel({ baseUrlConfigured: true, authenticationConfigured: true, shopee: { externalContract: "pending" } });
  assert.strictEqual(cfg.api.label, "Configurada");
  assert.strictEqual(cfg.auth.label, "Configurada");
  assert.strictEqual(cfg.contrato.label, "Pendente");
  assert.strictEqual(m.buildStatusModel(null).api.label, "Não configurada", "resposta inválida não quebra");

  assert.strictEqual(m.SHOPEE_CAPACIDADES.length, 10);
  const html = m.renderCapacidades(m.SHOPEE_CAPACIDADES);
  assert.strictEqual((html.match(/Pendente de contrato/g) || []).length, 10);
  assert.deepStrictEqual(m.WHATSAPP_CAPACIDADES, [
    "Provider", "Autenticação", "Grupos", "Mensagens", "Histórico", "Eventos / Webhooks", "Relação grupo ↔ cliente",
  ]);
  const htmlWpp = m.renderCapacidades(m.WHATSAPP_CAPACIDADES);
  assert.strictEqual((htmlWpp.match(/Pendente de contrato/g) || []).length, 7, "WhatsApp: 7 itens, todos pendentes de contrato");
  assert.ok(m.renderCapacidades(['<img onerror=x>']).includes("&lt;img"), "escapa HTML");
  console.log("  ✓ modelo/render da bancada");

  // standalone: fora do Shell V3
  for (const f of ["vf-shell.js", "vf-context.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assert.ok(!src.includes("integracoes-externas"), `${f} não pode referenciar a bancada`);
  }
  const page = fs.readFileSync(path.join(__dirname, "integracoes-externas.html"), "utf8");
  assert.ok(!page.includes("vf-shell"), "página não carrega o Shell");
  console.log("  ✓ standalone: Shell/Contexto intactos");
  console.log("\n✓ integracoes-externas.test.js");
})().catch((e) => { console.error(e); process.exit(1); });
