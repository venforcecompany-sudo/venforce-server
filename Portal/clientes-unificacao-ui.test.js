// UI real + vf-api/vf-shell reais em Chrome. Backend de fixture usa o
// preview/planner/validator reais; escritas são respostas simuladas explícitas.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { browser, sleep } = require("./tests/unificacao-browser.cjs");
const {
  fixture,
} = require("../server/tests/helpers/clientesUnificacaoFixture");
const {
  createService,
} = require("../server/services/clientesUnificacao/service");
const {
  normalizeManifest,
  confirmation,
  rollbackConfirmation,
} = require("../server/services/clientesUnificacao/contracts");
const repo = require("../server/services/clientesUnificacao/repository");
let config, mode, calls, operations, previewHash, currentPreview;
function reset() {
  config = {
    uiEnabled: true,
    executeEnabled: true,
    rollbackEnabled: true,
    actor: { id: 5, role: "admin" },
  };
  mode = {};
  calls = [];
  operations = [];
  previewHash = null;
}
reset();
const domain = createService({
  pool: {
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  },
  getFlags: () => ({
    execute: config.executeEnabled,
    rollback: config.rollbackEnabled,
  }),
  repository: {
    ...repo,
    audit: async () => {},
    readSnapshot: async () => {
      const s = fixture();
      s.tables.clientes[0].nome = '<img src=x onerror="window.XSS=1"> Canônico';
      s.tables.bases[0].nome = "Base Matriz";
      s.tables.bases[1].nome = "Base Legado";
      s.tables.painel_contas_lancamentos_manuais = [
        { id: 90, cliente_id: 2, cliente_conta_id: 21 },
      ];
      s.columns.push(
        ...["id", "cliente_id", "cliente_conta_id"].map((column_name) => ({
          table_name: "painel_contas_lancamentos_manuais",
          column_name,
        })),
      );
      s.constraints.push({
        type: "p",
        table_name: "painel_contas_lancamentos_manuais",
        name: "manual_pkey",
        columns: ["id"],
      });
      if (mode.warning) s.tables.base_cliente_vinculos = [];
      return s;
    },
  },
});
const clients = fixture().tables.clientes;
clients.push({
  id: 3,
  nome: "Terceiro sintético",
  slug: "terceiro",
  ativo: true,
});
async function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const json = (body, status = 200) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.startsWith("/admin/clientes-unificacao")) {
        const route = url.pathname.slice("/admin/clientes-unificacao".length);
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        calls.push({
          route,
          body,
          query: url.searchParams.get("q"),
          auth: !!req.headers.authorization,
        });
        if (mode.auth401) return json({ ok: false }, 401);
        if (mode.serverDeny) return json({ ok: false, erro: "Privado" }, 403);
        if (route === "/config") {
          if (mode.configError)
            return json({ ok: false, code: "SERVIDOR" }, 500);
          return json({ ok: true, ...config });
        }
        if (route === "/candidatos") {
          await sleep(mode.candidateDelay || 0);
          if (mode.candidatesError)
            return json({ ok: false, code: "CANDIDATE_SCOPE_TOO_LARGE" }, 409);
          return json({
            ok: true,
            candidatos: mode.empty
              ? []
              : [
                  {
                    cliente_a: 1,
                    cliente_b: 2,
                    classificacao: "PROVAVEL",
                    score_priorizacao: 20,
                    motivos: [
                      {
                        motivo: "mesma raiz <script>alert(1)</script>",
                        pontos: 10,
                      },
                    ],
                    decisao: "PENDENTE",
                  },
                ],
            automaticMerge: false,
          });
        }
        if (route === "/busca") {
          if (mode.searchError)
            return json({ ok: false, code: "SERVIDOR" }, 500);
          const q = url.searchParams.get("q") || "";
          await sleep(q === "lento" ? 600 : 0);
          return json({
            ok: true,
            clientes:
              q === "vazio"
                ? []
                : clients.filter(
                    (c) =>
                      (/lento|todos|legado|canonico/.test(q) && c.id !== 3) ||
                      String(c.id) === q,
                  ),
          });
        }
        if (route === "/preview") {
          if (mode.previewError)
            return json({ ok: false, code: "MANIFEST_INVALID" }, 422);
          currentPreview = await domain.preview(body.manifest, {
            id: 5,
            role: "admin",
          });
          previewHash = currentPreview.planHash;
          return json({ ok: true, ...currentPreview });
        }
        if (route === "/execute") {
          await sleep(mode.executeDelay || 0);
          if (mode.executeError)
            return json(
              { ok: false, code: mode.executeError, erro: "SECRET_SQL_STACK" },
              409,
            );
          assert.equal(body.planHash, previewHash);
          assert.equal(
            body.confirmationText,
            confirmation(normalizeManifest(body.manifest)),
          );
          assert.ok(body.idempotencyKey);
          let op = operations.find((op) => op.testKey === body.idempotencyKey);
          if (!op) {
            op = {
              id: "1",
              operationKey: "SYNTHETIC-UNIF-1",
              testKey: body.idempotencyKey,
              status: mode.pending ? "validated" : "completed",
              clienteCanonicoId: 1,
              clientesLegadosIds: [2],
              actor: { requestedByUserId: 5, confirmedByUserId: 5 },
              createdAt: "2026-10-14T16:00:00Z",
              finishedAt: "2026-10-14T16:01:00Z",
              planHash: body.planHash,
              rollbackAvailable: !mode.pending,
              manifest: body.manifest,
              plan: currentPreview.plan,
              validation: currentPreview.plan.validation,
              beforeSummary: { hash: "a".repeat(64), tables: ["clientes"] },
              afterSummary: { hash: "b".repeat(64), tables: ["clientes"] },
            };
            operations.push(op);
          }
          return json({
            ok: true,
            operation: {
              ...op,
              rollbackConfirmationText: rollbackConfirmation(op),
            },
          });
        }
        if (!route || route === "/") {
          if (mode.historyError)
            return json({ ok: false, code: "SERVIDOR" }, 500);
          const more = url.searchParams.get("cursor");
          return json({
            ok: true,
            operations: operations,
            nextCursor: mode.historyMore && !more ? "1" : null,
          });
        }
        if (route.endsWith("/rollback")) {
          await sleep(mode.rollbackDelay || 0);
          if (mode.rollbackError)
            return json({ ok: false, code: mode.rollbackError }, 409);
          assert.equal(
            body.confirmationText,
            rollbackConfirmation(operations[0]),
          );
          operations[0].status = "rolled_back";
          operations[0].rollbackAvailable = false;
          return json({
            ok: true,
            operation: {
              ...operations[0],
              rollbackConfirmationText: rollbackConfirmation(operations[0]),
            },
          });
        }
        if (mode.detailError)
          return json({ ok: false, code: "MERGE_OPERATION_NOT_FOUND" }, 404);
        return json({
          ok: true,
          operation: {
            ...operations[0],
            rollbackConfirmationText: rollbackConfirmation(operations[0]),
          },
        });
      }
      if (url.pathname === "/me/context")
        return json({
          ok: true,
          user: { id: 5, role: "admin", nome: "Admin sintético" },
          squads: [],
          squadPrincipalId: null,
          clientes: [],
          portfolio: { totalClientes: 0 },
          permissoes: { podeAdministrar: true },
        });
      const target = path.resolve(
        __dirname,
        url.pathname === "/"
          ? "clientes-unificacao.html"
          : url.pathname.slice(1),
      );
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      if (!target.startsWith(__dirname + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const ext = path.extname(target);
      let data = fs.readFileSync(target);
      if (ext === ".html") {
        const user = {
          id: 5,
          role: mode.storageRole || "admin",
          nome: "Admin sintético",
        };
        data = data
          .toString()
          .replace(
            "<head>",
            `<head><meta name="vf-api-base" content="http://127.0.0.1:${server.address().port}"><script>localStorage.clear();${mode.noSession ? "" : `localStorage.setItem('vf-token','SYNTHETIC');localStorage.setItem('vf-user',${JSON.stringify(JSON.stringify(user))});`}</script>`,
          );
      }
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
          }[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "TEST_HANDLER_FAILURE" }));
      console.error(error);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
