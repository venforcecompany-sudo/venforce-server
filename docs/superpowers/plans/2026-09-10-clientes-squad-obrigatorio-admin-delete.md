# Contrato Cliente↔Squad + Exclusão Admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar o contrato "todo Cliente pertence a um Squad" no backend (removendo o caminho legado de `POST /clientes`), expor o Squad de cada Cliente em `GET /clientes` sem N+1, mostrar essa informação na tabela de `/clientes.html`, e garantir que a exclusão administrativa de Cliente tenha uma UX clara (incluindo o Squad no modal de confirmação).

**Architecture:** O backend já tem toda a lógica pesada pronta e testada: `squadService.criarClienteComSquad` (criação atômica Cliente+vínculo) e `clienteDependenciasService.verificarDependenciasCliente` (bloqueio de hard delete com dependências) já existem e já são usados por `server/index.js`. O que falta é (1) remover o fallback sem squad de `POST /clientes`, (2) fazer `GET /clientes` enriquecer cada linha com `squad: {id,nome,slug}|null` usando `squadsRepository.squadsAtivosDeClientes` (já existe, já batched), e (3) consumir esse campo no frontend (`Portal/clientes.js` + `clientes.html` + `clientes-v2.css`). Nenhuma migração nova, nenhum schema novo.

**Tech Stack:** Node.js/Express (server/index.js, rotas inline), PostgreSQL (pg Pool), frontend vanilla JS (Portal/clientes.js), testes sem framework (node puro, padrão `assert` + leitura de fonte, executados via `node tests/arquivo.test.js`).

**Spec:** Mission brief do usuário nesta conversa (colado integralmente na issue/tarefa — não há arquivo de spec separado). Pontos centrais: squadId obrigatório em `POST /clientes`; `GET /clientes` retorna squad sem N+1; tabela mostra coluna Squad compacta; "Sem Squad" honesto; exclusão admin preservada com dependências humanizadas; não tocar `squadsEnforcement.js`/`rolloutGateBoot.js`/grants/bases/ClienteContas/banco de produção.

## Global Constraints

- squadId ausente/null/vazio/inválido em `POST /clientes` → 400 com `code: "SQUAD_OBRIGATORIO"` (ausente/vazio) ou `code: "SQUAD_ID_INVALIDO"` (valor não numérico/≤0) — nunca cria Cliente.
- A criação Cliente+vínculo de Squad continua UMA transação (`squadService.criarClienteComSquad`, já existente — não reescrever).
- `DELETE /clientes/:slug` continua `requireAdmin` + bloqueio por dependências (`clienteDependenciasService`, já existente — não reescrever a lógica, só a UX do modal).
- Não alterar `squadsEnforcement.js`, `rolloutGateBoot.js`, `SQUADS_ENFORCEMENT`, `SQUADS_ENFORCEMENT_ALLOW_INCOMPLETE`.
- Não alterar Grants ML, Bases, ClienteConta, nem rodar migration contra o banco (o `.env` local aponta para produção — nunca iniciar o servidor local nem rodar SQL manual).
- Branch `fix/clientes-squad-required-admin-delete`, a partir de `origin/main` atualizado. Commits só dos arquivos desta missão. Push sem merge, sem deploy.

---

### Task 1: Backend — `POST /clientes` exige squadId, remove caminho legado

**Files:**
- Modify: `server/index.js:1458-1518` (handler `app.post("/clientes", ...)`)
- Modify: `server/tests/clienteCriarComSquadRota.test.js` (o teste atual trava o caminho legado como obrigatório — precisa refletir o novo contrato)

