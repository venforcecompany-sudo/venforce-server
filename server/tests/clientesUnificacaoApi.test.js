const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const jwt = require("jsonwebtoken");
const express = require("express");
const databasePath = require.resolve("../config/database");
let role = "admin",
  active = true,
  calls = 0;
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {
    query: async () => ({ rows: [{ id: 5, role, ativo: active }] }),
    connect: async () => {
      throw new Error("API_FACTORY_MUST_NOT_CONNECT");
    },
  },
};
process.env.JWT_SECRET = "SYNTHETIC_TEST_SECRET_32_CHARACTERS_ONLY";
const { createRouter } = require("../routes/clientesUnificacaoRoutes");
const methods = [
  "preview",
  "execute",
  "rollback",
  "history",
  "detail",
  "candidates",
  "search",
];
const service = Object.fromEntries(
  methods.map((k) => [
    k,
    async () => {
      calls++;
      return { marker: k };
    },
  ]),
);
async function main() {
  const app = express();
  app.use(express.json());
  app.use("/admin/clientes-unificacao", createRouter({ service }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "/admin/clientes-unificacao",
    token = jwt.sign({ id: 5 }, process.env.JWT_SECRET);
  let count = 0;
  async function request(method, path, bearer, body = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body),
        req = http.request(
          {
            hostname: "127.0.0.1",
            port: server.address().port,
            path: base + path,
            method,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(data),
              ...(bearer ? { authorization: "Bearer " + bearer } : {}),
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (s) => (data += s));
            res.on("end", () =>
              resolve({ status: res.statusCode, body: JSON.parse(data) }),
            );
          },
        );
      req.on("error", reject);
      req.end(data);
    });
  }
  const endpoints = [
    ["GET", "/config", "config"],
    ["POST", "/preview", "preview"],
    ["POST", "/execute", "execute"],
    ["POST", "/1/rollback", "rollback"],
    ["GET", "", "history"],
    ["GET", "/1", "detail"],
    ["GET", "/candidatos", "candidates"],
    ["GET", "/busca?q=teste", "search"],
  ];
  try {
    for (const [method, path, key] of endpoints) {
      const r = await request(method, path);
      assert.equal(r.status, 401);
      count++;
    }
    assert.equal(calls, 0);
    for (const denied of [
      "coordenador",
      "analista",
      "auxiliar",
      "user",
      "seller",
    ]) {
      role = denied;
      for (const [method, path] of endpoints) {
        assert.equal((await request(method, path, token)).status, 403);
        count++;
      }
    }
    assert.equal(calls, 0);
    role = "admin";
    active = false;
    assert.equal((await request("POST", "/execute", token)).status, 403);
    assert.equal(calls, 0);
    count++;
    active = true;
    for (const [method, path, key] of endpoints) {
      const r = await request(method, path, token);
      assert.equal(r.status, 200);
      if (key === "config") {
        assert.equal(r.body.uiEnabled, false);
        assert.deepEqual(r.body.actor, { id: 5, role: "admin" });
        assert.ok(!JSON.stringify(r.body).includes("SECRET"));
      } else assert.equal((r.body.operation || r.body).marker, key);
      count++;
    }
    for (const raw of [undefined, "false", "0", "on", "invalid", "true"]) {
      if (raw === undefined) delete process.env.CLIENTES_UNIFICACAO_UI_ENABLED;
      else process.env.CLIENTES_UNIFICACAO_UI_ENABLED = raw;
      assert.equal((await request("GET", "/config", token)).body.uiEnabled, raw === "true");
      count++;
    }
    delete process.env.CLIENTES_UNIFICACAO_UI_ENABLED;
    service.execute = async () => {
      throw Object.assign(new Error("RAW_SQL_SECRET_MUST_NOT_LEAK"), {
        code: "MERGE_PLAN_CHANGED",
      });
    };
    const stale = await request("POST", "/execute", token);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "MERGE_PLAN_CHANGED");
    assert.ok(!JSON.stringify(stale).includes("RAW_SQL_SECRET"));
    count++;
    service.execute = async () => {
      throw new Error("RAW_SQL_SECRET_MUST_NOT_LEAK");
    };
    const failure = await request("POST", "/execute", token);
    assert.equal(failure.status, 500);
    assert.equal(failure.body.code, "MERGE_OPERATION_FAILED");
    assert.ok(!JSON.stringify(failure).includes("RAW_SQL_SECRET"));
    count++;
    console.log(`${count} verificações HTTP/auth/admin/sigilo passaram.`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