async function main() {
  const server = await serve();
  const b = await browser();
  const c = b.cdp;
  const base = `http://127.0.0.1:${server.address().port}`;
  let count = 0;
  async function check(name, fn) {
    await fn();
    console.log(`ok ${++count} — ${name}`);
  }
  const clickSelector = (selector) =>
    c.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  async function goto(pathname = "clientes-unificacao.html") {
    await c.send("Page.navigate", {
      url: `${base}/${pathname}?test=${Date.now()}`,
    });
    await c.wait("document.readyState === 'complete'");
  }
  async function ready() {
    await c.wait("!document.getElementById('cu-app').hidden");
    await c.wait(
      "document.getElementById('cu-candidates').textContent.includes('Revisar')",
    );
  }
  async function select() {
    await c.click("cu-new");
    await c.input("cu-search-canonical", "1");
    await c.wait("document.querySelector('[data-action=choose-canonical]')");
    await c.action("choose-canonical");
    await c.input("cu-search-legacy", "2");
    await c.wait("document.querySelector('[data-action=choose-legacy]')");
    await c.action("choose-legacy");
  }
  async function initialPreview() {
    await c.click("cu-preview");
    await c.wait("document.getElementById('cu-approved')");
  }
  async function decide() {
    await c.eval(
      "document.getElementById('cu-approved').checked=true;document.getElementById('cu-approver').value='5';document.getElementById('cu-evidence').value='DOC-TEST-001';document.querySelector('[data-decision=primary][value=\"21\"]').checked=true;document.querySelector('[data-decision=grant][value=\"32\"]').checked=true;",
    );
    for (const selector of [
      "#cu-approved",
      "#cu-approver",
      "#cu-evidence",
      "[data-decision=primary][value='21']",
      "[data-decision=grant][value='32']",
    ])
      await c.eval(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`,
      );
    await c.wait(
      "document.getElementById('cu-execution-state').textContent.includes('Preview validado')",
    );
  }
  async function confirm() {
    await c.check("cu-reviewed");
    await c.input("cu-confirmation", "UNIFICAR 2 EM 1");
  }
  try {
    await check(
      "sem sessão redireciona sem chamadas administrativas",
      async () => {
        mode.noSession = true;
        await goto();
        await c.wait("location.pathname.endsWith('/index.html')");
        assert.equal(calls.length, 0);
        reset();
      },
    );
    for (const role of ["coordenador", "analista", "auxiliar", "seller"])
      await check(`${role} bloqueado mesmo por URL`, async () => {
        mode.storageRole = role;
        await goto();
        await c.wait(
          "document.getElementById('cu-access').textContent.includes('restrito')",
        );
        assert.equal(calls.length, 0);
        reset();
      });
    await check(
      "servidor confirma role, não confia no storage admin",
      async () => {
        config.actor.role = "analista";
        await goto();
        await c.wait(
          "document.getElementById('cu-access').textContent.includes('restrito')",
        );
        assert.deepEqual(
          calls.map((r) => r.route),
          ["/config"],
        );
        reset();
      },
    );
    await check("401 limpa sessão com vf-api real", async () => {
      mode.auth401 = true;
      await goto();
      await c.wait("location.pathname.endsWith('/index.html')");
      reset();
    });
    await check("UI OFF bloqueia URL e navegação", async () => {
      config.uiEnabled = false;
      await goto();
      await c.wait(
        "document.getElementById('cu-access').textContent.includes('não habilitada')",
      );
      assert.equal(
        await c.eval(
          "document.querySelector('a[href=\"clientes-unificacao.html\"]')===null",
        ),
        true,
      );
      await goto("carteira.html");
      await c.wait("window.VF?.shell");
      assert.equal(
        await c.eval(
          "document.querySelector('a[href=\"clientes-unificacao.html\"]')===null",
        ),
        true,
      );
      reset();
    });
    await check("erro de configuração permite retry", async () => {
      mode.configError = true;
      await goto();
      await c.wait(
        "document.getElementById('cu-access').textContent.includes('Tentar novamente')",
      );
      mode.configError = false;
      await clickSelector("#cu-access button");
      await ready();
    });
    await check("admin, Shell real e navegação habilitada", async () => {
      await c.wait("window.VF?.shell");
      assert.ok(
        await c.eval(
          "document.querySelector('a[href=\"clientes-unificacao.html\"]')",
        ),
      );
      assert.ok(calls.every((r) => r.auth));
    });
    await check("loading de candidatos", async () => {
      reset();
      mode.candidateDelay = 700;
      await goto();
      await c.wait(
        "document.getElementById('cu-candidates').textContent.includes('Carregando')",
      );
      await ready();
    });
    await check("candidatos explicáveis e XSS escapado", async () => {
      assert.match(await c.text("cu-candidates"), /Priorização: 20/);
      assert.equal(await c.eval("window.XSS || 0"), 0);
      assert.equal(
        await c.eval("document.querySelector('#cu-candidates script')"),
        null,
      );
    });
    await check("revisar candidato sem escolher canônico", async () => {
      await c.action("review-candidate");
      await c.wait("document.querySelector('[data-action=choose-canonical]')");
      assert.match(await c.text("cu-canonical"), /Escolha explicitamente/);
      assert.equal(
        await c.eval("document.getElementById('cu-preview').disabled"),
        true,
      );
    });
    await check(
      "candidatos vazio e erro com busca manual disponível",
      async () => {
        reset();
        mode.empty = true;
        await goto();
        await c.wait(
          "document.getElementById('cu-candidates').textContent.includes('Nenhum candidato')",
        );
        await c.click("cu-new");
        assert.equal(
          await c.eval("document.getElementById('cu-editor').hidden"),
          false,
        );
        mode.empty = false;
        mode.candidatesError = true;
        await goto();
        await c.wait(
          "document.querySelector('[data-action=retry-candidates]')",
        );
        mode.candidatesError = false;
        await c.action("retry-candidates");
        await ready();
      },
    );
    await check("busca debounce não faz uma chamada por tecla", async () => {
      await c.click("cu-new");
      const n = calls.filter((r) => r.route === "/busca").length;
      await c.input("cu-search-canonical", "t");
      await c.input("cu-search-canonical", "to");
      await c.input("cu-search-canonical", "todos");
      await sleep(100);
      assert.equal(calls.filter((r) => r.route === "/busca").length, n);
      await c.wait(
        "document.querySelectorAll('[data-action=choose-canonical]').length===2",
      );
      assert.equal(calls.filter((r) => r.route === "/busca").length, n + 1);
    });
    await check("busca aborta resposta velha", async () => {
      await c.input("cu-search-canonical", "lento");
      await sleep(350);
      await c.input("cu-search-canonical", "2");
      await c.wait(
        "document.querySelectorAll('[data-action=choose-canonical]').length===1",
      );
      await sleep(500);
      assert.match(await c.text("cu-results-canonical"), /Legado/);
    });
    await check("busca vazia e erro têm estados e retry", async () => {
      await c.input("cu-search-canonical", "vazio");
      await c.wait(
        "document.getElementById('cu-results-canonical').textContent.includes('Nenhum')",
      );
      mode.searchError = true;
      await c.input("cu-search-canonical", "todos");
      await c.wait(
        "document.querySelector('[data-action=retry-search-canonical]')",
      );
      mode.searchError = false;
      await c.action("retry-search-canonical");
      await c.wait("document.querySelector('[data-action=choose-canonical]')");
    });
    await check(
      "seleção explícita exclui duplicados e canônico dos legados",
      async () => {
        await select();
        await c.input("cu-search-legacy", "todos");
        await c.wait(
          "document.getElementById('cu-results-legacy').textContent.includes('Nenhum')",
        );
        assert.equal(
          await c.eval(
            "document.querySelectorAll('#cu-legacies .cu-selected').length",
          ),
          1,
        );
        assert.equal(
          await c.eval("document.getElementById('cu-preview').disabled"),
          false,
        );
      },
    );
    await check("múltiplos legados e remoção acessível", async () => {
      await c.input("cu-search-legacy", "3");
      await c.wait("document.querySelector('[data-action=choose-legacy]')");
      await c.action("choose-legacy");
      assert.equal(
        await c.eval(
          "document.querySelectorAll('#cu-legacies .cu-selected').length",
        ),
        2,
      );
      await c.action("remove-legacy", 1);
      assert.equal(
        await c.eval(
          "document.querySelectorAll('#cu-legacies .cu-selected').length",
        ),
        1,
      );
    });
    await check(
      "preview envia manifesto v1 e renderiza identidades, contas, Grant, Base, blocker e info",
      async () => {
        await initialPreview();
        const request = calls.filter((r) => r.route === "/preview").at(-1).body;
        assert.deepEqual(request.manifest.clientesLegadosIds, [2]);
        assert.equal(request.manifest.clienteCanonicoId, 1);
        assert.equal(request.manifest.schemaVersion, 1);
        const txt = await c.text("cu-review");
        for (const v of [
          "Conta #11",
          "Conta #21",
          "Grant #31",
          "Base Matriz",
          "Cliente #2",
          "UNIQUE_COLLISION",
          "BUSINESS_APPROVAL_IS_EXTERNAL",
        ])
          assert.ok(txt.includes(v), v);
        assert.equal(
          await c.eval("document.querySelector('#cu-review img[src=x]')"),
          null,
        );
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
      },
    );
    await check(
      "decisões invalidam preview e geram hash novo pelo backend",
      async () => {
        const old = previewHash;
        await decide();
        assert.notEqual(previewHash, old);
        assert.equal(currentPreview.decisionsRequired.length, 0);
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
      },
    );
    await check(
      "atualizar preview exige revisão e confirmação novas",
      async () => {
        await confirm();
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          false,
        );
        await c.click("cu-preview");
        await c.wait(
          "document.getElementById('cu-execution-state').textContent.includes('Preview validado') && !document.getElementById('cu-preview').disabled",
        );
        assert.equal(
          await c.eval("document.getElementById('cu-reviewed').checked"),
          false,
        );
        assert.equal(
          await c.eval("document.getElementById('cu-confirmation').value"),
          "",
        );
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
      },
    );
    await check(
      "confirmação forte e duplo clique protegido com hash real",
      async () => {
        await c.check("cu-reviewed");
        await c.input("cu-confirmation", "unificar");
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
        await confirm();
        mode.executeDelay = 700;
        const n = calls.filter((r) => r.route === "/execute").length;
        await c.click("cu-execute");
        await c.click("cu-execute");
        await c.wait(
          "document.getElementById('cu-execute').textContent.includes('Unificando')",
        );
        await c.wait(
          "document.getElementById('cu-result').textContent.includes('Unificação concluída')",
        );
        assert.equal(calls.filter((r) => r.route === "/execute").length, n + 1);
        const req = calls.filter((r) => r.route === "/execute").at(-1).body;
        assert.equal(req.planHash, previewHash);
        assert.match(req.idempotencyKey, /^[a-f0-9-]{36}$/);
      },
    );
    await check(
      "sucesso dedicado não redireciona e abre auditoria",
      async () => {
        assert.match(await c.text("cu-result"), /Contas preservadas\s*2/);
        assert.ok(
          (await c.eval("location.pathname")).endsWith(
            "clientes-unificacao.html",
          ),
        );
        await c.action("open-detail");
        await c.wait(
          "document.getElementById('cu-detail').textContent.includes('Manifesto')",
        );
        assert.ok(await c.eval("document.getElementById('cu-rollback')"));
      },
    );
    await check("histórico, paginação e detalhe sem JSON bruto", async () => {
      mode.historyMore = true;
      await c.click("cu-tab-history");
      await c.wait("document.querySelector('[data-action=more-history]')");
      assert.match(await c.text("cu-history"), /Concluída/);
      await c.action("more-history");
      await c.wait(
        "document.querySelectorAll('#cu-history tbody tr').length===2",
      );
      assert.equal(
        await c.eval("document.querySelector('#cu-detail pre')"),
        null,
      );
    });
    await check(
      "rollback confirmação forte, duplo clique e sucesso",
      async () => {
        await c.input("cu-rollback-confirmation", "errado");
        assert.equal(
          await c.eval("document.getElementById('cu-rollback').disabled"),
          true,
        );
        await c.input("cu-rollback-confirmation", "REVERTER UNIFICACAO 1");
        mode.rollbackDelay = 600;
        const n = calls.filter((r) => r.route.endsWith("/rollback")).length;
        await c.click("cu-rollback");
        await c.click("cu-rollback");
        await c.wait(
          "document.getElementById('cu-detail').textContent.includes('Rollback concluído')",
        );
        assert.equal(
          calls.filter((r) => r.route.endsWith("/rollback")).length,
          n + 1,
        );
        assert.equal(
          await c.eval("document.getElementById('cu-rollback')"),
          null,
        );
      },
    );
    await check("histórico vazio e erro", async () => {
      operations = [];
      await c.click("cu-tab-history");
      await c.wait(
        "document.getElementById('cu-history').textContent.includes('Nenhuma')",
      );
      mode.historyError = true;
      await c.click("cu-tab-history");
      await c.wait("document.querySelector('[data-action=retry-history]')");
      mode.historyError = false;
      await c.action("retry-history");
    });
    await check("preview erro não entra em loop e permite retry", async () => {
      reset();
      await goto();
      await ready();
      await select();
      mode.previewError = true;
      const n = calls.filter((r) => r.route === "/preview").length;
      await c.click("cu-preview");
      await c.wait("!document.getElementById('cu-preview').disabled");
      await sleep(600);
      assert.equal(calls.filter((r) => r.route === "/preview").length, n + 1);
      mode.previewError = false;
      await initialPreview();
    });
    await check("warnings são retornados pelo domínio real", async () => {
      mode.warning = true;
      await c.click("cu-preview");
      await c.wait(
        "document.getElementById('cu-review').textContent.includes('ACCOUNT_WITHOUT_BASE')",
      );
      mode.warning = false;
      await c.click("cu-preview");
      await c.wait("!document.getElementById('cu-preview').disabled");
      await decide();
      await confirm();
    });
    await check("execute flag OFF no preview não libera botão", async () => {
      config.executeEnabled = false;
      await c.click("cu-preview");
      await c.wait(
        "document.getElementById('cu-execution-state').textContent.includes('não habilitada')",
      );
      assert.equal(
        await c.eval("document.getElementById('cu-execute').disabled"),
        true,
      );
      config.executeEnabled = true;
      await c.click("cu-preview");
      await c.wait(
        "document.getElementById('cu-execution-state').textContent.includes('Preview validado')",
      );
      await confirm();
    });
    await check(
      "execute flag desligada após preview é erro conhecido",
      async () => {
        mode.executeError = "CLIENTES_UNIFICACAO_EXECUTE_DISABLED";
        await c.click("cu-execute");
        await c.wait(
          "document.getElementById('cu-feedback').textContent.includes('não habilitada')",
        );
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
        mode.executeError = null;
      },
    );
    for (const code of [
      "MERGE_PLAN_CHANGED",
      "GRANT_AMBIGUOUS",
      "UNEXPECTED_SECRET_CODE",
    ])
      await check(`execute ${code} seguro e invalida hash`, async () => {
        await c.click("cu-preview");
        await c.wait(
          "document.getElementById('cu-execution-state').textContent.includes('Preview validado')",
        );
        await confirm();
        mode.executeError = code;
        await c.click("cu-execute");
        await c.wait("document.getElementById('cu-confirm').hidden");
        assert.equal(
          await c.eval("document.getElementById('cu-execute').disabled"),
          true,
        );
        assert.ok(!(await c.text("cu-feedback")).includes("SECRET"));
        mode.executeError = null;
      });
    await check(
      "timeout retry conserva chave; pendente não vira sucesso",
      async () => {
        await c.click("cu-preview");
        await c.wait(
          "document.getElementById('cu-execution-state').textContent.includes('Preview validado')",
        );
        await confirm();
        mode.executeError = "MERGE_CONNECTION_LOST";
        await c.click("cu-execute");
        await c.wait(
          "document.getElementById('cu-execute').textContent.includes('mesma tentativa')",
        );
        const key = calls.filter((r) => r.route === "/execute").at(-1)
          .body.idempotencyKey;
        assert.equal(
          await c.eval("document.getElementById('cu-new').disabled"),
          true,
        );
        mode.executeError = null;
        mode.pending = true;
        await c.click("cu-execute");
        await c.wait(
          "document.getElementById('cu-result').textContent.includes('Operação registrada')",
        );
        assert.equal(
          calls.filter((r) => r.route === "/execute").at(-1).body
            .idempotencyKey,
          key,
        );
        assert.ok(
          !(await c.text("cu-result")).includes("Unificação concluída"),
        );
      },
    );
    await check(
      "atualizar operação pendente libera editor só após resultado terminal",
      async () => {
        operations[0].status = "completed";
        operations[0].rollbackAvailable = true;
        await c.action("open-detail");
        await c.wait(
          "document.getElementById('cu-result').textContent.includes('Unificação concluída')",
        );
        assert.equal(
          await c.eval("document.getElementById('cu-new').disabled"),
          false,
        );
      },
    );
    await check("rollback flag OFF não mostra ação", async () => {
      config.rollbackEnabled = false;
      await goto();
      await ready();
      await c.click("cu-tab-history");
      await c.wait(
        "document.querySelector('#cu-history [data-action=open-detail]')",
      );
      await clickSelector("#cu-history [data-action=open-detail]");
      await c.wait(
        "document.getElementById('cu-detail').textContent.includes('não habilitado')",
      );
      assert.equal(
        await c.eval("document.getElementById('cu-rollback')"),
        null,
      );
    });
    await check("rollback backend flag disabled após abertura", async () => {
      config.rollbackEnabled = true;
      await goto();
      await ready();
      await c.click("cu-tab-history");
      await c.wait(
        "document.querySelector('#cu-history [data-action=open-detail]')",
      );
      await clickSelector("#cu-history [data-action=open-detail]");
      await c.wait("document.getElementById('cu-rollback')");
      await c.input("cu-rollback-confirmation", "REVERTER UNIFICACAO 1");
      mode.rollbackError = "CLIENTES_UNIFICACAO_ROLLBACK_DISABLED";
      await c.click("cu-rollback");
      await c.wait(
        "document.getElementById('cu-rollback-feedback').textContent.includes('não habilitado')",
      );
      assert.equal(
        await c.eval("document.getElementById('cu-rollback-fields').hidden"),
        true,
      );
    });
    await check("rollback divergência sem ação forçar", async () => {
      mode.rollbackError = "ROLLBACK_STATE_DIVERGED";
      await goto();
      await ready();
      await c.click("cu-tab-history");
      await c.wait(
        "document.querySelector('#cu-history [data-action=open-detail]')",
      );
      await clickSelector("#cu-history [data-action=open-detail]");
      await c.wait("document.getElementById('cu-rollback')");
      await c.input("cu-rollback-confirmation", "REVERTER UNIFICACAO 1");
      await c.click("cu-rollback");
      await c.wait(
        "document.getElementById('cu-rollback-feedback').textContent.includes('Nenhuma alteração')",
      );
      assert.ok(!(await c.text("cu-detail")).includes("Forçar"));
    });
    await check("detalhe erro e retry", async () => {
      mode.detailError = true;
      await c.action("refresh-detail");
      await c.wait(
        "document.getElementById('cu-detail').textContent.includes('Tentar novamente')",
      );
      mode.detailError = false;
      await c.action("refresh-detail");
      await c.wait(
        "document.getElementById('cu-detail').textContent.includes('Manifesto')",
      );
    });
    await check("responsividade 1440/1024/390, foco e labels", async () => {
      for (const width of [1440, 1024, 390]) {
        await c.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width < 500,
        });
        await sleep(180);
        assert.ok(
          await c.eval(
            "document.documentElement.scrollWidth <= innerWidth + 1",
          ),
          `overflow ${width}`,
        );
      }
      assert.equal(
        await c.eval(
          "Array.from(document.querySelectorAll('input')).every(i=>i.id&&document.querySelector('label[for=\"'+i.id+'\"]')||i.closest('label'))",
        ),
        true,
      );
      await c.eval(
        "document.getElementById('cu-tab-candidates').focus();document.getElementById('cu-tab-candidates').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
      );
      assert.equal(await c.eval("document.activeElement.id"), "cu-tab-history");
    });
    console.log(
      `\n${count} cenários UI/contratos/segurança passaram em Chrome.`,
    );
  } finally {
    try {
      await b.close();
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
