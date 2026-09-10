# Caixa-Preta do Fechamento Financeiro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um fechamento financeiro (POST `/fechamentos/financeiro`) detectar uma anomalia real (custo não encontrado, identidade ambígua/conflito de IDs, cobertura incompleta, exceção de processamento), o backend deve automaticamente preservar os arquivos originais (buffers exatos) e o diagnóstico técnico em um "incidente" (`FIN-<id>`) consultável por admin/TI, sem alterar o resultado/erro original devolvido ao usuário.

**Architecture:** Uma função pura `detectarIncidenteFechamento(result)` roda depois do motor real (`processFechamentoFinanceiro`) e classifica o resultado usando os campos REAIS que o motor já produz (`unmatchedIds`, `unmatchedCosts`, `summary.financialConfidence`, `summary.revenueWithoutCost`). Quando ela aponta um problema — ou quando o processamento lança exceção — um `fechamentoIncidentStorageService` (armazenamento em Postgres, BYTEA, com TTL) persiste os buffers exatos dos arquivos enviados (`sales`/`costs`/`ordersAll`/`onhold`) e um diagnóstico (incluindo snapshot do `debugCollector` já existente do Debug Financeiro, para MELI/Shopee). Tudo isso roda dentro de try/catch que NUNCA pode alterar a resposta original — falha na captura é só um `console.error`. Endpoints admin-only permitem buscar por código e baixar os arquivos. O motor financeiro (`meliFinanceiroService`, `shopeePerformanceService`, `tiktokFinanceiroService`) não é tocado.

**Tech Stack:** Node.js/Express, `pg` (Pool já existente em `config/database.js`), `multer` (memoryStorage já existente), Postgres (BYTEA), `crypto` (sha256 nativo), `node --test`-style runner do projeto (`node tests/run-all.js`).

**Spec:** Mission brief do usuário nesta conversa (caixa-preta do fechamento financeiro) — sem arquivo de spec separado; este plano incorpora os requisitos diretamente.

## Global Constraints

- NUNCA alterar fórmulas financeiras de MELI/Shopee/TikTok (`meliFinanceiroService.js`, `shopeePerformanceService.js`, `shopeeOrderAllService.js`, `tiktokFinanceiroService.js` não sofrem nenhuma mudança de lógica).
- NÃO tocar em Squads (nenhum arquivo de `services/squads/`, `routes/squadsRoutes*`, migrations de squads).
- Captura de incidente é 100% automática — nenhum clique do usuário é necessário para o caminho principal.
- A captura NUNCA pode mascarar ou alterar o erro/resultado original — qualquer falha da captura é engolida internamente (log apenas).
- Nomes de campos usados na detecção são os REAIS do motor (confirmados por leitura de código, não inventados): `unmatchedIds` (array de strings, todos os marketplaces), `unmatchedCosts` (array `{type, value, sku, candidates?, reason}`, populado só quando Shopee processa `ordersAll` — `type: "ambiguous_ids"` é o conflito de identidade), `unmatchedCancelled`, `summary.financialConfidence` (`"confiavel" | "parcial" | "insuficiente"`), `summary.revenueWithoutCost`, `summary.calculatedCoveragePercent`, `summary.missingColumns`.
- Arquivos NUNCA vão para o repositório git nem para disco do projeto — só Postgres BYTEA, atrás de `fechamentoIncidentStorageService`.
- Downloads exigem `requireAdmin` (já existe em `middlewares/authMiddleware.js`) — nunca URL pública.
- Retenção padrão 15 dias via `FECHAMENTO_INCIDENT_RETENTION_DAYS`; limite de arquivo persistido via `FECHAMENTO_INCIDENT_MAX_FILE_MB` (default 20, igual ao limite do multer da rota).
- Migration em `server/sql/migrations/`, SQL idempotente (`CREATE TABLE IF NOT EXISTS`, blocos `DO $$ ... EXCEPTION WHEN duplicate_object`), aplicação manual (mesmo padrão de `20260817_cliente_contas_foundation.sql`), com `ensureFechamentoIncidenteTables()` como rede de segurança no boot — mesmo padrão de `ensureObservabilityTables`/`ensureSquadsTables`. **Atenção:** `server/.env` aponta para produção — o boot real do servidor aplica essa DDL na produção (igual já acontece com observability/squads); os testes automatizados não sobem o servidor nem chamam essa função, então não têm esse efeito.
- Rota `POST /fechamentos/financeiro` é compartilhada por Financeiro legado (`Portal/financeiro.js:2306`) e V3 (`frontend-react/src/services/financeiroFechamentoApi.js:79`) — instrumentar na camada do controller cobre os dois.

---

## Task 1: Migration — tabelas `fechamento_incidentes` e `fechamento_incidente_arquivos`

**Files:**
- Create: `server/sql/migrations/20260910_fechamento_incidentes.sql`

- [ ] **Step 1: Escrever a migration idempotente**

```sql
-- Caixa-preta do fechamento financeiro: preserva, de forma temporária,
-- os arquivos e o diagnóstico de fechamentos MELI/Shopee/TikTok que
-- apresentaram anomalia (custo não encontrado, identidade ambígua,
-- cobertura incompleta) ou lançaram exceção.
--
-- Aditiva. Não altera nenhuma tabela existente.
-- Idempotente: pode ser executado mais de uma vez sem duplicar nada.
-- Aplicação: manual (mesmo padrão de 20260817_cliente_contas_foundation.sql).
-- O boot do servidor também garante estas tabelas via
-- repositories/fechamentoIncidenteRepository.js (ensureFechamentoIncidenteTables).

BEGIN;

CREATE TABLE IF NOT EXISTS fechamento_incidentes (
  id SERIAL PRIMARY KEY,
  codigo TEXT,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  cliente_slug TEXT,
  cliente_conta_id INTEGER REFERENCES cliente_contas(id) ON DELETE SET NULL,
  marketplace TEXT NOT NULL,
  periodo TEXT,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger_tipo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto',
  resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostico_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  resolved_at TIMESTAMP
);

DO $$
BEGIN
  ALTER TABLE fechamento_incidentes ADD CONSTRAINT fechamento_incidentes_status_check
    CHECK (status IN ('aberto', 'em_analise', 'resolvido'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fechamento_incidentes ADD CONSTRAINT fechamento_incidentes_marketplace_check
    CHECK (marketplace IN ('meli', 'shopee', 'tiktok'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fechamento_incidentes_codigo
  ON fechamento_incidentes (codigo) WHERE codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_expires_at
  ON fechamento_incidentes (expires_at);
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_cliente
  ON fechamento_incidentes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_created_at
  ON fechamento_incidentes (created_at DESC);

CREATE TABLE IF NOT EXISTS fechamento_incidente_arquivos (
  id SERIAL PRIMARY KEY,
  incidente_id INTEGER NOT NULL REFERENCES fechamento_incidentes(id) ON DELETE CASCADE,
  tipo_arquivo TEXT NOT NULL,
  nome_original TEXT NOT NULL,
  mime_type TEXT,
  tamanho_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  conteudo BYTEA,
  conteudo_truncado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fechamento_incidente_arquivos_incidente
  ON fechamento_incidente_arquivos (incidente_id);

COMMIT;

-- ============================================================
-- `codigo` é preenchido em uma segunda escrita (UPDATE codigo = 'FIN-' || id)
-- logo após o INSERT, dentro da mesma chamada de
-- fechamentoIncidenteRepository.createIncidente — por isso a coluna é
-- nullable no schema mas nunca fica NULL para quem lê pela API.
-- ============================================================
```

- [ ] **Step 2: Verificar sintaxe do SQL sem aplicar em banco nenhum**

Run: `node -e "require('fs').readFileSync('server/sql/migrations/20260910_fechamento_incidentes.sql','utf8')"` (smoke check de que o arquivo existe e é lido; a migration em si só é aplicada manualmente em produção pelo time, ou pelo `ensureFechamentoIncidenteTables()` no boot real do servidor — não neste plano/sessão de testes).

- [ ] **Step 3: Commit**

```bash
git add server/sql/migrations/20260910_fechamento_incidentes.sql
git commit -m "feat(fechamento-incidentes): migration idempotente para caixa-preta do fechamento"
```

---

## Task 2: Repository — `fechamentoIncidenteRepository.js`

**Files:**
- Create: `server/repositories/fechamentoIncidenteRepository.js`
- Test: `server/tests/fechamentoIncidenteRepository.test.js`