**Interfaces:**
- Consumes: `squadService.criarClienteComSquad({nome, slug, apiKey, squadId}, actorId)` — já existe, lança erros com `.statusCode` e `.code` (`SQUAD_ID_INVALIDO`, `SQUAD_NAO_ENCONTRADO`, `SQUAD_INATIVO`, `CLIENTE_SLUG_DUPLICADO`). Assinatura e contrato não mudam.
- Produces: `POST /clientes` agora SEMPRE responde 201 com `{ok:true, cliente, squad}` no sucesso, ou 400/404/409 com `{ok:false, erro, code}` — nunca mais cria Cliente sem Squad.

- [ ] **Step 1: Atualizar o teste de wiring para o novo contrato (sem caminho legado)**

Substituir o conteúdo de `server/tests/clienteCriarComSquadRota.test.js` por:

```javascript
// server/tests/clienteCriarComSquadRota.test.js
//
// Audita a rota POST /clientes (server/index.js): confirma que squadId é
// OBRIGATÓRIO (mission "fechar o contrato Cliente↔Squad" — set/2026), que
// o caminho sem squadId foi removido (nenhum consumidor legítimo dependia
// dele — só Portal/clientes.js, que já envia squadId desde set/2026), e que
// a rota continua exigindo requireAdmin (não amplia permissões).
//
// Teste de wiring por leitura de fonte — igual clienteContasGuards.test.js —
// não sobe servidor real nem banco.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

// Isola o handler de POST /clientes até a próxima rota app.<verbo>(
const inicio = src.indexOf('app.post("/clientes",');
assert.ok(inicio >= 0, "rota POST /clientes não encontrada em server/index.js");
const proximaRota = src.indexOf("\napp.", inicio + 10);
const trecho = src.slice(inicio, proximaRota > 0 ? proximaRota : inicio + 4000);

ok("POST /clientes continua exigindo authMiddleware", trecho.includes("authMiddleware"));
ok("POST /clientes continua exigindo requireAdmin (não amplia permissões)", trecho.includes("requireAdmin"));
ok("rota lê squadId do corpo", /const\s*\{[^}]*squadId[^}]*\}\s*=\s*req\.body/.test(trecho));
ok("squadId ausente/vazio -> 400 SQUAD_OBRIGATORIO", trecho.includes("SQUAD_OBRIGATORIO"));
ok("caminho com squadId delega para squadService.criarClienteComSquad", trecho.includes("squadService.criarClienteComSquad"));
ok(
  "caminho legado (INSERT INTO clientes direto, sem squad) foi REMOVIDO da rota",
  !trecho.includes("INSERT INTO clientes")
);

ok("squadService está importado no topo do arquivo", src.includes('require("./services/squads/squadService")'));

console.log(`\nclienteCriarComSquadRota.test.js: ${checks} verificações passaram.`);
```

- [ ] **Step 2: Rodar o teste e confirmar que falha no jeito certo**

Run: `cd server && node tests/clienteCriarComSquadRota.test.js`
Expected: FALHOU em "squadId ausente/vazio -> 400 SQUAD_OBRIGATORIO" e em "caminho legado ... foi REMOVIDO" (a rota atual ainda não tem esse code nem removeu o INSERT legado).

- [ ] **Step 3: Reescrever o handler `POST /clientes` em `server/index.js`**

Substituir o bloco inteiro (de `app.post("/clientes", authMiddleware, requireAdmin, async (req, res) => {` até o `});` que o encerra, linhas 1458-1518 na leitura atual) por:

```javascript
app.post("/clientes", authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { nome, slug, squadId } = req.body;
    if (!nome || !slug) {
      return res.status(400).json({ ok: false, erro: "Nome e slug são obrigatórios." });
    }

    // squadId é obrigatório (mission "fechar o contrato Cliente↔Squad",
    // set/2026): um incidente real mostrou 2 clientes ativos sem Squad
    // porque o backend ainda tolerava criação sem squadId. O único
    // consumidor de POST /clientes é Portal/clientes.js, que já envia
    // squadId desde a obrigatoriedade no formulário (commit
    // e2e2f20, set/2026) — não há caminho legado a preservar.
    if (squadId === undefined || squadId === null || squadId === "") {
      return res.status(400).json({
        ok: false,
        code: "SQUAD_OBRIGATORIO",
        erro: "Todo cliente deve pertencer a um Squad.",
      });
    }
    const sid = Number(squadId);
    if (!Number.isInteger(sid) || sid <= 0) {
      return res.status(400).json({ ok: false, code: "SQUAD_ID_INVALIDO", erro: "Squad inválido." });
    }

    const slugNorm = normalizarSlug(slug);
    const apiKey = gerarApiKey();
    const nomeTrim = nome.trim();

    // Cria Cliente + vínculo de Squad como UMA transação
    // (squadService.criarClienteComSquad) — nunca duas escritas
    // independentes que possam deixar o Cliente órfão se a segunda falhar.
    try {
      const resultado = await squadService.criarClienteComSquad(
        { nome: nomeTrim, slug: slugNorm, apiKey, squadId: sid },
        req.user.id
      );
      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "admin.cliente.criar",
        detalhes: { cliente_slug: slugNorm, cliente_nome: nomeTrim, squad_id: sid },
        ip: extrairIp(req),
        status: "sucesso"
      });
      return res.status(201).json({ ok: true, cliente: resultado.cliente, squad: resultado.squad });
    } catch (err) {
      const status = Number.isFinite(Number(err?.statusCode)) ? Number(err.statusCode) : 500;
      if (status >= 500) console.error("[clientes] criar com squad:", err.message);
      return res.status(status).json({ ok: false, erro: err.message, code: err.code });
    }
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});
```

Nota: o `try/catch` externo existia para capturar `e.code === "23505"` do INSERT legado; como o INSERT some, esse catch fica genérico (500) — `CLIENTE_SLUG_DUPLICADO` já é tratado dentro de `squadService.criarClienteComSquad` (409) e repassado pelo catch interno.

- [ ] **Step 4: Rodar o teste de novo e confirmar que passa**

Run: `cd server && node tests/clienteCriarComSquadRota.test.js`
Expected: PASS em todas as 6 verificações.

- [ ] **Step 5: Rodar os testes de squadService que já cobrem a criação atômica (não devem quebrar)**

Run: `cd server && node tests/clienteCriarComSquad.test.js && node tests/clienteCriarComSquadAutorizacao.test.js`
Expected: PASS (esses testes exercitam `squadService.criarClienteComSquad` direto, sem depender do handler da rota — não deveriam ser afetados, mas confirma que nada vizinho quebrou).

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/tests/clienteCriarComSquadRota.test.js
git commit -m "feat(clientes): squadId obrigatorio em POST /clientes, remove caminho legado sem squad"
```

---

### Task 2: Backend — `GET /clientes` retorna o Squad de cada Cliente sem N+1

**Files:**
- Modify: `server/index.js:1224-1246` (handler `app.get("/clientes", ...)`)
- Create: `server/tests/clientesListaComSquad.test.js`

**Interfaces:**
- Consumes: `squadsRepository.squadsAtivosDeClientes(clienteIds)` — já existe, já exportado, já testado em `meService.js`. Retorna `[{cliente_id, squad_id, squad_nome, squad_slug, squad_ativo}]` (só clientes com squad ATIVO aberto em `cliente_squad_history`; cliente sem squad simplesmente não aparece no array).
- Produces: `GET /clientes` agora responde `{ok:true, clientes:[{id, nome, slug, ativo, created_at, squad: {id, nome, slug} | null}]}`. Shape consumido por `Portal/clientes.js` na Task 3.

- [ ] **Step 1: Escrever o teste de wiring (falha primeiro)**

Criar `server/tests/clientesListaComSquad.test.js`:

```javascript
// server/tests/clientesListaComSquad.test.js
//
// GET /clientes (server/index.js) precisa devolver o Squad ativo de cada
// Cliente sem N+1 (mission "fechar o contrato Cliente↔Squad", set/2026):
// usa squadsRepository.squadsAtivosDeClientes (já existe, já batched —
// mesma função usada por meService.obterContexto) UMA vez para toda a
// lista, nunca um SELECT por cliente dentro de um loop/map com await.
//
// Teste de wiring por leitura de fonte — não sobe servidor real nem banco.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

