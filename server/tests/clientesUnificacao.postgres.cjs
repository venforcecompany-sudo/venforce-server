// Integração obrigatória para revisão. Não faz parte do runner offline legado:
// requer URL LOCAL explícita e cria/apaga somente vf_unificacao_test_*.
const assert = require("node:assert/strict");
const { environment } = require("./helpers/clientesUnificacaoPostgres");
const { createService } = require("../services/clientesUnificacao/service");
const repo = require("../services/clientesUnificacao/repository");
const { manifest } = require("./helpers/clientesUnificacaoFixture");
const { buildPlan } = require("../services/clientesUnificacao/planner");
const actor = { id: 5, role: "admin", ativo: true };
let cases = 0;
async function main() {
  const env = await environment(),
    pool = env.pool;
  let flags = { execute: true, rollback: true };
  const service = createService({ pool, getFlags: () => flags });
  const test = async (name, fn) => {
    await env.seed();
    flags = { execute: true, rollback: true };
    await fn();
    cases++;
    console.log("ok — " + name);
  };
  const preview = async (m = manifest()) => service.preview(m, actor);
  const input = async (key = "operation-test-1", m = manifest()) => {
    const p = await preview(m);
    assert.equal(p.validationReady, true, JSON.stringify(p.blockers));
    return {
      manifest: m,
      planHash: p.planHash,
      idempotencyKey: key,
      confirmationText: p.confirmationText,
    };
  };
  const merge = async () => service.execute(await input(), actor);
  const reverse = async (op) =>
    service.rollback(
      op.id,
      { confirmationText: `REVERTER UNIFICACAO ${op.id}` },
      actor,
    );
  try {
    await test("infraestrutura repetível não une registros", async () => {
      assert.equal(
        (await pool.query("SELECT count(*) FROM cliente_unificacoes")).rows[0]
          .count,
        "0",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM clientes WHERE merged_into_cliente_id IS NOT NULL",
          )
        ).rows[0].count,
        "0",
      );
    });
    await test("preview estável, sem escrita funcional e sem secrets", async () => {
      const before = (
        await pool.query("SELECT cliente_id FROM cliente_contas ORDER BY id")
      ).rows;
      const a = await preview(),
        b = await preview();
      assert.equal(a.planHash, b.planHash);
      assert.equal(a.validationReady, true, JSON.stringify(a.blockers));
      assert.deepEqual(
        (await pool.query("SELECT cliente_id FROM cliente_contas ORDER BY id"))
          .rows,
        before,
      );
      assert.ok(!JSON.stringify(a).includes("SECRET_"));
      assert.equal(
        (await pool.query("SELECT count(*) FROM cliente_unificacoes")).rows[0]
          .count,
        "0",
      );
    });
    await test("execute flag OFF antes de consultar pool", async () => {
      flags.execute = false;
      const bad = createService({
        pool: {
          connect() {
            throw new Error("SHOULD_NOT_CONNECT");
          },
        },
        getFlags: () => flags,
      });
      await assert.rejects(bad.execute({ manifest: manifest() }, actor), {
        code: "CLIENTES_UNIFICACAO_EXECUTE_DISABLED",
      });
    });
    await test("admin obrigatório em todos os serviços", async () => {
      const user = { id: 6, role: "user" };
      for (const call of [
        () => service.preview(manifest(), user),
        () => service.execute({}, user),
        () => service.rollback("1", {}, user),
        () => service.history({}, user),
        () => service.detail("1", user),
        () => service.search({}, user),
        () => service.candidates(user),
      ])
        await assert.rejects(call(), { code: "ADMIN_REQUIRED" });
    });
    await test("confirmação forte validada no backend", async () => {
      const i = await input();
      i.confirmationText = "UNIFICAR";
      await assert.rejects(service.execute(i, actor), {
        code: "STRONG_CONFIRMATION_REQUIRED",
      });
    });
    await test("stale planHash aborta antes de escrever", async () => {
      const i = await input();
      await pool.query(
        "UPDATE cliente_contas SET nome='Alteração posterior' WHERE id=21",
      );
      await assert.rejects(service.execute(i, actor), {
        code: "MERGE_PLAN_CHANGED",
      });
      assert.equal(
        (await pool.query("SELECT cliente_id FROM cliente_contas WHERE id=21"))
          .rows[0].cliente_id,
        2,
      );
    });
    await test("execução transacional preserva IDs/seller/Grant/Base e mapping", async () => {
      const tokensBefore = (
        await pool.query("SELECT * FROM ml_tokens ORDER BY id")
      ).rows;
      const op = await merge();
      assert.equal(op.status, "completed");
      assert.equal(
        (await pool.query("SELECT cliente_id FROM cliente_contas WHERE id=21"))
          .rows[0].cliente_id,
        1,
      );
      const grants = (await pool.query("SELECT * FROM ml_tokens ORDER BY id"))
        .rows;
      assert.deepEqual(
        grants.map((g) => g.id),
        tokensBefore.map((g) => g.id),
      );
      for (let i = 0; i < grants.length; i++)
        for (const k of [
          "ml_user_id",
          "cliente_conta_id",
          "access_token",
          "refresh_token",
        ])
          assert.equal(grants[i][k], tokensBefore[i][k]);
      assert.equal(
        (
          await pool.query(
            "SELECT base_id FROM base_cliente_vinculos WHERE id=52",
          )
        ).rows[0].base_id,
        42,
      );
      const c = (await pool.query("SELECT * FROM clientes WHERE id=2")).rows[0];
      assert.equal(c.ativo, false);
      assert.equal(c.merged_into_cliente_id, 1);
      assert.equal(c.nome, "Legado sintético");
      assert.equal(c.slug, "legado");
      assert.ok(op.beforeSummary);
      assert.ok(op.afterSummary);
      assert.ok(op.plan.rollback);
      assert.ok(!JSON.stringify(op).includes("SECRET_"));
      assert.ok(
        (
          await pool.query(
            "SELECT * FROM activity_logs WHERE acao='CLIENT_UNIFICATION_EXECUTED'",
          )
        ).rowCount,
      );
      assert.equal((await service.resolveCanonicalCliente(2)).cliente.id, 1);
    });
    await test("idempotência e retry após commit retornam resultado persistido", async () => {
      const i = await input();
      const a = await service.execute(i, actor),
        b = await service.execute(i, actor);
      assert.equal(a.id, b.id);
      assert.equal(b.status, "completed");
      assert.equal(
        (await pool.query("SELECT count(*) FROM cliente_unificacoes")).rows[0]
          .count,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM cliente_unificacao_events WHERE event='CLIENT_UNIFICATION_EXECUTED'",
          )
        ).rows[0].count,
        "1",
      );
    });
    await test("chave reutilizada com intenção diferente recusa", async () => {
      const i = await input();
      await service.execute(i, actor);
      i.planHash = "a".repeat(64);
      await assert.rejects(service.execute(i, actor), {
        code: "IDEMPOTENCY_KEY_REUSED",
      });
    });
    await test("mesma chave em voo retorna operação atual", async () => {
      const i = await input();
      let release, entered;
      const gate = new Promise((r) => (release = r)),
        start = new Promise((r) => (entered = r));
      const custom = {
        ...repo,
        applyChanges: async (...a) => {
          entered();
          await gate;
          return repo.applyChanges(...a);
        },
      };
      const s = createService({
        pool,
        repository: custom,
        getFlags: () => flags,
      });
      const pending = s.execute(i, actor);
      await start;
      const replay = await service.execute(i, actor);
      assert.ok(["validated", "executing"].includes(replay.status));
      release();
      assert.equal((await pending).status, "completed");
    });
    await test("alteração 1 OK, 2 OK, 3 FALHA: nenhuma persiste", async () => {
      const before = (
        await pool.query(
          "SELECT id,cliente_id,is_primary FROM cliente_contas ORDER BY id",
        )
      ).rows;
      const custom = {
        ...repo,
        applyChanges: async (db, s, changes) => {
          const firstTwo = changes.filter((c) => c.after.is_primary === false);
          assert.equal(firstTwo.length, 2);
          await repo.applyChanges(db, s, firstTwo);
          assert.equal(
            (
              await db.query(
                "SELECT is_primary FROM cliente_contas WHERE id=11",
              )
            ).rows[0].is_primary,
            false,
          );
          assert.equal(
            (await db.query("SELECT is_primary FROM ml_tokens WHERE id=31"))
              .rows[0].is_primary,
            false,
          );
          await db.query("INSERT INTO cliente_contas(id) VALUES(11)");
        },
      };
      const s = createService({
        pool,
        repository: custom,
        getFlags: () => flags,
      });
      const i = await input();
      await assert.rejects(s.execute(i, actor), {
        code: "UNIQUE_OR_CONSTRAINT_COLLISION",
      });
      assert.deepEqual(
        (
          await pool.query(
            "SELECT id,cliente_id,is_primary FROM cliente_contas ORDER BY id",
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT ativo,merged_into_cliente_id FROM clientes WHERE id=2",
          )
        ).rows[0].ativo,
        true,
      );
      const op = (await service.history({}, actor)).operations[0];
      assert.equal(op.status, "failed");
      assert.equal(op.beforeSummary.available, false);
      assert.equal((await service.detail(op.id, actor)).beforeSummary, null);
      await assert.rejects(s.execute(i, actor), {
        code: "IDEMPOTENCY_RETRY_REQUIRES_NEW_KEY",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM activity_logs WHERE acao='CLIENT_UNIFICATION_EXECUTED'",
          )
        ).rows[0].count,
        "0",
      );
    });
    await test("pós-validação falha reverte movimentação inteira", async () => {
      const custom = {
        ...repo,
        applyChanges: async (db, s, c) => {
          await repo.applyChanges(db, s, c);
          await db.query(
            "UPDATE cliente_contas SET external_account_id='WRONG' WHERE id=21",
          );
        },
      };
      const s = createService({
        pool,
        repository: custom,
        getFlags: () => flags,
      });
      await assert.rejects(s.execute(await input(), actor), {
        code: "MERGE_POST_VALIDATION_FAILED",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT external_account_id,cliente_id FROM cliente_contas WHERE id=21",
          )
        ).rows[0].external_account_id,
        "222",
      );
    });
    await test("concorrência mesma origem e destinos sobrepostos: uma execução", async () => {
      const m1 = manifest(),
        m2 = {
          ...manifest(),
          clienteCanonicoId: 3,
          clientesLegadosIds: [2],
          decisoes: { primaryAccounts: { meli: 21 }, primaryGrantId: 32 },
        };
      const i1 = await input("concurrency-op-a", m1),
        i2 = await input("concurrency-op-b", m2);
      const results = await Promise.allSettled([
        service.execute(i1, actor),
        service.execute(i2, actor),
      ]);
      assert.equal(
        results.filter((r) => r.status === "fulfilled").length,
        1,
        JSON.stringify(results),
      );
      assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      assert.ok(
        ["MERGE_BUSY", "MERGE_PLAN_CHANGED"].includes(
          results.find((r) => r.status === "rejected").reason.code,
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM cliente_unificacoes WHERE status='completed'",
          )
        ).rows[0].count,
        "1",
      );
    });
    await test("destinos independentes no mesmo Squad não usam lock global", async () => {
      const a = await input("independent-op-a");
      const m = {
        ...manifest(),
        clienteCanonicoId: 3,
        clientesLegadosIds: [4],
        decisoes: {},
      };
      const b = await input("independent-op-b", m);
      const result = await Promise.all([
        service.execute(a, actor),
        service.execute(b, actor),
      ]);
      assert.ok(result.every((r) => r.status === "completed"));
    });
    await test("revalidação sob lock pega mudança entre preflight e BEGIN", async () => {
      const i = await input();
      const custom = {
        ...repo,
        reserve: async (...args) => {
          const r = await repo.reserve(...args);
          await pool.query(
            "UPDATE cliente_contas SET nome='Mudou' WHERE id=21",
          );
          return r;
        },
      };
      const s = createService({
        pool,
        repository: custom,
        getFlags: () => flags,
      });
      await assert.rejects(s.execute(i, actor), { code: "MERGE_PLAN_CHANGED" });
      assert.equal(
        (await pool.query("SELECT cliente_id FROM cliente_contas WHERE id=21"))
          .rows[0].cliente_id,
        2,
      );
    });
    await test("histórico account-aware/manual/Ads preserva valores ao mover ownership", async () => {
      await env.seed({ extra: true });
      const before = (
        await pool.query(
          "SELECT faturamento FROM painel_contas_lancamentos_manuais",
        )
      ).rows;
      const op = await merge();
      assert.equal(
        (
          await pool.query(
            "SELECT cliente_id FROM painel_contas_lancamentos_manuais",
          )
        ).rows[0].cliente_id,
        1,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT faturamento FROM painel_contas_lancamentos_manuais",
          )
        ).rows,
        before,
      );
      assert.equal(
        (await pool.query("SELECT profit FROM margin_projection_snapshots"))
          .rows[0].profit,
        "67.89",
      );
      assert.equal(
        (await pool.query("SELECT cliente_slug FROM ads_resumos_mensais"))
          .rows[0].cliente_slug,
        "canonico",
      );
      await reverse(op);
      assert.equal(
        (await pool.query("SELECT cliente_slug FROM ads_resumos_mensais"))
          .rows[0].cliente_slug,
        "legado",
      );
    });
    await test("UNIQUE de Ads detectada antes de qualquer UPDATE", async () => {
      await pool.query(
        "INSERT INTO ads_resumos_mensais VALUES(91,'canonico','2026-01','todas',1),(92,'legado','2026-01','todas',2)",
      );
      const p = await preview();
      assert.ok(p.blockers.some((b) => b.code === "UNIQUE_COLLISION"));
      assert.equal(p.canExecute, false);
    });
    await test("unknown critical / Central bloqueia sem alterar P0", async () => {
      await pool.query(
        "CREATE TABLE central_vendas_imports(id integer PRIMARY KEY,cliente_id integer,cliente_conta_id integer REFERENCES cliente_contas(id))",
      );
      await pool.query("INSERT INTO central_vendas_imports VALUES(99,2,21)");
      const p = await preview();
      assert.ok(
        p.blockers.some((b) => b.code === "UNKNOWN_CRITICAL_REFERENCE"),
      );
      await pool.query("DROP TABLE central_vendas_imports");
    });
    await test("rollback flag OFF", async () => {
      const op = await merge();
      flags.rollback = false;
      await assert.rejects(reverse(op), {
        code: "CLIENTES_UNIFICACAO_ROLLBACK_DISABLED",
      });
    });
    await test("rollback inexistente/não completed", async () => {
      await assert.rejects(reverse({ id: "999" }), {
        code: "MERGE_OPERATION_NOT_FOUND",
      });
      const i = await input();
      const custom = {
        ...repo,
        applyChanges: async () => {
          throw Object.assign(new Error("fail"), {
            code: "MERGE_SIMULATED_FAILURE",
          });
        },
      };
      await assert.rejects(
        createService({
          pool,
          repository: custom,
          getFlags: () => flags,
        }).execute(i, actor),
      );
      const op = (await service.history({}, actor)).operations[0];
      await assert.rejects(reverse(op), {
        code: "ROLLBACK_OPERATION_NOT_COMPLETED",
      });
    });
    await test("rollback normal restaura ownership/primary/activity/mapping e preserva IDs", async () => {
      const before = (
        await pool.query(
          "SELECT id,cliente_id,is_primary,external_account_id FROM cliente_contas ORDER BY id",
        )
      ).rows;
      const op = await merge();
      const r = await reverse(op);
      assert.equal(r.status, "rolled_back");
      assert.deepEqual(
        (
          await pool.query(
            "SELECT id,cliente_id,is_primary,external_account_id FROM cliente_contas ORDER BY id",
          )
        ).rows,
        before,
      );
      const c = (
        await pool.query(
          "SELECT ativo,merged_into_cliente_id FROM clientes WHERE id=2",
        )
      ).rows[0];
      assert.equal(c.ativo, true);
      assert.equal(c.merged_into_cliente_id, null);
      assert.equal(
        (await pool.query("SELECT cliente_id FROM ml_tokens WHERE id=32"))
          .rows[0].cliente_id,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT cliente_id FROM base_cliente_vinculos WHERE id=52",
          )
        ).rows[0].cliente_id,
        2,
      );
      assert.ok(
        (
          await pool.query(
            "SELECT * FROM activity_logs WHERE acao='CLIENT_UNIFICATION_ROLLED_BACK'",
          )
        ).rowCount,
      );
    });
    await test("retry rollback idempotente e execução não reaplica após reversão", async () => {
      const i = await input(),
        op = await service.execute(i, actor);
      const a = await reverse(op),
        b = await reverse(op);
      assert.equal(a.id, b.id);
      assert.equal(b.status, "rolled_back");
      assert.equal((await service.execute(i, actor)).status, "rolled_back");
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM cliente_unificacao_events WHERE event='CLIENT_UNIFICATION_ROLLED_BACK'",
          )
        ).rows[0].count,
        "1",
      );
    });
    await test("after divergente: primary alterada bloqueia rollback sem sobrescrever", async () => {
      const op = await merge();
      await pool.query(
        "UPDATE cliente_contas SET is_primary=false WHERE id=21",
      );
      await assert.rejects(reverse(op), { code: "ROLLBACK_STATE_DIVERGED" });
      assert.equal(
        (
          await pool.query(
            "SELECT cliente_id,is_primary FROM cliente_contas WHERE id=21",
          )
        ).rows[0].cliente_id,
        1,
      );
      assert.equal(
        (await service.detail(op.id, actor)).status,
        "rollback_failed",
      );
    });
    await test("nova Conta no canônico bloqueia rollback", async () => {
      const op = await merge();
      await pool.query(
        "INSERT INTO cliente_contas VALUES(99,1,'shopee','Nova','nova',null,false,true)",
      );
      await assert.rejects(reverse(op), { code: "ROLLBACK_STATE_DIVERGED" });
      assert.ok(
        (await pool.query("SELECT * FROM cliente_contas WHERE id=99")).rowCount,
      );
    });
    await test("novo Grant bloqueia rollback", async () => {
      const op = await merge();
      await pool.query(
        "INSERT INTO ml_tokens VALUES(99,1,null,'999','valid',false,'NEW_SECRET','NEW_SECRET_REFRESH')",
      );
      await assert.rejects(reverse(op), { code: "ROLLBACK_STATE_DIVERGED" });
      assert.ok(
        !JSON.stringify(await service.detail(op.id, actor)).includes(
          "NEW_SECRET",
        ),
      );
    });
    await test("escrita financeira posterior detectada por xmin", async () => {
      await env.seed({ extra: true });
      const op = await merge();
      await pool.query(
        "UPDATE painel_contas_lancamentos_manuais SET faturamento=999 WHERE id=90",
      );
      await assert.rejects(reverse(op), { code: "ROLLBACK_STATE_DIVERGED" });
      assert.equal(
        (
          await pool.query(
            "SELECT faturamento FROM painel_contas_lancamentos_manuais",
          )
        ).rows[0].faturamento,
        "999",
      );
    });
    await test("falha intermediária de rollback reverte restauração inteira", async () => {
      const op = await merge();
      const custom = {
        ...repo,
        applyChanges: async (db, s, c) => {
          const firstTwo = c.filter((x) =>
            ["clientes", "base_cliente_vinculos"].includes(x.table),
          );
          assert.equal(firstTwo.length, 2);
          await repo.applyChanges(db, s, firstTwo);
          assert.equal(
            (
              await db.query(
                "SELECT cliente_id FROM base_cliente_vinculos WHERE id=52",
              )
            ).rows[0].cliente_id,
            2,
          );
          assert.equal(
            (await db.query("SELECT ativo FROM clientes WHERE id=2")).rows[0]
              .ativo,
            true,
          );
          await db.query("INSERT INTO cliente_contas(id) VALUES(11)");
        },
      };
      await assert.rejects(
        createService({
          pool,
          repository: custom,
          getFlags: () => flags,
        }).rollback(
          op.id,
          { confirmationText: `REVERTER UNIFICACAO ${op.id}` },
          actor,
        ),
        { code: "UNIQUE_OR_CONSTRAINT_COLLISION" },
      );
      assert.equal(
        (await pool.query("SELECT cliente_id FROM cliente_contas WHERE id=21"))
          .rows[0].cliente_id,
        1,
      );
      assert.equal(
        (await service.detail(op.id, actor)).status,
        "rollback_failed",
      );
      assert.equal((await reverse(op)).status, "rolled_back");
    });
    await test("ledger/events imutáveis e erro nunca inclui detalhe SQL", async () => {
      const op = await merge();
      await assert.rejects(
        pool.query("DELETE FROM cliente_unificacoes WHERE id=$1", [op.id]),
      );
      await assert.rejects(pool.query("TRUNCATE cliente_unificacoes CASCADE"));
      await assert.rejects(pool.query("TRUNCATE cliente_unificacao_events"));
      await assert.rejects(
        pool.query(
          "UPDATE cliente_unificacoes SET finished_at=now() WHERE id=$1",
          [op.id],
        ),
      );
      await assert.rejects(
        pool.query(
          "UPDATE cliente_unificacoes SET manifest_json='{}' WHERE id=$1",
          [op.id],
        ),
      );
      await assert.rejects(
        pool.query(
          "DELETE FROM cliente_unificacao_events WHERE operation_id=$1",
          [op.id],
        ),
      );
      await assert.rejects(
        pool.query(
          "UPDATE cliente_unificacoes SET after_snapshot_json='{}' WHERE id=$1",
          [op.id],
        ),
      );
      assert.ok(
        !JSON.stringify(await service.detail(op.id, actor)).includes("SECRET_"),
      );
    });
    await test("history/detail/search/candidates admin-only e seguros", async () => {
      const op = await merge();
      assert.equal((await service.detail(op.id, actor)).id, op.id);
      assert.equal(
        (
          await service.history(
            { clienteId: 2, status: "completed", limit: 1 },
            actor,
          )
        ).operations[0].id,
        op.id,
      );
      assert.equal(
        (await service.history({ clienteId: 999 }, actor)).operations.length,
        0,
      );
      assert.ok(
        (await service.search({ q: "sintético" }, actor)).clientes.length,
      );
      assert.ok(
        !JSON.stringify(await service.search({}, actor)).includes("SECRET_"),
      );
      assert.equal((await service.candidates(actor)).automaticMerge, false);
    });
    await test("helper normal/legado/ciclo defensivo", async () => {
      assert.equal((await service.resolveCanonicalCliente(2)).cliente.id, 2);
      await pool.query(
        "UPDATE clientes SET merged_into_cliente_id=CASE id WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE NULL END WHERE id IN(1,2)",
      );
      await assert.rejects(service.resolveCanonicalCliente(1), {
        code: "MERGE_CYCLE",
      });
    });
    await test("executor não faz nenhuma chamada externa", async () => {
      const previous = global.fetch;
      global.fetch = () => {
        throw new Error("EXTERNAL_NETWORK_FORBIDDEN");
      };
      try {
        const op = await merge();
        await reverse(op);
      } finally {
        global.fetch = previous;
      }
      for (const file of ["service.js", "repository.js", "planner.js"]) {
        const source = require("node:fs").readFileSync(
          require("node:path").resolve(
            __dirname,
            "../services/clientesUnificacao",
            file,
          ),
          "utf8",
        );
        assert.ok(
          !/require\(['"](?:axios|.*mlFetch|.*shopee.*http)['"]\)|\bfetch\s*\(/i.test(
            source,
          ),
        );
      }
    });

    await test("PK comercial por Cliente move e reverte com PK exata", async () => {
      await pool.query(
        "CREATE TABLE cliente_imagens(cliente_id integer PRIMARY KEY REFERENCES clientes(id),imagem text)",
      );
      try {
        await pool.query(
          "INSERT INTO cliente_imagens VALUES(2,'SYNTHETIC_IMAGE_DATA')",
        );
        const op = await merge();
        assert.equal(
          (await pool.query("SELECT cliente_id FROM cliente_imagens")).rows[0]
            .cliente_id,
          1,
        );
        await reverse(op);
        assert.equal(
          (await pool.query("SELECT cliente_id FROM cliente_imagens")).rows[0]
            .cliente_id,
          2,
        );
      } finally {
        await pool.query("DROP TABLE cliente_imagens");
      }
    });
    await test("mudança de catálogo bloqueia rollback sem forçar", async () => {
      const op = await merge();
      await pool.query(
        "CREATE TABLE dependency_unknown(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id))",
      );
      try {
        await assert.rejects(reverse(op), { code: "ROLLBACK_STATE_DIVERGED" });
      } finally {
        await pool.query("DROP TABLE dependency_unknown");
      }
      assert.equal((await reverse(op)).status, "rolled_back");
    });
    await test("API local preview→execute→detail→history→rollback end-to-end", async () => {
      const http = require("node:http"),
        express = require("express"),
        { createRouter } = require("../routes/clientesUnificacaoRoutes");
      const app = express();
      app.use(express.json());
      app.use(
        "/admin/clientes-unificacao",
        createRouter({
          service,
          authenticate: (req, res, next) => {
            req.user = actor;
            next();
          },
        }),
      );
      const server = http.createServer(app);
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const call = (method, path, body = {}) =>
        new Promise((resolve, reject) => {
          const data = JSON.stringify(body),
            req = http.request(
              {
                hostname: "127.0.0.1",
                port: server.address().port,
                path: "/admin/clientes-unificacao" + path,
                method,
                headers: {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(data),
                },
              },
              (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () =>
                  resolve({ status: res.statusCode, json: JSON.parse(data) }),
                );
              },
            );
          req.on("error", reject);
          req.end(data);
        });
      try {
        const p = await call("POST", "/preview", { manifest: manifest() });
        assert.equal(p.status, 200);
        const e = await call("POST", "/execute", {
          manifest: manifest(),
          planHash: p.json.planHash,
          idempotencyKey: "http-end-to-end",
          confirmationText: p.json.confirmationText,
        });
        assert.equal(e.status, 200);
        const op = e.json.operation;
        assert.equal(op.status, "completed");
        assert.equal(
          (await call("GET", "/" + op.id)).json.operation.status,
          "completed",
        );
        assert.equal(
          (await call("GET", "?status=completed")).json.operations.length,
          1,
        );
        const r = await call("POST", "/" + op.id + "/rollback", {
          confirmationText: "REVERTER UNIFICACAO " + op.id,
        });
        assert.equal(r.json.operation.status, "rolled_back");
        flags.execute = false;
        assert.equal(
          (await call("POST", "/execute", {})).json.code,
          "CLIENTES_UNIFICACAO_EXECUTE_DISABLED",
        );
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    await test("resposta perdida após COMMIT: retry não duplica nem marca failed", async () => {
      const i = await input("lost-response-key");
      const lossyPool = {
        connect: async () => {
          const db = await pool.connect();
          let completed = false,
            lost = false;
          return {
            release: (error) => db.release(error),
            query: async (...args) => {
              if (lost)
                throw Object.assign(new Error("LOST_TEST_CONNECTION"), {
                  code: "ECONNRESET",
                });
              if (
                String(args[0]).startsWith("UPDATE cliente_unificacoes") &&
                args[1]?.includes("completed")
              )
                completed = true;
              const result = await db.query(...args);
              if (args[0] === "COMMIT" && completed) {
                lost = true;
                throw Object.assign(new Error("LOST_TEST_RESPONSE"), {
                  code: "ECONNRESET",
                });
              }
              return result;
            },
          };
        },
      };
      const lossy = createService({ pool: lossyPool, getFlags: () => flags });
      await assert.rejects(lossy.execute(i, actor), {
        code: "MERGE_CONNECTION_LOST",
      });
      const recovered = await service.execute(i, actor);
      assert.equal(recovered.status, "completed");
      assert.equal(
        (await pool.query("SELECT count(*) FROM cliente_unificacoes")).rows[0]
          .count,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM cliente_unificacao_events WHERE event='CLIENT_UNIFICATION_EXECUTED'",
          )
        ).rows[0].count,
        "1",
      );
    });
    await test("escrita em outra carteira não bloqueia reversão do lote", async () => {
      const op = await merge();
      await pool.query(
        "UPDATE cliente_contas SET nome='Outra carteira mudou' WHERE id=31",
      );
      assert.equal((await reverse(op)).status, "rolled_back");
    });
    await test("deadline de transação reverte alterações já feitas", async () => {
      const originalNow = Date.now;
      let jumped = false;
      Date.now = () => originalNow() + (jumped ? 20000 : 0);
      try {
        const custom = {
          ...repo,
          applyChanges: async (db, s, c) => {
            const firstTwo = c.filter((x) => x.after.is_primary === false);
            assert.equal(firstTwo.length, 2);
            await repo.applyChanges(db, s, firstTwo);
            assert.equal(
              (
                await db.query(
                  "SELECT is_primary FROM cliente_contas WHERE id=11",
                )
              ).rows[0].is_primary,
              false,
            );
            jumped = true;
          },
        };
        const timed = createService({
          pool,
          repository: custom,
          getFlags: () => flags,
        });
        await assert.rejects(
          timed.execute(await input("deadline-test-key"), actor),
          { code: "MERGE_TRANSACTION_TIMEOUT" },
        );
        assert.equal(
          (
            await pool.query(
              "SELECT cliente_id FROM cliente_contas WHERE id=21",
            )
          ).rows[0].cliente_id,
          2,
        );
      } finally {
        Date.now = originalNow;
      }
    });
    await test("pool max=1 suporta preview/execute/rollback sem checkout aninhado", async () => {
      const { Pool } = require("pg");
      const single = new Pool({
        connectionString: process.env.UNIFICACAO_TEST_DATABASE_URL,
        ssl: false,
        max: 1,
        connectionTimeoutMillis: 300,
      });
      try {
        const one = createService({ pool: single, getFlags: () => flags });
        const m = manifest();
        const p = await one.preview(m, actor);
        const op = await one.execute(
          {
            manifest: m,
            planHash: p.planHash,
            idempotencyKey: "single-pool-test",
            confirmationText: p.confirmationText,
          },
          actor,
        );
        assert.equal(op.status, "completed");
        assert.equal(
          (
            await one.rollback(
              op.id,
              { confirmationText: `REVERTER UNIFICACAO ${op.id}` },
              actor,
            )
          ).status,
          "rolled_back",
        );
      } finally {
        await single.end();
      }
    });
    await test("mapping permanente impede purge de legado e canônico", async () => {
      const op = await merge();
      await assert.rejects(
        pool.query("DELETE FROM clientes WHERE id=2"),
        (e) => e.message === "MERGED_CLIENT_DELETE_BLOCKED",
      );
      await assert.rejects(pool.query("DELETE FROM clientes WHERE id=1"));
      assert.equal((await service.resolveCanonicalCliente(2)).cliente.id, 1);
      await reverse(op);
      assert.equal((await service.resolveCanonicalCliente(2)).cliente.id, 2);
    });
    console.log(
      `${cases} cenários PostgreSQL passaram; banco descartável, zero produção.`,
    );
  } finally {
    await env.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