**Interfaces:**
- Produces: `ensureFechamentoIncidenteTables(db = pool)`, `createIncidente(data, db = pool) -> {id, codigo}`, `addArquivo(incidenteId, arquivo, db = pool) -> {id}`, `getIncidenteByCodigo(codigo, db = pool) -> row|null` (só se `expires_at > NOW()`), `listArquivosByIncidenteId(incidenteId, db = pool) -> rows` (sem `conteudo`), `getArquivo(incidenteId, arquivoId, db = pool) -> row|null` (com `conteudo`, só se incidente não expirado), `listIncidentes(filtros, db = pool) -> rows`, `cleanupExpirados({}, db = pool) -> {incidentesRemovidos}`.

Este repository é só SQL — nenhuma regra de negócio (isso fica no service da Task 3/4).

- [ ] **Step 1: Escrever o teste (usa um pool fake, no padrão dos outros testes do projeto — ex.: `tests/centralVendasM10ReadPerformance.test.js` injeta um `db` fake)**

```javascript
// server/tests/fechamentoIncidenteRepository.test.js
const assert = require("assert");
const repo = require("../repositories/fechamentoIncidenteRepository");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function fakeDb(rowsByQuery) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const key = Object.keys(rowsByQuery).find((k) => sql.includes(k));
      return rowsByQuery[key] ? rowsByQuery[key](params) : { rows: [], rowCount: 0 };
    },
  };
}

async function testCreateIncidenteGeraCodigoComId() {
  const db = fakeDb({
    "INSERT INTO fechamento_incidentes": () => ({ rows: [{ id: 184 }] }),
    "UPDATE fechamento_incidentes SET codigo": () => ({ rows: [{ id: 184, codigo: "FIN-184" }] }),
  });
  const result = await repo.createIncidente({
    marketplace: "shopee",
    triggerTipo: "identidade_ambigua",
    expiresInDays: 15,
  }, db);
  ok("codigo gerado a partir do id", result.codigo === "FIN-184");
  ok("id preservado", result.id === 184);
}

async function testGetIncidenteByCodigoFiltraExpirado() {
  const db = fakeDb({
    "SELECT * FROM fechamento_incidentes WHERE codigo": (params) => ({
      rows: params[0] === "FIN-184" ? [{ id: 1, codigo: "FIN-184", expires_at: new Date(Date.now() + 86400000) }] : [],
    }),
  });
  const row = await repo.getIncidenteByCodigo("FIN-184", db);
  ok("encontra incidente não expirado", row && row.codigo === "FIN-184");
}

(async () => {
  await testCreateIncidenteGeraCodigoComId();
  await testGetIncidenteByCodigoFiltraExpirado();
  console.log(`\n${checks} checks ok`);
})();
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node server/tests/fechamentoIncidenteRepository.test.js`
Expected: FAIL (`Cannot find module '../repositories/fechamentoIncidenteRepository'`)

- [ ] **Step 3: Implementar o repository**

```javascript
// server/repositories/fechamentoIncidenteRepository.js
// Acesso a dados da caixa-preta do fechamento financeiro. Só SQL — a decisão
// de QUANDO criar um incidente mora em fechamentoIncidentStorageService.

const pool = require("../config/database");

async function ensureFechamentoIncidenteTables(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS fechamento_incidentes (
      id SERIAL PRIMARY KEY,
      codigo TEXT,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      cliente_slug TEXT,
      cliente_conta_id INTEGER REFERENCES cliente_contas(id) ON DELETE SET NULL,
      marketplace TEXT NOT NULL,
      periodo TEXT,
      usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      trigger_tipo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto',
      resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      diagnostico_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fechamento_incidentes_codigo ON fechamento_incidentes (codigo) WHERE codigo IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_expires_at ON fechamento_incidentes (expires_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_cliente ON fechamento_incidentes (cliente_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_created_at ON fechamento_incidentes (created_at DESC);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS fechamento_incidente_arquivos (
      id SERIAL PRIMARY KEY,
      incidente_id INTEGER NOT NULL REFERENCES fechamento_incidentes(id) ON DELETE CASCADE,
      tipo_arquivo TEXT NOT NULL,
      nome_original TEXT NOT NULL,
      mime_type TEXT,
      tamanho_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      conteudo BYTEA,
      conteudo_truncado BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidente_arquivos_incidente ON fechamento_incidente_arquivos (incidente_id);`);
}

async function createIncidente(
  {
    clienteId = null,
    clienteSlug = null,
    clienteContaId = null,
    marketplace,
    periodo = null,
    usuarioId = null,
    triggerTipo,
    resumo = {},
    diagnostico = {},
    metadata = {},
    expiresInDays,
  },
  db = pool
) {
  const inserted = await db.query(
    `INSERT INTO fechamento_incidentes
      (cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo, usuario_id,
       trigger_tipo, resumo_json, diagnostico_json, metadata_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' days')::interval)
     RETURNING id`,
    [
      clienteId, clienteSlug, clienteContaId, marketplace, periodo, usuarioId,
      triggerTipo, JSON.stringify(resumo), JSON.stringify(diagnostico), JSON.stringify(metadata),
      String(expiresInDays),
    ]
  );
  const id = inserted.rows[0].id;
  const codigo = `FIN-${id}`;
  const updated = await db.query(
    `UPDATE fechamento_incidentes SET codigo = $1 WHERE id = $2 RETURNING id, codigo`,
    [codigo, id]
  );
  return updated.rows[0];
}