const inicio = src.indexOf('app.get("/clientes",');
assert.ok(inicio >= 0, "rota GET /clientes não encontrada em server/index.js");
const proximaRota = src.indexOf("\napp.", inicio + 10);
const trecho = src.slice(inicio, proximaRota > 0 ? proximaRota : inicio + 3000);

ok("GET /clientes usa squadsAtivosDeClientes (batch, sem N+1)", trecho.includes("squadsAtivosDeClientes"));
ok(
  "não existe await dentro de um .map/.forEach nesse trecho (sinal de N+1 por cliente)",
  !/\.(map|forEach)\([^)]*=>\s*\{[^}]*await/.test(trecho)
);
ok("resposta inclui campo squad por cliente", /squad\s*:/.test(trecho));

ok(
  "squadsAtivosDeClientes está importado no topo do arquivo (squadsRepository)",
  /squadsAtivosDeClientes/.test(src.slice(0, inicio))
);

console.log(`\nclientesListaComSquad.test.js: ${checks} verificações passaram.`);
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd server && node tests/clientesListaComSquad.test.js`
Expected: FALHOU em todas (a rota ainda não usa `squadsAtivosDeClientes`).

- [ ] **Step 3: Importar `squadsAtivosDeClientes` no topo de `server/index.js`**

Editar a linha de import existente (linha 112):

```javascript
const { ensureSquadsTables, squadsAtivosDeClientes } = require("./services/squads/squadsRepository");
```

- [ ] **Step 4: Reescrever o handler `GET /clientes`**

Substituir:

```javascript
app.get("/clientes", authMiddleware, async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();

    if (role === "shopee_reviewer") {
      const result = await pool.query(
        "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = 'demo-shopee' AND ativo = true"
      );
      return res.json({ ok: true, clientes: result.rows });
    }

    if (role !== "admin") {
      return res.status(403).json({ ok: false, erro: "Acesso restrito a administradores." });
    }

    const result = await pool.query(
      "SELECT id, nome, slug, ativo, created_at FROM clientes ORDER BY created_at DESC"
    );
    res.json({ ok: true, clientes: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});
```

por:

```javascript
app.get("/clientes", authMiddleware, async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();

    if (role === "shopee_reviewer") {
      const result = await pool.query(
        "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = 'demo-shopee' AND ativo = true"
      );
      return res.json({ ok: true, clientes: result.rows });
    }

    if (role !== "admin") {
      return res.status(403).json({ ok: false, erro: "Acesso restrito a administradores." });
    }

    const result = await pool.query(
      "SELECT id, nome, slug, ativo, created_at FROM clientes ORDER BY created_at DESC"
    );
    const clientes = result.rows;

    // Squad ativo de cada cliente, numa única query batched (mission
    // "fechar o contrato Cliente↔Squad", set/2026) — cliente histórico sem
    // squad fica com squad: null (honesto, nunca inventado).
    const squadsPorCliente = await squadsAtivosDeClientes(clientes.map((c) => c.id));
    const squadDoCliente = new Map(squadsPorCliente.map((s) => [s.cliente_id, s]));
    const clientesComSquad = clientes.map((c) => {
      const s = squadDoCliente.get(c.id) || null;
      return {
        ...c,
        squad: s ? { id: s.squad_id, nome: s.squad_nome, slug: s.squad_slug } : null,
      };
    });

    res.json({ ok: true, clientes: clientesComSquad });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});
