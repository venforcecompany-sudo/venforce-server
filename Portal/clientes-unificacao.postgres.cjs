// E2E completo: HTML + vf-api + auth real + serviço #260 + PG descartável.
// Execução explícita e somente URL loopback vf_unificacao_test_*.
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const express = require("express"),
  jwt = require("jsonwebtoken");
const {
  environment,
} = require("../server/tests/helpers/clientesUnificacaoPostgres");
const {
  createService,
} = require("../server/services/clientesUnificacao/service");
const { browser } = require("./tests/unificacao-browser.cjs");
async function main() {
  const env = await environment();
  const databasePath = require.resolve("../server/config/database");
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: env.pool,
  };
  process.env.JWT_SECRET = "SYNTHETIC_LOCAL_UI_ONLY_SECRET_32_CHARS";
  const { createRouter } = require("../server/routes/clientesUnificacaoRoutes");
  const flags = { execute: false, rollback: false };
  let uiEnabled = true;
  const service = createService({ pool: env.pool, getFlags: () => flags });
  const app = express();
  app.use(express.json());
  app.use(
    "/admin/clientes-unificacao",
    createRouter({
      service,
      getUiConfig: () => ({
        uiEnabled,
        executeEnabled: flags.execute,
        rollbackEnabled: flags.rollback,
      }),
    }),
  );
  const { authMiddleware } = require("../server/middlewares/authMiddleware");
  app.get("/me/context", authMiddleware, (req, res) =>
    res.json({
      ok: true,
      user: { id: req.user.id, role: req.user.role, nome: "Admin local" },
      squads: [],
      clientes: [],
      portfolio: { totalClientes: 0 },
      permissoes: { podeAdministrar: true },
    }),
  );
  const token = jwt.sign({ id: 5 }, process.env.JWT_SECRET);
  const server = http.createServer(app);
  app.get("/clientes-unificacao.html", (req, res) => {
    const html = fs
      .readFileSync(path.join(__dirname, "clientes-unificacao.html"), "utf8")
      .replace(
        "<head>",
        `<head><meta name="vf-api-base" content="http://127.0.0.1:${server.address().port}"><script>localStorage.setItem('vf-token',${JSON.stringify(token)});localStorage.setItem('vf-user','{"id":5,"role":"admin"}');</script>`,
      );
    res.type("html").send(html);
  });
  app.use(express.static(__dirname));
  let b;
  try {
    await env.seed({ extra: true });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    b = await browser();
    const c = b.cdp;
    const goto = async () => {
      await c.send("Page.navigate", {
        url: `http://127.0.0.1:${server.address().port}/clientes-unificacao.html?local=${Date.now()}`,
      });
      await c.wait("!document.getElementById('cu-app')?.hidden");
    };
    async function prepare() {
      await c.click("cu-new");
      await c.input("cu-search-canonical", "1");
      await c.wait("document.querySelector('[data-action=choose-canonical]')");
      await c.action("choose-canonical");
      await c.input("cu-search-legacy", "2");
      await c.wait("document.querySelector('[data-action=choose-legacy]')");
      await c.action("choose-legacy");
      await c.click("cu-preview");
      await c.wait("document.getElementById('cu-approved')");
      await c.check("cu-approved");
      await c.input("cu-approver", "5", "change");
      await c.input("cu-evidence", "DOC-LOCAL-001", "change");
      for (const selector of [
        "[data-decision=primary][value='21']",
        "[data-decision=grant][value='32']",
      ])
        await c.eval(
          `{const e=document.querySelector(${JSON.stringify(selector)});e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));}`,
        );
      await c.wait(
        "document.getElementById('cu-execution-state').textContent.includes('Preview validado') || document.getElementById('cu-execution-state').textContent.includes('não habilitada')",
      );
    }
    async function execute() {
      await c.check("cu-reviewed");
      await c.input("cu-confirmation", "UNIFICAR 2 EM 1");
      await c.click("cu-execute");
      await c.wait(
        "document.getElementById('cu-result').textContent.includes('Unificação concluída')",
      );
    }
    let cases = 0;
    async function check(name, fn) {
      await fn();
      console.log(`ok ${++cases} — ${name}`);
    }
    await check("UI OFF local bloqueia URL autenticada", async () => {
      uiEnabled = false;
      await c.send("Page.navigate", {
        url: `http://127.0.0.1:${server.address().port}/clientes-unificacao.html`,
      });
      await c.wait(
        "document.getElementById('cu-access')?.textContent.includes('não habilitada')",
      );
      uiEnabled = true;
    });
    await check("preview real com execute OFF não altera negócio", async () => {
      await goto();
      await prepare();
      assert.equal(
        await c.eval("document.getElementById('cu-execute').disabled"),
        true,
      );
      assert.equal(
        (await env.pool.query("SELECT count(*) FROM cliente_unificacoes"))
          .rows[0].count,
        "0",
      );
      assert.equal(
        (
          await env.pool.query(
            "SELECT cliente_id FROM cliente_contas WHERE id=21",
          )
        ).rows[0].cliente_id,
        2,
      );
    });
    await check(
      "UI → execução real → mapping/contas/Grants/Bases/ledger",
      async () => {
        flags.execute = true;
        await c.click("cu-preview");
        await c.wait(
          "document.getElementById('cu-execution-state').textContent.includes('Preview validado')",
        );
        await execute();
        assert.equal(
          (
            await env.pool.query(
              "SELECT merged_into_cliente_id FROM clientes WHERE id=2",
            )
          ).rows[0].merged_into_cliente_id,
          1,
        );
        assert.equal(
          (
            await env.pool.query(
              "SELECT cliente_id FROM cliente_contas WHERE id=21",
            )
          ).rows[0].cliente_id,
          1,
        );
        assert.equal(
          (await env.pool.query("SELECT cliente_id FROM ml_tokens WHERE id=32"))
            .rows[0].cliente_id,
          1,
        );
        assert.equal(
          (
            await env.pool.query(
              "SELECT cliente_id FROM base_cliente_vinculos WHERE id=52",
            )
          ).rows[0].cliente_id,
          1,
        );
        assert.equal(
          (await env.pool.query("SELECT status FROM cliente_unificacoes"))
            .rows[0].status,
          "completed",
        );
      },
    );
    await check("histórico/detalhe reais e rollback OFF", async () => {
      await c.click("cu-tab-history");
      await c.wait(
        "document.querySelector('#cu-history [data-action=open-detail]')",
      );
      await c.action("open-detail");
      await c.wait(
        "document.getElementById('cu-detail').textContent.includes('não habilitado')",
      );
      assert.equal(
        await c.eval("document.getElementById('cu-rollback')"),
        null,
      );
      assert.ok(!(await c.text("cu-app")).includes("SECRET_ACCESS"));
    });
    await check("UI → rollback real → restaura ownership/mapping", async () => {
      flags.rollback = true;
      await goto();
      await c.click("cu-tab-history");
      await c.wait(
        "document.querySelector('#cu-history [data-action=open-detail]')",
      );
      await c.action("open-detail");
      await c.wait("document.getElementById('cu-rollback')");
      await c.input("cu-rollback-confirmation", "REVERTER UNIFICACAO 1");
      await c.click("cu-rollback");
      await c.wait(
        "document.getElementById('cu-rollback-feedback').textContent.includes('Rollback concluído')",
      );
      assert.equal(
        (
          await env.pool.query(
            "SELECT merged_into_cliente_id FROM clientes WHERE id=2",
          )
        ).rows[0].merged_into_cliente_id,
        null,
      );
      assert.equal(
        (
          await env.pool.query(
            "SELECT cliente_id FROM cliente_contas WHERE id=21",
          )
        ).rows[0].cliente_id,
        2,
      );
      assert.equal(
        (await env.pool.query("SELECT status FROM cliente_unificacoes")).rows[0]
          .status,
        "rolled_back",
      );
    });
    await check(
      "divergência real bloqueia rollback na UI sem mutação",
      async () => {
        await env.seed({ extra: true });
        await goto();
        await prepare();
        await execute();
        await env.pool.query(
          "UPDATE cliente_contas SET nome='Mudança local posterior' WHERE id=21",
        );
        await c.action("open-detail");
        await c.wait("document.getElementById('cu-rollback')");
        await c.input("cu-rollback-confirmation", "REVERTER UNIFICACAO 1");
        await c.click("cu-rollback");
        await c.wait(
          "document.getElementById('cu-rollback-feedback').textContent.includes('Nenhuma alteração')",
        );
        assert.equal(
          (
            await env.pool.query(
              "SELECT cliente_id FROM cliente_contas WHERE id=21",
            )
          ).rows[0].cliente_id,
          1,
        );
        assert.equal(
          (await env.pool.query("SELECT status FROM cliente_unificacoes"))
            .rows[0].status,
          "rollback_failed",
        );
      },
    );
    await check("evidência visual local sem secrets", async () => {
      await c.send("Emulation.setDeviceMetricsOverride", {
        width: 1440,
        height: 1100,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await c.eval("new Promise(resolve => setTimeout(resolve, 250))");
      await c.eval("window.scrollTo(0,0)");
      const image = await c.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      fs.writeFileSync(
        "/tmp/cu-ui-postgres.png",
        Buffer.from(image.data, "base64"),
      );
      assert.ok(!(await c.text("cu-app")).includes("SECRET_API_KEY"));
    });
    console.log(
      `${cases} cenários UI + PostgreSQL real passaram; somente banco descartável.`,
    );
  } finally {
    try {
      await b?.close();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await env.close();
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