async function addArquivo(
  incidenteId,
  { tipoArquivo, nomeOriginal, mimeType, tamanhoBytes, sha256, conteudo, conteudoTruncado = false },
  db = pool
) {
  const result = await db.query(
    `INSERT INTO fechamento_incidente_arquivos
      (incidente_id, tipo_arquivo, nome_original, mime_type, tamanho_bytes, sha256, conteudo, conteudo_truncado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [incidenteId, tipoArquivo, nomeOriginal, mimeType, tamanhoBytes, sha256, conteudoTruncado ? null : conteudo, conteudoTruncado]
  );
  return result.rows[0];
}

async function getIncidenteByCodigo(codigo, db = pool) {
  const result = await db.query(
    `SELECT * FROM fechamento_incidentes WHERE codigo = $1 AND expires_at > NOW()`,
    [codigo]
  );
  return result.rows[0] || null;
}

async function listArquivosByIncidenteId(incidenteId, db = pool) {
  const result = await db.query(
    `SELECT id, incidente_id, tipo_arquivo, nome_original, mime_type, tamanho_bytes, sha256, conteudo_truncado, created_at
       FROM fechamento_incidente_arquivos WHERE incidente_id = $1 ORDER BY id ASC`,
    [incidenteId]
  );
  return result.rows;
}

async function getArquivo(incidenteId, arquivoId, db = pool) {
  const result = await db.query(
    `SELECT a.* FROM fechamento_incidente_arquivos a
       JOIN fechamento_incidentes i ON i.id = a.incidente_id
      WHERE a.incidente_id = $1 AND a.id = $2 AND i.expires_at > NOW()`,
    [incidenteId, arquivoId]
  );
  return result.rows[0] || null;
}

async function listIncidentes({ clienteSlug, marketplace, status, limit = 50, offset = 0 } = {}, db = pool) {
  const conditions = ["expires_at > NOW()"];
  const params = [];
  if (clienteSlug) { params.push(clienteSlug); conditions.push(`cliente_slug = $${params.length}`); }
  if (marketplace) { params.push(marketplace); conditions.push(`marketplace = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  params.push(Math.min(Number(limit) || 50, 200));
  params.push(Number(offset) || 0);
  const result = await db.query(
    `SELECT id, codigo, cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo,
            usuario_id, trigger_tipo, status, resumo_json, created_at, expires_at, resolved_at
       FROM fechamento_incidentes
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

async function cleanupExpirados(_opts = {}, db = pool) {
  const result = await db.query(`DELETE FROM fechamento_incidentes WHERE expires_at < NOW()`);
  return { incidentesRemovidos: result.rowCount || 0 };
}

module.exports = {
  ensureFechamentoIncidenteTables,
  createIncidente,
  addArquivo,
  getIncidenteByCodigo,
  listArquivosByIncidenteId,
  getArquivo,
  listIncidentes,
  cleanupExpirados,
};
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node server/tests/fechamentoIncidenteRepository.test.js`
Expected: `2 checks ok`

- [ ] **Step 5: Commit**

```bash
git add server/repositories/fechamentoIncidenteRepository.js server/tests/fechamentoIncidenteRepository.test.js
git commit -m "feat(fechamento-incidentes): repository de incidentes e arquivos"
```

---

## Task 3: Função pura — `detectarIncidenteFechamento`

**Files:**
- Create: `server/services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento.js`
- Test: `server/tests/detectarIncidenteFechamento.test.js`

**Interfaces:**
- Consumes: nada de outras tasks — função pura sobre o `result` real devolvido por `processFechamentoFinanceiro` (campos: `unmatchedIds`, `unmatchedCosts`, `unmatchedCancelled`, `summary.financialConfidence`, `summary.revenueWithoutCost`, `summary.calculatedCoveragePercent`, `summary.missingColumns`, `message`).
- Produces: `detectarIncidenteFechamento(result) -> null | { triggers: string[], triggerPrincipal: string, resumo: object }`. `triggers` usa os códigos: `"custo_nao_encontrado"`, `"identidade_ambigua"`, `"cobertura_incompleta"`, `"receita_sem_custo"`. Consumido pela Task 6 (controller).

- [ ] **Step 1: Escrever os testes**

```javascript
// server/tests/detectarIncidenteFechamento.test.js
const assert = require("assert");
const { detectarIncidenteFechamento } = require("../services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function baseResultOk() {
  return {
    summary: { financialConfidence: "confiavel", revenueWithoutCost: 0, calculatedCoveragePercent: 100 },
    unmatchedIds: [],
    unmatchedCosts: [],
    unmatchedCancelled: [],
  };
}

// 1. fechamento normal -> não cria incidente
ok("fechamento perfeito não gera incidente", detectarIncidenteFechamento(baseResultOk()) === null);

// 2. custo não identificado -> cria incidente
{
  const result = { ...baseResultOk(), unmatchedIds: ["MLB123", "MLB456"], summary: { ...baseResultOk().summary, financialConfidence: "parcial", revenueWithoutCost: 5414.42 } };
  const incidente = detectarIncidenteFechamento(result);
  ok("custo não encontrado gera incidente", incidente !== null);
  ok("trigger custo_nao_encontrado presente", incidente.triggers.includes("custo_nao_encontrado"));
  ok("resumo carrega revenueWithoutCost real", incidente.resumo.revenueWithoutCost === 5414.42);
}

// 3. identidade ambígua (Shopee, ordersAll) -> cria incidente
{
  const result = {
    ...baseResultOk(),
    unmatchedCosts: [{ type: "ambiguous_ids", value: "111, 222", sku: null, candidates: ["111", "222"], reason: "ambiguous_bridge_candidates" }],
  };
  const incidente = detectarIncidenteFechamento(result);
  ok("identidade ambígua gera incidente", incidente !== null);
  ok("trigger identidade_ambigua presente", incidente.triggers.includes("identidade_ambigua"));
}

// cobertura incompleta isolada também dispara
{
  const result = { ...baseResultOk(), summary: { ...baseResultOk().summary, financialConfidence: "insuficiente" } };
  const incidente = detectarIncidenteFechamento(result);
  ok("cobertura insuficiente gera incidente", incidente !== null);
  ok("trigger cobertura_incompleta presente", incidente.triggers.includes("cobertura_incompleta"));
}

// result nulo/indefinido não quebra
ok("result undefined não lança", detectarIncidenteFechamento(undefined) === null);

console.log(`\n${checks} checks ok`);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node server/tests/detectarIncidenteFechamento.test.js`
Expected: FAIL (`Cannot find module`)

- [ ] **Step 3: Implementar**

```javascript
// server/services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento.js
// Função PURA: decide se um resultado de fechamento (o mesmo objeto que
// processFechamentoFinanceiro devolve) representa uma anomalia que merece
// virar um incidente de suporte. Só lê campos REAIS já produzidos pelos
// motores (meliFinanceiroService, shopeePerformanceService,
// shopeeOrderAllService, tiktokFinanceiroService) — nunca inventa campo novo
// nem recalcula nada do motor financeiro.

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function detectarIncidenteFechamento(result) {
  if (!result || typeof result !== "object") return null;

  const summary = result.summary || {};
  const unmatchedIds = safeArray(result.unmatchedIds);
  const unmatchedCosts = safeArray(result.unmatchedCosts);
  const ambiguousItems = unmatchedCosts.filter((item) => item?.type === "ambiguous_ids");

  const triggers = [];

  if (ambiguousItems.length > 0) triggers.push("identidade_ambigua");
  if (unmatchedIds.length > 0 || unmatchedCosts.length > 0) triggers.push("custo_nao_encontrado");
  if (summary.financialConfidence && summary.financialConfidence !== "confiavel") triggers.push("cobertura_incompleta");
  if (safeNumber(summary.revenueWithoutCost) > 0) triggers.push("receita_sem_custo");

  if (triggers.length === 0) return null;

  // Ordem de prioridade para o trigger "principal" (o que melhor descreve o
  // problema para quem vai ler o código FIN-xxx pela primeira vez).
  const prioridade = ["identidade_ambigua", "custo_nao_encontrado", "receita_sem_custo", "cobertura_incompleta"];
  const triggerPrincipal = prioridade.find((t) => triggers.includes(t)) || triggers[0];

  return {
    triggers,
    triggerPrincipal,
    resumo: {
      unmatchedIdsCount: unmatchedIds.length,
      unmatchedCostsCount: unmatchedCosts.length,
      ambiguousCount: ambiguousItems.length,
      revenueWithoutCost: safeNumber(summary.revenueWithoutCost),
      financialConfidence: summary.financialConfidence || null,
      coveragePercent: summary.calculatedCoveragePercent ?? null,
      message: result.message || null,
    },
  };
}

module.exports = { detectarIncidenteFechamento };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node server/tests/detectarIncidenteFechamento.test.js`
Expected: todos os `ok` impressos, sem `AssertionError`

- [ ] **Step 5: Commit**

```bash
git add server/services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento.js server/tests/detectarIncidenteFechamento.test.js
git commit -m "feat(fechamento-incidentes): detectarIncidenteFechamento (função pura)"
```

---

## Task 4: `fechamentoIncidentStorageService` — abstração de storage + retenção

**Files:**
- Create: `server/services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService.js`
- Test: `server/tests/fechamentoIncidentStorageService.test.js`

**Interfaces:**
- Consumes: `fechamentoIncidenteRepository` (Task 2).
- Produces: `saveIncidente({ context, triggers, triggerPrincipal, resumo, diagnostico, files }) -> Promise<{codigo} | null>` (NUNCA rejeita — captura e loga qualquer erro, devolve `null`); `getIncidenteDetalhado(codigo) -> Promise<object|null>`; `getArquivoParaDownload(codigo, arquivoId) -> Promise<{buffer, nomeOriginal, mimeType}|null>`; `listarIncidentes(filtros) -> Promise<rows>`; `runCleanup() -> Promise<{incidentesRemovidos}|null>`; `startRetentionJob()/stopRetentionJob()` (mesmo padrão de `observabilityService.js`).
- `context` = `{ clienteId, clienteSlug, clienteContaId, marketplace, periodo, usuarioId }`. `files` = array de `{ tipoArquivo, originalName, mimeType, buffer }` (buffers EXATOS recebidos pelo multer — nunca reconstruídos).

- [ ] **Step 1: Escrever os testes**

```javascript
// server/tests/fechamentoIncidentStorageService.test.js
const assert = require("assert");
const crypto = require("crypto");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

// Substitui o repository real por um fake ANTES do require do service, para
// não depender de Postgres real nestes testes (mesmo espírito dos outros
// testes do projeto que injetam um `db`/repo fake).
const repoPath = require.resolve("../repositories/fechamentoIncidenteRepository");
const originalLoad = Module._load;
const fakeRepo = {
  createCalls: [],
  arquivoCalls: [],
  async ensureFechamentoIncidenteTables() {},
  async createIncidente(data) {
    fakeRepo.createCalls.push(data);
    return { id: 184, codigo: "FIN-184" };
  },
  async addArquivo(incidenteId, arquivo) {
    fakeRepo.arquivoCalls.push({ incidenteId, arquivo });
    return { id: fakeRepo.arquivoCalls.length };
  },
  async getIncidenteByCodigo(codigo) {
    return codigo === "FIN-184" ? { id: 184, codigo: "FIN-184", marketplace: "shopee" } : null;
  },
  async listArquivosByIncidenteId() { return []; },
  async getArquivo(incidenteId, arquivoId) {
    if (incidenteId === 184 && arquivoId === 1) {
      return { id: 1, nome_original: "sales.xlsx", mime_type: "application/octet-stream", conteudo: Buffer.from("abc"), conteudo_truncado: false };
    }
    return null;
  },
  async listIncidentes() { return []; },
  async cleanupExpirados() { return { incidentesRemovidos: 0 }; },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("fechamentoIncidenteRepository")) return fakeRepo;
  return originalLoad(request, parent, isMain);
};
const storage = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
Module._load = originalLoad;

async function testSaveIncidentePersisteBuffersESha256() {
  const buffer = Buffer.from("conteudo-da-planilha");
  const esperado = crypto.createHash("sha256").update(buffer).digest("hex");
  const resultado = await storage.saveIncidente({
    context: { clienteId: 1, clienteSlug: "wbs", clienteContaId: null, marketplace: "shopee", periodo: "2026-08", usuarioId: 7 },
    triggers: ["identidade_ambigua"],
    triggerPrincipal: "identidade_ambigua",
    resumo: { unmatchedIdsCount: 2 },
    diagnostico: {},
    files: [{ tipoArquivo: "sales", originalName: "sales.xlsx", mimeType: "application/octet-stream", buffer }],
  });
  ok("devolve código do incidente", resultado?.codigo === "FIN-184");
  ok("arquivo foi persistido com sha256 correto", fakeRepo.arquivoCalls[0].arquivo.sha256 === esperado);
  ok("tamanho em bytes bate com o buffer", fakeRepo.arquivoCalls[0].arquivo.tamanhoBytes === buffer.length);
}

async function testSaveIncidenteNuncaLanca() {
  fakeRepo.createIncidente = async () => { throw new Error("Postgres fora do ar"); };
  const resultado = await storage.saveIncidente({
    context: { marketplace: "meli" },
    triggers: ["custo_nao_encontrado"],
    triggerPrincipal: "custo_nao_encontrado",
    resumo: {},
    diagnostico: {},
    files: [],
  });
  ok("falha de storage devolve null em vez de lançar", resultado === null);
}

async function testDownloadValidaIncidenteEArquivoDoMesmoCodigo() {
  const arquivo = await storage.getArquivoParaDownload("FIN-184", 1);
  ok("download encontra arquivo do incidente certo", arquivo?.nomeOriginal === "sales.xlsx");
  const inexistente = await storage.getArquivoParaDownload("FIN-999", 1);
  ok("código inexistente não baixa nada", inexistente === null);
}

(async () => {
  await testSaveIncidentePersisteBuffersESha256();
  await testDownloadValidaIncidenteEArquivoDoMesmoCodigo();
  await testSaveIncidenteNuncaLanca();
  console.log(`\n${checks} checks ok`);
})();
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node server/tests/fechamentoIncidentStorageService.test.js`
Expected: FAIL (`Cannot find module '../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService'`)

- [ ] **Step 3: Implementar**

```javascript
// server/services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService.js
// Única porta de entrada para persistir/ler a caixa-preta do fechamento.
// Isola Postgres+BYTEA hoje; trocar por S3/R2/Supabase Storage no futuro é
// mudar só este arquivo (o controller e os testes não sabem onde o arquivo
// fisicamente mora).
//
// Regra de ouro: saveIncidente() NUNCA lança. Qualquer erro (Postgres fora
// do ar, arquivo grande demais, etc.) vira log e `null` — o fechamento
// financeiro não pode ser derrubado pela observabilidade do incidente.

"use strict";

const crypto = require("crypto");
const repo = require("../../../repositories/fechamentoIncidenteRepository");

function readInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseInt(process.env[name], 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function getConfig() {
  return {
    retentionDays: readInt("FECHAMENTO_INCIDENT_RETENTION_DAYS", 15, { min: 1, max: 365 }),
    maxFileMb: readInt("FECHAMENTO_INCIDENT_MAX_FILE_MB", 20, { min: 1, max: 100 }),
  };
}

// Remove separadores de caminho e caracteres de controle — o nome nunca é
// usado para abrir arquivo em disco, mas fica gravado em Content-Disposition
// no download, então precisa estar limpo mesmo assim.
function sanitizeFileName(name) {
  const base = String(name || "arquivo").replace(/[\\/]/g, "_").replace(/[ -]/g, "");
  return base.slice(0, 180) || "arquivo";
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function saveIncidente({ context = {}, triggers, triggerPrincipal, resumo = {}, diagnostico = {}, files = [] }) {
  try {
    const config = getConfig();
    const { id, codigo } = await repo.createIncidente({
      clienteId: context.clienteId ?? null,
      clienteSlug: context.clienteSlug ?? null,
      clienteContaId: context.clienteContaId ?? null,
      marketplace: context.marketplace,
      periodo: context.periodo ?? null,
      usuarioId: context.usuarioId ?? null,
      triggerTipo: triggerPrincipal,
      resumo: { ...resumo, triggers },
      diagnostico,
      metadata: context.metadata || {},
      expiresInDays: config.retentionDays,
    });

    const maxBytes = config.maxFileMb * 1024 * 1024;
    for (const file of files) {
      if (!file?.buffer || !Buffer.isBuffer(file.buffer)) continue;
      const truncado = file.buffer.length > maxBytes;
      await repo.addArquivo(id, {
        tipoArquivo: file.tipoArquivo,
        nomeOriginal: sanitizeFileName(file.originalName),
        mimeType: file.mimeType || "application/octet-stream",
        tamanhoBytes: file.buffer.length,
        sha256: sha256Buffer(file.buffer),
        conteudo: truncado ? null : file.buffer,
        conteudoTruncado: truncado,
      });
    }

    console.log(
      `[FinanceiroIncident] ${codigo} criado marketplace=${context.marketplace} ` +
      `clienteContaId=${context.clienteContaId ?? "-"} trigger=${triggerPrincipal}`
    );
    return { codigo };
  } catch (err) {
    console.error("[FinanceiroIncident] falha ao preservar incidente (fechamento segue normalmente):", err.message);
    return null;
  }
}

async function getIncidenteDetalhado(codigo) {
  const incidente = await repo.getIncidenteByCodigo(codigo);
  if (!incidente) return null;
  const arquivos = await repo.listArquivosByIncidenteId(incidente.id);
  return { ...incidente, arquivos };
}

async function getArquivoParaDownload(codigo, arquivoId) {
  const incidente = await repo.getIncidenteByCodigo(codigo);
  if (!incidente) return null;
  const arquivo = await repo.getArquivo(incidente.id, Number(arquivoId));
  if (!arquivo || arquivo.conteudo_truncado || !arquivo.conteudo) return null;
  return {
    buffer: arquivo.conteudo,
    nomeOriginal: arquivo.nome_original,
    mimeType: arquivo.mime_type || "application/octet-stream",
  };
}

async function listarIncidentes(filtros) {
  return repo.listIncidentes(filtros);
}

async function runCleanup() {
  try {
    return await repo.cleanupExpirados({});
  } catch (err) {
    console.error("[FinanceiroIncident] limpeza de retenção falhou:", err.message);
    return null;
  }
}

let retentionTimer = null;
function startRetentionJob({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  if (retentionTimer) return retentionTimer;
  retentionTimer = setInterval(() => { runCleanup().catch(() => {}); }, intervalMs);
  if (typeof retentionTimer.unref === "function") retentionTimer.unref();
  return retentionTimer;
}
function stopRetentionJob() {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}

module.exports = {
  saveIncidente,
  getIncidenteDetalhado,
  getArquivoParaDownload,
  listarIncidentes,
  runCleanup,
  startRetentionJob,
  stopRetentionJob,
  sanitizeFileName,
};
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node server/tests/fechamentoIncidentStorageService.test.js`
Expected: todos os `ok`, sem exceção

- [ ] **Step 5: Commit**

```bash
git add server/services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService.js server/tests/fechamentoIncidentStorageService.test.js
git commit -m "feat(fechamento-incidentes): fechamentoIncidentStorageService (Postgres BYTEA + TTL)"
```

---

## Task 5: Instrumentar o controller — captura automática (sucesso com warning + exceção)

**Files:**
- Modify: `server/controllers/fechamentosFinanceiroController.js`
- Test: `server/tests/fechamentoIncidenteControllerIntegracao.test.js`

**Interfaces:**
- Consumes: `detectarIncidenteFechamento` (Task 3), `fechamentoIncidentStorageService.saveIncidente` (Task 4), `createDebugCollector` de `utils/fechamento/debugCollector.js` (já existe).
- Produces: resposta JSON do controller passa a incluir `incidente: {codigo, mensagem}` quando um incidente é criado; nenhum campo existente do contrato (`fechamentoFinanceiroContrato.test.js`) muda de nome ou desaparece.

- [ ] **Step 1: Escrever o teste de integração**

```javascript
// server/tests/fechamentoIncidenteControllerIntegracao.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

// Fake do storage service: nunca toca em Postgres de verdade nestes testes.
const storagePath = require.resolve("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
const originalLoad = Module._load;
const chamadasSaveIncidente = [];
let falharProximoSave = false;
const fakeStorage = {
  async saveIncidente(args) {
    chamadasSaveIncidente.push(args);
    if (falharProximoSave) return null;
    return { codigo: "FIN-184" };
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("incidente/fechamentoIncidentStorageService")) return fakeStorage;
  return originalLoad(request, parent, isMain);
};
const { processarFechamentoFinanceiroController } = require("../controllers/fechamentosFinanceiroController");
Module._load = originalLoad;

function toBuffer(aoa) {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Planilha1");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

const SALES_MELI_SEM_CUSTO = toBuffer([
  ["", "", "", "", "", ""],
  ["N.º de venda", "Data da venda", "Unidades", "Receita por produtos (BRL)", "Anúncio", "Status"],
  ["1001", "01/08/2026", "1", "100", "AD-SEM-CUSTO", "Entregado"],
]);
const COSTS_MELI_VAZIO = toBuffer([["Anúncio", "Custo"], ["AD-OUTRO", "10"]]);

async function testFechamentoComCustoAusenteCriaIncidente() {
  chamadasSaveIncidente.length = 0;
  const req = {
    files: { sales: [{ buffer: SALES_MELI_SEM_CUSTO, originalname: "sales.xlsx", mimetype: "application/vnd.ms-excel" }], costs: [{ buffer: COSTS_MELI_VAZIO, originalname: "costs.xlsx" }] },
    body: { marketplace: "meli", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("resposta continua ok:true", res.body.ok === true);
  ok("saveIncidente foi chamado", chamadasSaveIncidente.length === 1);
  ok("código do incidente foi devolvido na resposta", res.body.incidente?.codigo === "FIN-184");
  ok("arquivos exatos (buffers) foram passados ao storage", chamadasSaveIncidente[0].files.some((f) => f.tipoArquivo === "sales" && f.buffer === SALES_MELI_SEM_CUSTO));
}

async function testFalhaAoSalvarIncidenteNaoQuebraResposta() {
  chamadasSaveIncidente.length = 0;
  falharProximoSave = true;
  const req = {
    files: { sales: [{ buffer: SALES_MELI_SEM_CUSTO, originalname: "sales.xlsx" }], costs: [{ buffer: COSTS_MELI_VAZIO, originalname: "costs.xlsx" }] },
    body: { marketplace: "meli", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("resposta ok:true mesmo com falha de storage", res.body.ok === true);
  ok("resposta não tem campo incidente quando storage falhou", res.body.incidente === undefined);
  falharProximoSave = false;
}

async function testExcecaoDeProcessamentoTentaCriarIncidenteEDevolveErroOriginal() {
  chamadasSaveIncidente.length = 0;
  const req = {
    files: { sales: [{ buffer: Buffer.from("nao e uma planilha valida"), originalname: "sales.xlsx" }] },
    body: { marketplace: "meli", ads: "0", venforce: "0", affiliates: "0" },
    user: { id: 7 },
  };
  const res = fakeRes();
  await processarFechamentoFinanceiroController(req, res);
  ok("erro original é preservado (não veio ok:true)", res.body.ok === false);
  ok("saveIncidente foi tentado mesmo com exceção", chamadasSaveIncidente.length === 1);
  ok("trigger de exceção registrado", chamadasSaveIncidente[0].triggerPrincipal === "excecao_processamento");
}

(async () => {
  await testFechamentoComCustoAusenteCriaIncidente();
  await testFalhaAoSalvarIncidenteNaoQuebraResposta();
  await testExcecaoDeProcessamentoTentaCriarIncidenteEDevolveErroOriginal();
  console.log(`\n${checks} checks ok`);
})();
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node server/tests/fechamentoIncidenteControllerIntegracao.test.js`
Expected: FAIL (controller ainda não chama `saveIncidente`, `res.body.incidente` é `undefined` no primeiro teste; falha de asserção, não de módulo)

- [ ] **Step 3: Modificar o controller**

Em `server/controllers/fechamentosFinanceiroController.js`:

1. Adicionar os requires no topo (junto aos outros):

```javascript
const { detectarIncidenteFechamento } = require("../services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento");
const fechamentoIncidentStorageService = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
const { createDebugCollector } = require("../utils/fechamento/debugCollector");
```

2. Logo no início de `processarFechamentoFinanceiroController`, capturar contexto e arquivos ANTES do try (para existirem também no catch), e criar o `debugCollector`:

```javascript
async function processarFechamentoFinanceiroController(req, res) {
  let meliHeaderDiagnostic = null;

  // Capturados fora do try: precisam estar disponíveis também no catch, para
  // a caixa-preta conseguir preservar o incidente mesmo quando o
  // processamento lança exceção.
  const salesFileEarly = req.files && req.files["sales"] && req.files["sales"][0];
  const costsFileEarly = req.files && req.files["costs"] && req.files["costs"][0];
  const ordersAllFileEarly = req.files?.ordersAll?.[0];
  const onholdFileEarly = req.files?.onhold?.[0];
  const marketplaceEarly = String(req.body?.marketplace || "").trim().toLowerCase();
  const incidentContext = {
    clienteSlug: req.body?.cliente_slug || req.body?.clienteSlug || null,
    clienteContaId: /^\d+$/.test(String(req.body?.clienteContaId || "")) ? Number(req.body.clienteContaId) : null,
    marketplace: marketplaceEarly,
    periodo: req.body?.periodo || null,
    usuarioId: req.user?.id ?? null,
  };
  const incidentFiles = [
    salesFileEarly && { tipoArquivo: "sales", originalName: salesFileEarly.originalname, mimeType: salesFileEarly.mimetype, buffer: salesFileEarly.buffer },
    costsFileEarly && { tipoArquivo: "costs", originalName: costsFileEarly.originalname, mimeType: costsFileEarly.mimetype, buffer: costsFileEarly.buffer },
    ordersAllFileEarly && { tipoArquivo: "ordersAll", originalName: ordersAllFileEarly.originalname, mimeType: ordersAllFileEarly.mimetype, buffer: ordersAllFileEarly.buffer },
    onholdFileEarly && { tipoArquivo: "onhold", originalName: onholdFileEarly.originalname, mimeType: onholdFileEarly.mimetype, buffer: onholdFileEarly.buffer },
  ].filter(Boolean);

  // debugCollector: mesma instrumentação opcional do Debug Financeiro
  // (utils/fechamento/debugCollector.js). Passá-lo sempre para MELI/Shopee
  // não muda nenhum valor calculado (todo ponto de instrumentação nesses
  // motores é `if (debugCollector) {...}`) — só habilita o snapshot para o
  // caso de precisarmos anexar a um incidente. TikTok ainda não é
  // instrumentado (mesma limitação do Debug Financeiro v1).
  const debugCollector = (marketplaceEarly === "meli" || marketplaceEarly === "shopee") ? createDebugCollector() : null;

  try {
    /* ...corpo existente sem mudanças até a chamada de processFechamentoFinanceiro... */
```

3. Passar `debugCollector` para `processFechamentoFinanceiro` (única linha alterada no meio do corpo existente):

```javascript
    const result = processFechamentoFinanceiro({
      marketplace,
      salesRowsRaw,
      costRowsRaw,
      ads,
      venforce,
      affiliates,
      fullCost,
      additionalCosts,
      ordersAllRowsRaw,
      salesBufferRaw: marketplace === "tiktok" ? salesBuffer : null,
      onholdBufferRaw:
        marketplace === "tiktok" && onholdFile?.buffer ? onholdFile.buffer : null,
      debugCollector,
    });
```

4. Depois que `result` existe e antes do `res.json(...)`, detectar e (best-effort) persistir o incidente:

```javascript
    // Caixa-preta do fechamento: 100% automática, nunca pode afetar a
    // resposta. Qualquer problema aqui vira log — saveIncidente() já
    // garante isso internamente, mas o try/catch aqui é uma segunda rede de
    // segurança contra erro de leitura de `result`/`competencia` etc.
    let incidenteResumo = null;
    try {
      const deteccao = detectarIncidenteFechamento(result);
      if (deteccao) {
        const salvo = await fechamentoIncidentStorageService.saveIncidente({
          context: {
            ...incidentContext,
            metadata: { costsSource, costsBaseId, competencia },
          },
          triggers: deteccao.triggers,
          triggerPrincipal: deteccao.triggerPrincipal,
          resumo: deteccao.resumo,
          diagnostico: { unmatchedIds: (result.unmatchedIds || []).slice(0, 1000), unmatchedCosts: (result.unmatchedCosts || []).slice(0, 1000), debug: debugCollector ? debugCollector.snapshot() : null },
          files: incidentFiles,
        });
        if (salvo) {
          incidenteResumo = {
            codigo: salvo.codigo,
            mensagem: `Ocorrência de suporte ${salvo.codigo} criada. Os arquivos utilizados foram preservados temporariamente para diagnóstico.`,
          };
        }
      }
    } catch (incidentErr) {
      console.error("[FinanceiroIncident] erro inesperado na captura automática (ignorado):", incidentErr.message);
    }
```

   Atenção: `competencia` só é computado mais abaixo hoje (linha ~427 no arquivo original, depois de montar o Excel). Mover a chamada de `compararCompetencias` para ANTES deste bloco (ela só depende de `salesRowsRaw` e `req.body?.periodo`, então pode subir sem mudar nenhum valor) — ou simplesmente montar `incidenteResumo` depois que `competencia` já existe, reaproveitando a variável. Escolha: mover o bloco de detecção de incidente para IMEDIATAMENTE ANTES do `res.json(...)` final (depois que `competencia` já foi calculado), não logo após `result`. Isso evita duplicar/mover a chamada de `compararCompetencias`.

5. Incluir `incidente` no payload de sucesso:

```javascript
    res.json({
      ok: true,
      summary: result.summary,
      competencia,
      detailedRows: result.detailedRows,
      excelBase64,
      unmatchedIds: result.unmatchedIds,
      unmatchedCosts: result.unmatchedCosts || [],
      unmatchedCancelled: result.unmatchedCancelled,
      ignoredRowsWithoutCost: result.ignoredRowsWithoutCost,
      ignoredRevenue: result.ignoredRevenue,
      message: result.message,
      emptySales: result.emptySales === true,
      costsSource,
      costsBase,
      ...(incidenteResumo ? { incidente: incidenteResumo } : {}),
      ...(marketplace === "tiktok" ? { pendingRows: result.pendingRows || [], onholdSummary: result.onholdSummary || null } : {}),
      ...(marketplace === "meli" ? { diagnostico: { /* inalterado */ } } : {}),
    });
```

6. No `catch (error)`, antes do `res.status(statusCode).json(payload)`, tentar criar o incidente com o que já foi capturado (`incidentContext`, `incidentFiles`) e um resumo derivado do erro — sem NUNCA alterar `statusCode`/`payload`:

```javascript
  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    const statusCode =
      Number.isFinite(Number(error?.statusCode)) && Number(error.statusCode) >= 400
        ? Number(error.statusCode)
        : 500;
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar os arquivos enviados."
    };
    if (error?.code) payload.code = error.code;
    if (Array.isArray(error?.contas)) payload.contas = error.contas;
    if (statusCode === 422 && meliHeaderDiagnostic) {
      payload.diagnostico = { /* inalterado */ };
    }

    // Mesma regra: best-effort, nunca pode mudar o que já foi decidido acima.
    try {
      if (incidentFiles.length > 0) {
        await fechamentoIncidentStorageService.saveIncidente({
          context: incidentContext,
          triggers: ["excecao_processamento"],
          triggerPrincipal: "excecao_processamento",
          resumo: { statusCode, mensagemErro: payload.error, codigoErro: payload.code || null },
          diagnostico: { stack: process.env.NODE_ENV === "production" ? null : String(error?.stack || "") },
          files: incidentFiles,
        });
      }
    } catch (incidentErr) {
      console.error("[FinanceiroIncident] erro inesperado na captura automática pelo catch (ignorado):", incidentErr.message);
    }

    res.status(statusCode).json(payload);
  }
```

- [ ] **Step 4: Rodar o teste de integração e ver passar**

Run: `node server/tests/fechamentoIncidenteControllerIntegracao.test.js`
Expected: todos os `ok`

- [ ] **Step 5: Rodar o teste de contrato existente para garantir zero regressão**

Run: `node server/tests/fechamentoFinanceiroContrato.test.js`
Expected: passa igual a antes (nenhum campo do `CONTRATO` foi removido/renomeado)

- [ ] **Step 6: Commit**

```bash
git add server/controllers/fechamentosFinanceiroController.js server/tests/fechamentoIncidenteControllerIntegracao.test.js
git commit -m "feat(fechamento-incidentes): captura automática de incidente no controller de fechamento"
```

---

## Task 6: API admin — listar, detalhar e baixar incidentes

**Files:**
- Create: `server/controllers/fechamentoIncidentesController.js`
- Create: `server/routes/fechamentoIncidentesRoutes.js`
- Modify: `server/index.js` (mount da rota)
- Test: `server/tests/fechamentoIncidentesController.test.js`

**Interfaces:**
- Consumes: `fechamentoIncidentStorageService` (Task 4).
- Produces: `GET /fechamentos/incidentes` (admin, lista), `GET /fechamentos/incidentes/:codigo` (admin, detalhe sem conteúdo binário), `GET /fechamentos/incidentes/:codigo/arquivos/:arquivoId` (admin, download binário).

- [ ] **Step 1: Escrever o teste do controller**

```javascript
// server/tests/fechamentoIncidentesController.test.js
const assert = require("assert");
const Module = require("module");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

const originalLoad = Module._load;
const fakeStorage = {
  async listarIncidentes() { return [{ id: 1, codigo: "FIN-184", marketplace: "shopee" }]; },
  async getIncidenteDetalhado(codigo) {
    return codigo === "FIN-184" ? { id: 1, codigo: "FIN-184", marketplace: "shopee", arquivos: [] } : null;
  },
  async getArquivoParaDownload(codigo, arquivoId) {
    return codigo === "FIN-184" && Number(arquivoId) === 1
      ? { buffer: Buffer.from("dados"), nomeOriginal: "sales.xlsx", mimeType: "application/octet-stream" }
      : null;
  },
};
Module._load = function (request, parent, isMain) {
  if (request.endsWith("incidente/fechamentoIncidentStorageService")) return fakeStorage;
  return originalLoad(request, parent, isMain);
};
const controller = require("../controllers/fechamentoIncidentesController");
Module._load = originalLoad;

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  res.set = (h) => { Object.assign(res.headers, h); return res; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

async function testListarIncidentes() {
  const res = fakeRes();
  await controller.listarIncidentesController({ query: {} }, res);
  ok("lista incidentes", Array.isArray(res.body.incidentes) && res.body.incidentes[0].codigo === "FIN-184");
}

async function testDetalharIncidenteExistente() {
  const res = fakeRes();
  await controller.detalharIncidenteController({ params: { codigo: "FIN-184" } }, res);
  ok("detalha incidente existente", res.body.incidente.codigo === "FIN-184");
}

async function testDetalharIncidenteInexistenteDevolve404() {
  const res = fakeRes();
  await controller.detalharIncidenteController({ params: { codigo: "FIN-999" } }, res);
  ok("incidente inexistente devolve 404", res.statusCode === 404);
}

async function testDownloadArquivoExistente() {
  const res = fakeRes();
  await controller.baixarArquivoIncidenteController({ params: { codigo: "FIN-184", arquivoId: "1" } }, res);
  ok("download devolve conteúdo", Buffer.isBuffer(res.body) && res.body.toString() === "dados");
  ok("Content-Disposition presente", String(res.headers["Content-Disposition"] || "").includes("sales.xlsx"));
}

async function testDownloadArquivoInexistenteOuExpiradoDevolve404() {
  const res = fakeRes();
  await controller.baixarArquivoIncidenteController({ params: { codigo: "FIN-184", arquivoId: "999" } }, res);
  ok("arquivo inexistente/expirado devolve 404", res.statusCode === 404);
}

(async () => {
  await testListarIncidentes();
  await testDetalharIncidenteExistente();
  await testDetalharIncidenteInexistenteDevolve404();
  await testDownloadArquivoExistente();
  await testDownloadArquivoInexistenteOuExpiradoDevolve404();
  console.log(`\n${checks} checks ok`);
})();
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node server/tests/fechamentoIncidentesController.test.js`
Expected: FAIL (`Cannot find module '../controllers/fechamentoIncidentesController'`)

- [ ] **Step 3: Implementar o controller**

```javascript
// server/controllers/fechamentoIncidentesController.js
// Área admin/TI da caixa-preta do fechamento. Autorização (requireAdmin) é
// feita na rota — este controller assume que quem chegou aqui já é admin.

const fechamentoIncidentStorageService = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");

async function listarIncidentesController(req, res) {
  try {
    const incidentes = await fechamentoIncidentStorageService.listarIncidentes({
      clienteSlug: req.query.clienteSlug || null,
      marketplace: req.query.marketplace || null,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({ ok: true, incidentes });
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao listar incidentes." });
  }
}

async function detalharIncidenteController(req, res) {
  try {
    const incidente = await fechamentoIncidentStorageService.getIncidenteDetalhado(req.params.codigo);
    if (!incidente) return res.status(404).json({ ok: false, erro: "Incidente não encontrado ou expirado." });
    return res.json({ ok: true, incidente });
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes/:codigo:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao buscar incidente." });
  }
}

async function baixarArquivoIncidenteController(req, res) {
  try {
    const arquivo = await fechamentoIncidentStorageService.getArquivoParaDownload(req.params.codigo, req.params.arquivoId);
    if (!arquivo) return res.status(404).json({ ok: false, erro: "Arquivo não encontrado, expirado ou indisponível." });
    res.set({
      "Content-Type": arquivo.mimeType,
      "Content-Disposition": `attachment; filename="${arquivo.nomeOriginal.replace(/"/g, "")}"`,
      "Content-Length": String(arquivo.buffer.length),
      "Cache-Control": "no-store",
    });
    return res.send(arquivo.buffer);
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes/:codigo/arquivos/:arquivoId:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao baixar arquivo do incidente." });
  }
}