```

- [ ] **Step 5: Rodar o teste de wiring de novo**

Run: `cd server && node tests/clientesListaComSquad.test.js`
Expected: PASS em todas as 4 verificações.

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/tests/clientesListaComSquad.test.js
git commit -m "feat(clientes): GET /clientes retorna squad ativo de cada cliente sem N+1"
```

---

### Task 3: Frontend — coluna Squad na tabela de `/clientes.html`

**Files:**
- Modify: `Portal/clientes.html` (thead da tabela)
- Modify: `Portal/clientes.js` (`renderClientes`)
- Modify: `Portal/css/pages/clientes-v2.css` (célula compacta da coluna Squad)
- Create: `Portal/clientes-squad-coluna-ui.test.js`

**Interfaces:**
- Consumes: `c.squad` de cada item de `data.clientes` (Task 2) — `{id, nome, slug} | null`. Consumes `isLegado(squad)` já existente em `Portal/clientes.js:36-38`.
- Produces: nenhuma função nova exportada — célula de tabela inline, igual ao padrão já usado para a coluna "Status"/"Contas".

- [ ] **Step 1: Escrever o teste de leitura de fonte (falha primeiro)**

Criar `Portal/clientes-squad-coluna-ui.test.js`:

```javascript
// Portal/clientes-squad-coluna-ui.test.js
//
// mission "fechar o contrato Cliente↔Squad" (set/2026) — audita
// Portal/clientes.html e Portal/clientes.js por leitura de fonte (mesmo
// padrão de clientes-criar-com-squad-ui.test.js): a tabela de clientes
// precisa mostrar a coluna Squad de forma compacta, honesta quando o
// cliente não tem squad, e a busca por texto precisa encontrar pelo nome
// do squad (a busca já roda sobre tr.textContent — só precisa o squad
// estar no HTML da linha).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const html = fs.readFileSync(path.join(__dirname, "clientes.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "clientes.js"), "utf8");

ok("thead da tabela tem uma coluna Squad", /<th[^>]*>\s*Squad\s*<\/th>/.test(html));
ok("renderClientes usa c.squad ao montar a linha", /c\.squad/.test(js));
ok("cliente sem squad mostra \"Sem Squad\" honesto (não inventa squad default)", /Sem Squad/.test(js));
ok("reaproveita isLegado() já existente (não duplica a regra de slug 'legado')", /isLegado\(c\.squad\)/.test(js));
ok(
  "célula do squad usa classe CSS dedicada e compacta (não card gigante)",
  /vf-cli-cell-squad/.test(js) && /vf-cli-cell-squad/.test(fs.readFileSync(path.join(__dirname, "css/pages/clientes-v2.css"), "utf8"))
);

console.log(`\nclientes-squad-coluna-ui.test.js: ${checks} verificações passaram.`);
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node Portal/clientes-squad-coluna-ui.test.js`
Expected: FALHOU em todas (coluna ainda não existe).

- [ ] **Step 3: Adicionar a coluna `Squad` no `<thead>` de `Portal/clientes.html`**

Substituir:

```html
                  <tr>
                    <th style="width:44px;">#</th>
                    <th>Nome</th>
                    <th>Slug</th>
                    <th>Status</th>
                    <th>Contas</th>
                    <th><span class="vf-visually-hidden">Ações</span></th>
                  </tr>
```

por:

```html
                  <tr>
                    <th style="width:44px;">#</th>
                    <th>Nome</th>
                    <th>Squad</th>
                    <th>Slug</th>
                    <th>Status</th>
                    <th>Contas</th>
                    <th><span class="vf-visually-hidden">Ações</span></th>
                  </tr>
```

- [ ] **Step 4: Adicionar a célula Squad em `renderClientes` (Portal/clientes.js)**

Substituir o `tr.innerHTML` atual:

