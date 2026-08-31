# 06 — JWT_SECRET — readiness de deploy

> **Nada aqui altera produção.** Este documento só descreve a regra nova, o
> impacto e o checklist. **Nenhum segredo real aparece neste arquivo nem deve
> aparecer em qualquer arquivo versionado.**
>
> **Resultado:** `JWT_SECRET: PRECISA CONFIGURAÇÃO HUMANA` — precisa de alguém
> com acesso ao painel do Render para confirmar/definir a variável **antes** do
> deploy do código de P2.7. Não é possível verificar o estado do Render a
> partir do repositório.

---

## 1. A regra nova (P2.7 BLOCO Q — `server/config/jwtSecret.js`)

Antes: 5 arquivos faziam `process.env.JWT_SECRET || "venforce_secret_local"`.
Um segredo no código não é segredo — qualquer um que lê o repo forja um JWT
`role:"admin"` e passa por toda a autorização, inclusive o bypass de admin.
E o fallback era **silencioso**: subir sem `JWT_SECRET` não dava erro.

Agora, `getJwtSecret()` (fonte única, usada por `authController`,
`authMiddleware`, `mlApiService`):

| Ambiente | Comportamento |
|---|---|
| `NODE_ENV=production` **sem** `JWT_SECRET` | **servidor NÃO sobe** — lança `JWT_SECRET_INSEGURO` com mensagem acionável |
| `NODE_ENV=production` com `JWT_SECRET = "venforce_secret_local"` | **NÃO sobe** (recusa o valor de dev) |
| `NODE_ENV=production` com `JWT_SECRET` de **< 32 caracteres** | **NÃO sobe** |
| `NODE_ENV=production` com `JWT_SECRET` próprio ≥ 32 chars | ✅ sobe |
| fora de produção sem `JWT_SECRET` | usa o fallback local + `console.warn` único |

`NODE_ENV` é o que **ativa** a regra. Se produção hoje roda **sem**
`NODE_ENV=production`, a regra não dispara — mas então produção também está
usando o segredo público do código. Definir `NODE_ENV=production` é parte da
correção.

---

## 2. Impacto de definir `JWT_SECRET`

**Definir (ou trocar) `JWT_SECRET` invalida TODAS as sessões existentes.**
Todo mundo — internos, sellers, admin — refaz login. Tokens de 7 dias emitidos
com o segredo antigo param de verificar.

Isso é o **resultado desejado** (o segredo antigo é público), mas **precisa ser
combinado com o time**, não descoberto em produção. Escolher uma janela de
baixo uso.

Efeito colateral relevante para P2.9: o smoke pós-deploy (`07`/`09`) precisa de
um login **novo** para ter um token válido.

---

## 3. O que descobrir / confirmar (AÇÃO HUMANA — acesso ao Render)

| # | Pergunta | Como verificar | Resposta |
|---|---|---|---|
| 1 | O serviço no Render **já tem** `JWT_SECRET` definido? | painel Render → serviço → Environment | `PENDENTE_HUMANO` |
| 2 | Se tem, o valor tem **≥ 32 caracteres**? (não revelar o valor — só o comprimento) | `[ ${#JWT_SECRET} -ge 32 ]` num shell do serviço, ou conferir no painel | `PENDENTE_HUMANO` |
| 3 | O valor **não é** `venforce_secret_local`? | idem | `PENDENTE_HUMANO` |
| 4 | `NODE_ENV` está definido? Qual valor? | painel Render → Environment | `PENDENTE_HUMANO` |
| 5 | Se `NODE_ENV != production`, há intenção de mudar? (a regra do §1 só vale com `production`) | decisão | `PENDENTE_HUMANO` |
| 6 | Existe backup/registro seguro do `JWT_SECRET` atual (cofre / gestor de segredos)? | processo do time | `PENDENTE_HUMANO` |

---

## 4. Como gerar um segredo (quando for a hora — NÃO agora)

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# 96 hex chars — bem acima do mínimo de 32
```

Colar **só** no painel de env vars do Render. **Nunca** em arquivo, commit,
mensagem de chat, issue ou neste pacote.

---

## 5. Comprovar que nenhum segredo está versionado (feito nesta preparação)

| Verificação | Resultado |
|---|---|
| `.gitignore` ignora `.env` e `.env.*` (com `!.env.example`) | ✅ confirmado (`.gitignore:2,26,29`, `server/.gitignore:2`) |
| Nenhum arquivo `.env` real rastreado | ✅ `git ls-files \| grep .env` → só `.env.example` e `frontend-react/.env.example` |
| `venforce_secret_local` só aparece como **marcador** em `server/config/jwtSecret.js` (que recusa esse valor em produção) e em setup de testes | ✅ confirmado — não há segredo de produção no código |
| Os 5 fallbacks antigos foram removidos da árvore `server/` | ✅ `authController`, `authMiddleware`, `mlApiService` usam `getJwtSecret()` |
| Árvore raiz `/auth/*` (legado morto — `package.json` da raiz é `{}`) | ⚠️ pode ainda ter o fallback antigo; é código não executado (BE8/RP8 — aposentar formalmente). **Não corrigir nesta fase.** |

---

## 6. Checklist de deploy (para o runbook de P2.9 — NÃO executar agora)

```
[ ] janela de baixo uso escolhida e comunicada ao time
[ ] JWT_SECRET novo gerado (48+ bytes aleatórios) e guardado no cofre
[ ] JWT_SECRET definido nas env vars do Render (serviço de produção)
[ ] NODE_ENV=production confirmado nas env vars
[ ] SQUADS_ENFORCEMENT ausente ou = off  (confirmado no mesmo painel)
[ ] aviso enviado: "vamos deslogar todo mundo às HH:MM"
[ ] deploy do código (Convergência #2 mergeada)
[ ] HEALTH CHECK: o servidor SUBIU? (se JWT_SECRET faltar/for curto, ele NÃO sobe — é o esperado)
[ ] login novo funciona; GET /me/context responde 200
```

Só depois disso o fluxo de dados de Squad (`09`) começa.

**Resultado:** `JWT_SECRET: PRECISA CONFIGURAÇÃO HUMANA` (não verificável do repo).