module.exports = { listarIncidentesController, detalharIncidenteController, baixarArquivoIncidenteController };
```

- [ ] **Step 4: Implementar a rota**

```javascript
// server/routes/fechamentoIncidentesRoutes.js
// Área admin/TI da caixa-preta do fechamento — ADMIN ONLY, ponta a ponta.
// Mesmo prefixo /fechamentos das outras rotas de fechamento; arquivo
// separado para deixar claro que nada aqui é usado pelo fluxo de produção
// do fechamento em si (só por quem investiga um FIN-xxx).

const express = require("express");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const {
  listarIncidentesController,
  detalharIncidenteController,
  baixarArquivoIncidenteController,
} = require("../controllers/fechamentoIncidentesController");

const router = express.Router();

router.get("/incidentes", authMiddleware, requireAdmin, listarIncidentesController);
router.get("/incidentes/:codigo", authMiddleware, requireAdmin, detalharIncidenteController);
router.get("/incidentes/:codigo/arquivos/:arquivoId", authMiddleware, requireAdmin, baixarArquivoIncidenteController);

module.exports = router;
```

- [ ] **Step 5: Montar a rota e o boot da retenção em `server/index.js`**

Ao lado de (linha 65-66):
```javascript
const fechamentosFinanceiroRoutes = require("./routes/fechamentosFinanceiroRoutes");
const fechamentoDebugRoutes = require("./routes/fechamentoDebugRoutes");
```
adicionar:
```javascript
const fechamentoIncidentesRoutes = require("./routes/fechamentoIncidentesRoutes");
```

Ao lado de (linha 784-785):
```javascript
app.use("/fechamentos", fechamentosFinanceiroRoutes);
app.use("/fechamentos", fechamentoDebugRoutes);
```
adicionar:
```javascript
app.use("/fechamentos", fechamentoIncidentesRoutes);
```

E, junto ao bloco de boot da observabilidade (perto da linha 1960), no mesmo estilo — nunca pode derrubar o boot:
```javascript
  const { ensureFechamentoIncidenteTables } = require("./repositories/fechamentoIncidenteRepository");
  const fechamentoIncidentStorageService = require("./services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
  ensureFechamentoIncidenteTables()
    .then(() => fechamentoIncidentStorageService.runCleanup())
    .then(() => fechamentoIncidentStorageService.startRetentionJob())
    .catch((err) => {
      console.error("[fechamento-incidentes] erro ao preparar tabelas no boot:", err.message);
    });
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node server/tests/fechamentoIncidentesController.test.js`
Expected: todos os `ok`

- [ ] **Step 7: Commit**

```bash
git add server/controllers/fechamentoIncidentesController.js server/routes/fechamentoIncidentesRoutes.js server/index.js server/tests/fechamentoIncidentesController.test.js
git commit -m "feat(fechamento-incidentes): API admin para consultar e baixar incidentes"
```

---

## Task 7: Segurança — autorização e isolamento entre incidentes

**Files:**
- Test: `server/tests/fechamentoIncidentesSeguranca.test.js`

**Interfaces:**
- Consumes: `fechamentoIncidentesRoutes` montada (Task 6) — teste sobe as rotas com `express` + `supertest`-like chamada manual (o projeto não usa supertest; ver se há precedente — caso não haja, testar diretamente os middlewares `authMiddleware`/`requireAdmin` aplicados à rota via inspeção do router, e testar isolamento via `fechamentoIncidenteRepository.getArquivo` diretamente).

- [ ] **Step 1: Escrever e rodar o teste de isolamento (arquivo de um incidente não vaza pelo código de outro)**

```javascript
// server/tests/fechamentoIncidentesSeguranca.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const repo = require("../repositories/fechamentoIncidenteRepository");
const { requireAdmin } = require("../middlewares/authMiddleware");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function fakeDb(rows) {
  return {
    async query(sql) {
      if (sql.includes("SELECT a.* FROM fechamento_incidente_arquivos")) return { rows };
      return { rows: [] };
    },
  };
}

async function testArquivoDeOutroIncidenteNaoAparece() {
  // getArquivo faz JOIN incidente_id = $1 AND a.id = $2 — um arquivoId que
  // pertence a OUTRO incidente não deve ser devolvido mesmo que exista na
  // tabela (o fakeDb aqui simula "banco vazio para essa combinação").
  const db = fakeDb([]);
  const arquivo = await repo.getArquivo(184, 999, db);
  ok("arquivo de incidente errado não é encontrado", arquivo === null);
}

function testRequireAdminBloqueiaNaoAdmin() {
  let status = null, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  let nextCalled = false;
  requireAdmin({ user: { role: "user" } }, res, () => { nextCalled = true; });
  ok("não-admin é bloqueado (403)", status === 403 && nextCalled === false);
}

function testRequireAdminLiberaAdmin() {
  let nextCalled = false;
  requireAdmin({ user: { role: "admin" } }, {}, () => { nextCalled = true; });
  ok("admin passa", nextCalled === true);
}

(async () => {
  await testArquivoDeOutroIncidenteNaoAparece();
  testRequireAdminBloqueiaNaoAdmin();
  testRequireAdminLiberaAdmin();
  console.log(`\n${checks} checks ok`);
})();
```

- [ ] **Step 2: Rodar**

Run: `node server/tests/fechamentoIncidentesSeguranca.test.js`
Expected: todos os `ok` (nenhuma implementação nova necessária — este teste valida comportamento já implementado nas Tasks 2 e 6; se falhar, é regressão real a corrigir antes de prosseguir)

- [ ] **Step 3: Commit**

```bash
git add server/tests/fechamentoIncidentesSeguranca.test.js
git commit -m "test(fechamento-incidentes): isolamento entre incidentes e bloqueio de acesso não-admin"
```

---

## Task 8: Registrar os novos testes no runner do projeto

**Files:**
- Modify: `server/tests/run-all.js`

- [ ] **Step 1: Ler `server/tests/run-all.js` e adicionar os 6 arquivos novos na lista (mesmo padrão dos arquivos existentes — glob automático ou lista manual, conforme o que o arquivo já fizer)**

- [ ] **Step 2: Rodar a suíte inteira**

Run: `cd server && npm test`
Expected: todos os testes existentes + os 6 novos passam; nenhuma regressão nos testes de Financeiro (`fechamentoFinanceiroContrato.test.js`, `fechamentoFinanceiroClientes.test.js`, `fechamentoFinanceiroTikTok.test.js`, `financeiroV3ContaObrigatoria.test.js`, `fechamentoClientesCarteira.test.js`) nem em `observabilityControlCenter.test.js`/`observability.test.js` (a captura de incidente não deve interferir com a observabilidade existente).

- [ ] **Step 3: Commit**

```bash
git add server/tests/run-all.js
git commit -m "test(fechamento-incidentes): registra os testes da caixa-preta no runner"
```

---

## Task 9: Frontend legado — banner discreto em `Portal/financeiro.js`

**Files:**
- Modify: `Portal/financeiro.js` (perto de `2124-2171`, onde já existe o padrão `vf-banner is-warning/is-danger/is-info`)

**Interfaces:**
- Consumes: `response.incidente` (`{codigo, mensagem}`, opcional) do payload de `POST /fechamentos/financeiro`, já produzido pela Task 5. `user.role === "admin"` lido do mesmo lugar que `Portal/financeiro-debug.js:90-104` já lê (`localStorage["vf-user"]`).

- [ ] **Step 1: Ler o trecho atual de renderização de banners (linhas 2124-2171) para replicar exatamente as classes/estrutura HTML existentes**

- [ ] **Step 2: Adicionar, logo após a renderização do resultado do fechamento, um bloco condicional**

```javascript
if (resultado.incidente) {
  const admin = (() => {
    try { return JSON.parse(localStorage.getItem("vf-user") || "{}")?.role === "admin"; }
    catch { return false; }
  })();
  const codigo = resultado.incidente.codigo;
  const banner = document.createElement("div");
  banner.className = "vf-banner is-info";
  banner.innerHTML = `
    <div class="vf-banner__title">Ocorrência de suporte ${codigo} criada</div>
    <div class="vf-banner__description">Os arquivos utilizados foram preservados temporariamente para diagnóstico.</div>
    <div class="vf-banner__actions">
      <button type="button" class="vf-btn vf-btn--secondary" data-copiar-incidente="${codigo}">Copiar código</button>
      ${admin ? `<a class="vf-btn vf-btn--link" href="/financeiro-debug.html?incidente=${encodeURIComponent(codigo)}">Abrir diagnóstico</a>` : ""}
    </div>
  `;
  banner.querySelector("[data-copiar-incidente]").addEventListener("click", () => {
    navigator.clipboard?.writeText(codigo);
  });
  containerDeResultado.appendChild(banner); // usar o mesmo container dos outros vf-banner desta tela
}
```

(Ajustar `containerDeResultado` para o elemento real usado pelos outros banners nesse arquivo — confirmar nome exato ao editar, não inventar um novo container.)

- [ ] **Step 3: Testar manualmente no browser** (ver Task 12 — teste manual de ponta a ponta)

- [ ] **Step 4: Commit**

```bash
git add Portal/financeiro.js
git commit -m "feat(fechamento-incidentes): banner discreto de incidente no Financeiro legado"
```

---

## Task 10: Frontend V3 — banner em `NovoFechamento.jsx`

**Files:**
- Modify: `frontend-react/src/components/financeiro/NovoFechamento.jsx` (perto de `157-243`, onde já existe `vf-banner is-warning/is-danger/is-info`)

- [ ] **Step 1: Ler o trecho de banners existente (157-243) para reaproveitar a mesma estrutura JSX/classes**

- [ ] **Step 2: Adicionar renderização condicional a partir de `resultado.incidente` (mesmo campo que a Task 5 adiciona na resposta, já lido pelo hook `useFechamentoNativo`/`financeiroFechamentoApi.js`)**

```jsx
{resultado?.incidente && (
  <div className="vf-banner is-info">
    <div className="vf-banner__title">Ocorrência de suporte {resultado.incidente.codigo} criada</div>
    <div className="vf-banner__description">
      Os arquivos utilizados foram preservados temporariamente para diagnóstico.
    </div>
    <div className="vf-banner__actions">
      <button
        type="button"
        className="vf-btn vf-btn--secondary"
        onClick={() => navigator.clipboard?.writeText(resultado.incidente.codigo)}
      >
        Copiar código
      </button>
      {isAdmin && (
        <a className="vf-btn vf-btn--link" href={`/financeiro-debug.html?incidente=${encodeURIComponent(resultado.incidente.codigo)}`}>
          Abrir diagnóstico
        </a>
      )}
    </div>
  </div>
)}
```

(`isAdmin` deve vir do mesmo lugar que o resto do V3 já resolve o papel do usuário — verificar no arquivo o padrão exato usado, ex. contexto de auth/`useAuth()`, e reaproveitar; não inventar um novo hook.)

- [ ] **Step 3: Testar manualmente no browser** (Task 12)

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/financeiro/NovoFechamento.jsx
git commit -m "feat(fechamento-incidentes): banner discreto de incidente no Financeiro V3"
```

---

## Task 11: Admin — aba "Incidentes de suporte" no Debug Financeiro

**Files:**
- Modify: `Portal/financeiro-debug.html`, `Portal/financeiro-debug.js` (já admin-only via `role === "admin"` em `financeiro-debug.js:90-104`)

- [ ] **Step 1: Ler a estrutura atual de `financeiro-debug.html`/`financeiro-debug.js` (abas/seções e como fazem fetch autenticado) para reaproveitar o padrão**

- [ ] **Step 2: Adicionar uma aba "Incidentes de suporte" que:**
  - Lê `?incidente=FIN-xxx` da URL e, se presente, já abre o detalhe desse código (rota vinda do banner das Tasks 9/10).
  - Tem um campo de busca por código que chama `GET /fechamentos/incidentes/:codigo`.
  - Lista os incidentes recentes via `GET /fechamentos/incidentes`.
  - Mostra: cliente/conta/marketplace/período/usuário/data/trigger/resumo/diagnóstico/lista de arquivos com hash e tamanho, e um link de download por arquivo (`GET /fechamentos/incidentes/:codigo/arquivos/:arquivoId`, autenticado com o mesmo token Bearer que o resto do Debug Financeiro já usa).
  - Mostra `expires_at` formatada.

- [ ] **Step 3: Testar manualmente no browser** (Task 12)

- [ ] **Step 4: Commit**

```bash
git add Portal/financeiro-debug.html Portal/financeiro-debug.js
git commit -m "feat(fechamento-incidentes): aba de incidentes de suporte no Debug Financeiro"
```

---

## Task 12: Documentação e validação final

**Files:**
- Create: `docs/financeiro/CAIXA_PRETA_FECHAMENTO.md`

- [ ] **Step 1: Escrever o documento** cobrindo: arquitetura (diagrama textual do fluxo request → detecção → storage → resposta), critérios reais de incidente (`detectarIncidenteFechamento`), as duas tabelas, os 3 endpoints admin, `FECHAMENTO_INCIDENT_RETENTION_DAYS`/`FECHAMENTO_INCIDENT_MAX_FILE_MB`, segurança (admin only, sem URL pública, sanitização de nome, sem log de conteúdo), passo a passo de teste manual (repetir um fechamento Shopee que hoje gera "produtos sem custo"/"IDs conflitantes", conferir banner com `FIN-xxx`, abrir no Debug Financeiro como admin, baixar os arquivos e conferir os hashes), e limitações conhecidas (TikTok sem `debugCollector`; `unmatchedCosts`/`ambiguous_ids` só existe quando Shopee processa `ordersAll`; parse de `ordersAll` que falha silenciosamente hoje continua sem virar incidente — fora de escopo desta missão, que era só capturar anomalias já expostas pelo motor).

- [ ] **Step 2: Rodar a suíte completa uma última vez**

Run: `cd server && npm test`
Expected: 100% dos testes passam, incluindo todos os testes de Financeiro pré-existentes.

- [ ] **Step 3: Reportar ao usuário**: migrations pendentes de aplicação manual em produção, novas ENV vars (com defaults), arquivos criados/modificados, e o roteiro de teste manual pedido na missão (gestor repete um fechamento Shopee problemático → aparece `FIN-xxx` → admin abre e encontra as planilhas exatas).

- [ ] **Step 4: Commit**

```bash
git add docs/financeiro/CAIXA_PRETA_FECHAMENTO.md
git commit -m "docs(fechamento-incidentes): documentação da caixa-preta do fechamento financeiro"
```

---

## Self-Review Notes (já aplicadas ao escrever o plano acima)

- Cobertura da spec: detecção automática (Task 3+5), captura em exceção (Task 5), storage isolado/trocável (Task 4), TTL+limite de tamanho (Task 4, envs), migration idempotente (Task 1), API admin (Task 6), segurança/isolamento (Task 7), reaproveitamento do `debugCollector` existente (Task 5), frontend mínimo nos dois fluxos (Tasks 9-10), integração no Debug Financeiro em vez de tela nova (Task 11), testes obrigatórios 1-10 da missão mapeados nas Tasks 3, 5, 2/4, 6, 7 e 8, documentação final (Task 12).
- Nenhum campo inventado: todos os nomes (`unmatchedIds`, `unmatchedCosts`, `type: "ambiguous_ids"`, `financialConfidence`, `revenueWithoutCost`, `requireAdmin`, `debugCollector`) vêm de leitura direta do código em `server/controllers/fechamentosFinanceiroController.js`, `server/services/fechamentoFinanceiro/*`, `server/utils/fechamento/debugCollector.js`, `server/middlewares/authMiddleware.js`.
- Consistência de tipos entre tasks: `detectarIncidenteFechamento` (Task 3) devolve exatamente o shape que `fechamentoIncidentStorageService.saveIncidente` (Task 4) e o controller (Task 5) esperam (`triggers`, `triggerPrincipal`, `resumo`).