```javascript
    tr.innerHTML = `
      <td class="vf-cli-cell-slug">${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHTML(c.nome || "—")}</strong></td>
      <td class="vf-cli-cell-slug">${escapeHTML(slug || "—")}</td>
      <td>
        <span class="vf-status ${ativo ? "is-success" : ""}">${ativo ? "Ativo" : "Inativo"}</span>
      </td>
      <td id="resumo-contas-${escapeHTML(slug)}"><span class="vf-cli-cell-muted">…</span></td>
      <td>
        <div class="vf-table__actions">
          <button class="vf-btn vf-btn--sm vf-btn--secondary vf-clientes-toggle-btn" data-action="toggle-expand" data-slug="${escapeHTML(slug)}" aria-expanded="false" title="Detalhes">⌄</button>
          <button class="vf-btn vf-btn--sm vf-btn--secondary" data-action="delete" data-slug="${escapeHTML(slug)}">Excluir</button>
        </div>
      </td>
    `;
```

por:

```javascript
    const squadTexto = c.squad
      ? `${escapeHTML(c.squad.nome)}${isLegado(c.squad) ? " · Legado" : ""}`
      : "Sem Squad";
    const squadCls = c.squad ? "" : "is-missing";

    tr.innerHTML = `
      <td class="vf-cli-cell-slug">${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHTML(c.nome || "—")}</strong></td>
      <td class="vf-cli-cell-squad ${squadCls}">${squadTexto}</td>
      <td class="vf-cli-cell-slug">${escapeHTML(slug || "—")}</td>
      <td>
        <span class="vf-status ${ativo ? "is-success" : ""}">${ativo ? "Ativo" : "Inativo"}</span>
      </td>
      <td id="resumo-contas-${escapeHTML(slug)}"><span class="vf-cli-cell-muted">…</span></td>
      <td>
        <div class="vf-table__actions">
          <button class="vf-btn vf-btn--sm vf-btn--secondary vf-clientes-toggle-btn" data-action="toggle-expand" data-slug="${escapeHTML(slug)}" aria-expanded="false" title="Detalhes">⌄</button>
          <button class="vf-btn vf-btn--sm vf-btn--secondary" data-action="delete" data-slug="${escapeHTML(slug)}">Excluir</button>
        </div>
      </td>
    `;
```

Nota: `squadTexto` já passa por `escapeHTML` em cada parte interpolada (`c.squad.nome`); o literal `" · Legado"` e `"Sem Squad"` são strings fixas do código, não precisam de escape.

- [ ] **Step 5: Adicionar a célula Squad na coluna `colspan` da linha de expansão**

Conferir `abrirLinhaExpandida` — `colspan` já usa `rowCliente.children.length`, que se ajusta automaticamente à nova coluna. Nenhuma mudança necessária aqui (só confirmar lendo o código, não editar).

- [ ] **Step 6: CSS da célula Squad em `Portal/css/pages/clientes-v2.css`**

Adicionar ao final do arquivo:

```css
/* Coluna "Squad" — texto secundário discreto, nunca badge colorido nem
   card. "Sem Squad" (cliente histórico sem vínculo) fica com o mesmo peso
   visual da coluna, só numa cor de atenção suave — não esconde o cliente,
   não inventa um squad default. */
.vf-page-clientes .vf-cli-cell-squad {
  color: var(--vf-text-secondary);
  font-size: var(--vf-fs-sm);
  white-space: nowrap;
}
.vf-page-clientes .vf-cli-cell-squad.is-missing {
  color: var(--vf-warning-strong);
  font-style: italic;
}
```

- [ ] **Step 7: Rodar o teste de novo**

Run: `node Portal/clientes-squad-coluna-ui.test.js`
Expected: PASS em todas as 5 verificações.

- [ ] **Step 8: Rodar os testes de frontend vizinhos (não devem quebrar)**

Run: `node Portal/clientes-criar-com-squad-ui.test.js`
Expected: PASS (esse teste audita o formulário de criação, não a tabela — não deveria ser afetado por esta mudança).

- [ ] **Step 9: Commit**

```bash
git add Portal/clientes.html Portal/clientes.js Portal/css/pages/clientes-v2.css Portal/clientes-squad-coluna-ui.test.js
git commit -m "feat(clientes-ui): coluna Squad compacta na tabela de clientes"
```

---

### Task 4: Frontend — modal de exclusão mostra Cliente + Squad e dependências humanizadas

**Files:**
- Modify: `Portal/clientes.js` (`abrirModalConfirmacaoClientes` call no handler de delete, e `confirmarModalClientes`)
- Create: `Portal/clientes-exclusao-squad-ui.test.js`

**Interfaces:**
- Consumes: `CLIENTES_LISTA` (array já populado por `loadClientes`, cada item agora com `.squad`) para achar o cliente pelo slug ao abrir o modal de exclusão. `err.dependencias` (já vem do backend, formato `[{label, tabela, total}]` — inalterado).
- Produces: nenhuma função nova exportada; só enriquece o texto do modal já existente (`vf-clientes-confirm-modal`).

- [ ] **Step 1: Escrever o teste de leitura de fonte (falha primeiro)**

Criar `Portal/clientes-exclusao-squad-ui.test.js`:

```javascript
// Portal/clientes-exclusao-squad-ui.test.js
//
// mission "fechar o contrato Cliente↔Squad" (set/2026) — a exclusão de
// Cliente já existia e já funcionava (botão "Excluir", modal de confirmação
// com bloqueio por dependências); esta tarefa só melhora a UX: o modal
// precisa mostrar o Squad do cliente (não só o slug) e a mensagem de
// dependências precisa ser uma lista humana, não "label: total" cru.
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

ok("botão Excluir continua existindo na linha do cliente", /data-action="delete"/.test(js));
ok("handler de exclusão busca o cliente em CLIENTES_LISTA pelo slug", /CLIENTES_LISTA\.find/.test(js));
ok("subtitle do modal de exclusão mostra o Squad do cliente (não só o slug)", /Squad\s*:?\s*\$\{/.test(js) || /subtitle.*squad/i.test(js));
ok(
  "mensagem de dependências é formatada como lista (bullet •), não 'label: total' cru",
  /•/.test(js)
);

console.log(`\nclientes-exclusao-squad-ui.test.js: ${checks} verificações passaram.`);
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node Portal/clientes-exclusao-squad-ui.test.js`
Expected: FALHOU em "subtitle do modal ... mostra o Squad" e em "mensagem de dependências ... bullet".

- [ ] **Step 3: Montar o subtitle do modal com Cliente + Squad**

Substituir, dentro de `renderClientes`, o listener do botão de exclusão:

```javascript
  clientesTbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-slug") || "";
      if (!slug) return;
      CLIENTE_DELETE_PENDENTE = { slug, btn };
      abrirModalConfirmacaoClientes({
        title: "Excluir cliente",
        subtitle: slug,
        description: `Esta ação remove o cliente "${slug}" do portal. Se houver contas, bases ou históricos vinculados, a exclusão será bloqueada.`,
        confirmLabel: "Excluir cliente",
        danger: true,
        onConfirm: null,
      });
    });
  });
```

por:

```javascript
  clientesTbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-slug") || "";
      if (!slug) return;
      const cliente = CLIENTES_LISTA.find((c) => c.slug === slug);
      const squadLabel = cliente?.squad ? cliente.squad.nome : "Sem Squad";
      CLIENTE_DELETE_PENDENTE = { slug, btn };
      abrirModalConfirmacaoClientes({
        title: "Excluir cliente",
        subtitle: `${cliente?.nome || slug} · Squad: ${squadLabel}`,
        description: `Esta ação exclui permanentemente o cliente "${cliente?.nome || slug}". Se houver contas, bases ou históricos vinculados, a exclusão será bloqueada.`,
        confirmLabel: "Excluir cliente",
        danger: true,
        onConfirm: null,
      });
    });
  });
```

- [ ] **Step 4: Humanizar a mensagem de dependências em `confirmarModalClientes`**

Substituir:

```javascript
  } catch (err) {
    const msg = err?.message || "Não foi possível concluir a ação.";
    const dependencias = err?.dependencias;
    if (dangerBox) {
      dangerBox.style.display = "block";
      dangerBox.textContent = dependencias?.length
        ? `${msg} (${dependencias.map((d) => `${d.label}: ${d.total}`).join(", ")})`
        : msg;
    } else {
      setClientesFeedback(msg, "danger");
    }
    if (ok) { ok.disabled = false; ok.textContent = CLIENTE_DELETE_PENDENTE ? "Excluir cliente" : "Confirmar"; }
  }
```

por:

```javascript
  } catch (err) {
    const msg = err?.message || "Não foi possível concluir a ação.";
    const dependencias = err?.dependencias;
    if (dangerBox) {
      dangerBox.style.display = "block";
      if (dependencias?.length) {
        const itens = dependencias.map((d) => `• ${d.label}: ${d.total}`).join("\n");
        dangerBox.textContent = `${msg}\n\n${itens}`;
      } else {
        dangerBox.textContent = msg;
      }
    } else {
      setClientesFeedback(msg, "danger");
    }
    if (ok) { ok.disabled = false; ok.textContent = CLIENTE_DELETE_PENDENTE ? "Excluir cliente" : "Confirmar"; }
  }
```

Nota: `dangerBox` é um `<div class="vf-alert is-danger">` (ver `clientes.html`); `textContent` com `\n` é renderizado em branco a menos que o CSS preserve quebras de linha — conferir/adicionar `white-space: pre-line` na classe `.vf-alert.is-danger` se ainda não existir (checar `vf-components-v2.css` antes de duplicar a regra).

- [ ] **Step 5: Rodar o teste de novo**

Run: `node Portal/clientes-exclusao-squad-ui.test.js`
Expected: PASS em todas as 4 verificações.

- [ ] **Step 6: Commit**

```bash
git add Portal/clientes.js Portal/clientes-exclusao-squad-ui.test.js
git commit -m "feat(clientes-ui): modal de exclusao mostra Squad e lista dependencias de forma humana"
```

---

### Task 5: Rodar toda a suíte e fechar a missão

**Files:** nenhum (só validação).

- [ ] **Step 1: Suíte completa do backend**

Run: `cd server && npm test`
Expected: todos os arquivos `tests/*.test.js` passam, incluindo os 3 tocados/criados nas Tasks 1-2.

- [ ] **Step 2: Testes de frontend tocados/criados (rodar cada um — não há runner único para Portal/)**

Run:
```bash
node Portal/clientes-criar-com-squad-ui.test.js
node Portal/clientes-squad-coluna-ui.test.js
node Portal/clientes-exclusao-squad-ui.test.js
```
Expected: PASS nos três.

- [ ] **Step 3: Push da branch**

```bash
git push -u origin fix/clientes-squad-required-admin-delete
```

Sem merge, sem deploy — conforme a missão.

## Self-Review Notes (preenchido durante a escrita do plano)

- Cobertura da spec: criação obrigatória (Task 1), listagem com squad sem N+1 (Task 2), coluna Squad + "Sem Squad" + Legado + busca (Task 3 — busca já funciona de graça porque `filtrarClientes` varre `tr.textContent`), modal de exclusão com Squad + dependências humanas (Task 4). Dependências/hard-delete/requireAdmin já existiam e foram preservados sem reescrita (clienteDependenciasService, requireAdmin) — não há task para "criar" isso porque já existe e já está correto.
- Não há placeholder: todo step tem o código completo a escrever.
- Consistência de tipos: `squad` é sempre `{id, nome, slug} | null` em todas as camadas (squadsRepository → server/index.js → Portal/clientes.js → isLegado()), igual ao shape já usado em `meService.js`/`squadsDoUsuario`.
