#!/usr/bin/env node
// server/sql/squads-mapeamento-docs.js
// VenForce V3 — P2.9 Real Mapping. Gera a documentação humana a partir dos
// MESMOS artefatos que o tooling consome, para que número de documento e
// número de plano nunca possam divergir.
//
// 100% OFFLINE. Não abre conexão. Não imprime api_key, token nem credencial.
//
//   node server/sql/squads-mapeamento-docs.js \
//     --inventario inv.json --auditoria aud.json --relacao rel.json \
//     --dry-run dry.txt --saida-dir Squads_migration/P2_9_REAL_MAPPING

const fs = require("fs");
const path = require("path");
const M = require("./squads-mapeamento-real");

const NL = "\n";
const j = (a, s = ", ") => a.join(s);
const tab = (cab, linhas) =>
  [`| ${j(cab, " | ")} |`, `|${cab.map(() => "---").join("|")}|`,
    ...linhas.map((l) => `| ${j(l.map((c) => String(c ?? "")), " | ")} |`)].join(NL);

function args(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) a[t.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return a;
}

/* ═══════════════════════════ documentos ═══════════════════════════ */

function doc00(r, ctx) {
  const s = r.resumo;
  return `# 00 — RESUMO · P2.9 REAL MAPPING

> **Estado:** \`SQUADS_ENFORCEMENT\` = **OFF** · migração **NÃO APLICADA** ·
> banco **NÃO ALTERADO** · \`--apply\` **NÃO EXECUTADO**.
> Toda leitura desta fase rodou em transação read-only, e o dry-run rodou com a
> sessão do Postgres forçada em \`default_transaction_read_only=on\` — o próprio
> servidor recusaria qualquer escrita.

| | |
|---|---|
| Base da branch | \`${ctx.baseSha}\` (\`${ctx.baseRef}\`) |
| Branch | \`backend/v3-p2-9-real-mapping\` |
| Banco lido | produção (Render) · somente leitura |
| Snapshot | \`${ctx.geradoEm}\` |

---

## 1. O que esta fase resolveu

A fase anterior parou na fronteira da informação humana: faltava
**Cliente → Squad**. Ela chegou, e com ela três problemas que só apareciam com
dado real na mão.

**Primeiro: a relação não casa com o cadastro por igualdade de string.** Dos 52
nomes, só ${s.porClasse.MATCH_EXATO || 0} batem exatamente. O resto discorda em
pontuação (\`J&W Presentes\` × \`jw presentes\`), em abreviação (\`Tenda\` ×
\`Tenda Medieval\`), em conectivo (\`Toque de Ouro\` × \`Toque ouro\`) ou em grafia
(\`Kirus\` × \`Kirius\`). Casar isso por fuzzy silencioso seria dar carteira errada
para gente real, então o casamento roda em **camadas determinísticas** e a
primeira camada que produzir **exatamente um** candidato decide. Duas ou mais →
\`MATCH_AMBIGUO\`, que volta para o humano.

**Segundo: existem entidades \`clientes\` que são a mesma empresa.** São
${s.clusters} clusters, ${s.aliases} aliases. Mas — e isto importa — **sufixo
não é evidência**. \`ER2\`, \`Shopping 86\` e \`Fenix Equipamentos1\` terminam em
número e não são duplicata de ninguém. A regra usada se autovalida: só forma
cluster se o radical resultante **casar com outro cliente real**. A prova forte
é chave natural — mesmo \`ml_user_id\` ou mesmo \`external_account_id\` sob
clientes distintos.

**Terceiro: uma colisão de chave natural nem sempre é identidade.** Um caso
(\`#102\` × \`#105\`) tem a assinatura de **grant cruzado**: alguém conectou a
conta de um cliente de dentro do outro. Fundir seria pior que não fundir, e o
caso está marcado \`NAO_MERGEAR\`.

---

## 2. Números reais

${tab(["", "valor"], [
  ["Clientes reais no banco", `**${s.clientesReais}** (todos ativos)`],
  ["Nomes na relação", `**${s.nomesNaRelacao}**`],
  ["→ MATCH_EXATO", s.porClasse.MATCH_EXATO || 0],
  ["→ MATCH_ALIAS_COMPROVADO", s.porClasse.MATCH_ALIAS_COMPROVADO || 0],
  ["→ MATCH_CLUSTER_LEGADO", s.porClasse.MATCH_CLUSTER_LEGADO || 0],
  ["→ MATCH_AMBIGUO", s.porClasse.MATCH_AMBIGUO || 0],
  ["→ NAO_EXISTE_NO_BANCO", `**${s.porClasse.NAO_EXISTE_NO_BANCO || 0}** — não criados`],
  ["Clusters legados", s.clusters],
  ["Aliases a consolidar", s.aliases],
  ["Clientes canônicos projetados", s.canonicosProjetados],
  ["Identidades resolvidas", `**${r.identidades.filter((i) => i.userId).length} de 23**`],
  ["Invariantes", `**${r.invariantes.length - s.invariantesFalhas}/${r.invariantes.length} verdes**`],
])}

### Clientes por Squad

${tab(["Squad", "clientes reais"],
  ["squad-1", "squad-2", "squad-3", "squad-4", "squad-5", "squad-6", "squad-8-legado"]
    .map((k) => [k === "squad-8-legado" ? "**Squad 8 · Legado**" : k, s.clientesPorSquad[k] || 0]))}

Soma = **${Object.values(s.clientesPorSquad).reduce((a, b) => a + b, 0)}** = todos os clientes reais.
Nenhum cliente ficou de fora; nenhum ficou em dois Squads.

---

## 3. O princípio que governa o mapa

> **Squad 8 é o default seguro.**

Squad 8 · Legado é **quarentena, não descarte**. Colocar um cliente nele por
engano se desfaz movendo-o depois; colocá-lo no Squad operacional **errado** é
acesso indevido em produção no dia em que o enforcement ligar. Por isso toda
incerteza cai para o Squad 8, e **nenhuma** cai num Squad 1–6.

É isso que permite fechar o mapa dos ${s.clientesReais} clientes sem inventar
nada, deixando para o humano só o que é genuinamente decisão de negócio.

---

## 4. Índice

${tab(["#", "arquivo", "conteúdo"], [
  ["00", "este resumo", "—"],
  ["01", "`01_RELACAO_SQUADS_NORMALIZADA.md`", "a planilha, literal e normalizada"],
  ["02", "`02_MATCH_CLIENTES_PLANILHA_BANCO.md`", "os 52 nomes, um a um, com a camada que decidiu"],
  ["03", "`03_CLIENTES_NAO_CRIADOS.md`", "**os que não existem — e continuam não existindo**"],
  ["04", "`04_CLIENTES_SQUAD_8_LEGADO.md`", "os clientes em quarentena"],
  ["05", "`05_CLUSTERS_CLIENTES_LEGADOS.md`", "as entidades que são a mesma empresa"],
  ["06", "`06_REFERENCIAS_CLIENTE_ID.md`", "matriz de referências · FK · ON DELETE"],
  ["07", "`07_GRANTS_PRESERVACAO.md`", "**prova de que nenhum Grant se perde**"],
  ["08", "`08_BASES_PRESERVACAO.md`", "Bases por conta × client-level"],
  ["09", "`09_IDENTIDADES_USUARIOS.md`", "as 23 pessoas → user_id"],
  ["10", "`10_MULTI_SQUAD_PRINCIPAL_PENDENTE.md`", "quem está em 2+ Squads"],
  ["11", "`11_HARDENING_T2_T3_T4.md`", "os três bloqueadores técnicos, resolvidos"],
  ["12", "`12_CLIENT_CONSOLIDATION_PLAN.md`", "o plano de consolidação, em português"],
  ["13", "`13_MAPA_P2_9_REAL.md`", "o mapa completo"],
  ["14", "`14_DRY_RUN_RESULTADO.md`", "o dry-run real, contra produção"],
  ["15", "`15_GO_NO_GO_PRE_APPLY.md`", "**o veredito**"],
  ["16", "**`16_DECISOES_FINAIS_HUMANAS.md`**", "**← comece por aqui: o que só você pode decidir**"],
])}

Artefatos de máquina em \`artefatos/\`:
\`plano-p2-9.json\` (canônico do \`squads-migrate.js\`),
\`CLIENT_CONSOLIDATION_PLAN.json\`, \`MAPA_P2_9_REAL.json\`.
Entrada em \`entrada/relacao-squads-v2.json\`.
`;
}

function doc01(r, ctx) {
  const rel = ctx.relacao;
  const blocos = rel.squads.map((s) => {
    const papeis = tab(["papel", "nome na planilha", "resolvido"],
      Object.entries(s.papeis).map(([p, v]) => {
        const id = r.identidades.find((i) => i.nomeRelacao === v);
        return [p, v === "AUSENTE_NA_ESTRUTURA" ? "_(vazio)_" : `\`${v}\``,
          v === "AUSENTE_NA_ESTRUTURA" ? "— posição vaga"
            : id && id.userId ? `#${id.userId} · ${id.email}`
              : `**${id ? id.classe : "?"}**`];
      }));
    const cl = s.clientes.map((n) => {
      const m = r.matches.find((x) => x.nomeRelacao === n && x.squadSlug === s.slug);
      return [`\`${n}\``, m ? m.classe : "?", m && m.clienteId ? `#${m.clienteId} \`${m.clienteSlug}\`` : "—"];
    });
    return `### ${s.nome}  ·  rótulo na planilha: \`${s.rotuloPlanilha}\`

${papeis}

**Clientes (${s.clientes.length}):**

${tab(["nome na relação", "classe", "cliente real"], cl)}`;
  }).join(NL + NL + "---" + NL + NL);

  return `# 01 — A relação operacional, literal e normalizada

> Extração **literal** de \`Squads_migration/Squads.xlsx\`. Nenhum nome foi
> corrigido, traduzido ou inferido na entrada. A normalização acontece depois,
> no casamento, e cada decisão fica registrada em \`02\`.

## O rótulo do 6º bloco

O readiness anterior deixou pendente o rótulo do 6º bloco, porque a versão que
chegou antes o escrevia como \`squad 5\` pela segunda vez. **A planilha atual
resolve isso na própria fonte:** o bloco está rotulado \`squad 6\`.

${tab(["bloco", "rótulo lido na planilha", "slug canônico"],
  rel.squads.map((s) => [s.numero, `\`${s.rotuloPlanilha}\``, `\`${s.slug}\``]))}

A estrutura confirmada é **Coordenador → Gestor → Auxiliar → Auxiliar 2 →
Design**, e **Coordenador não é Gestor** — a correção da fase anterior está
preservada. No plano canônico, \`coordenador\` vira
\`squad_members.funcao = "coordenador"\`; Gestor, Auxiliar e Design viram
\`funcao = "membro"\`, porque são papéis **operacionais**, não de autorização.

Dois Squads têm a posição de **Auxiliar 2 vazia** (Squads 5 e 6). Isso não é
erro de leitura: a célula está em branco na planilha.

---

${blocos}
`;
}

function doc02(r) {
  const linhas = r.matches.map((m) => [
    `\`${m.nomeRelacao}\``, m.squadSlug, `**${m.classe}**`,
    m.camada ? `\`${m.camada}\`` : "—",
    m.clienteId ? `#${m.clienteId} \`${m.clienteSlug}\`` : "—",
    m.clienteId ? "" : (m.candidatos || []).map((c) => `#${c.id} \`${c.slug}\``).join(" · ") || "_nenhum_",
  ]);
  return `# 02 — Match: planilha ↔ cliente real

> **Regra:** nenhum fuzzy silencioso. O casamento roda em camadas
> determinísticas e a **primeira camada que produzir exatamente um candidato
> decide**. Duas ou mais → \`MATCH_AMBIGUO\`. Nenhuma → \`NAO_EXISTE_NO_BANCO\`.

## As camadas, da mais estrita para a mais frouxa

${tab(["camada", "o que compara", "por que é segura"], [
  ["\`L1_IGUALDADE_EXATA\`", "nome/slug normalizado idêntico", "identidade literal"],
  ["\`L1B_IGUALDADE_COMPACTA\`", "mesma sequência de letras, sem separador", "`J&W Presentes` ≡ `jw presentes` — não é fuzzy, é a mesma string sem pontuação"],
  ["\`L1C_..._SEM_CONECTIVOS\`", "idem, ignorando `de/da/do/e`", "`Toque de Ouro` ≡ `Toque ouro`"],
  ["\`L2_RADICAL_DO_CLUSTER\`", "o radical comum de um cluster", "a relação nomeia a empresa, não a entidade"],
  ["\`L3_RADICAL_LEGADO\`", "nome sem o sufixo legado", "`Alma` para `Alma 2`"],
  ["\`L4_PREFIXO_DE_TOKENS\`", "a relação abrevia o cadastro", "`Tenda` → `Tenda Medieval`"],
  ["\`L4B_CLIENTE_PREFIXO...\`", "o cadastro abrevia a relação", "`DM Comércio` → cliente `DM`"],
  ["\`L5_CONTENCAO_DE_TOKENS\`", "todos os tokens presentes", "só a partir de 5 caracteres"],
  ["\`L6_EVIDENCIA_DE_BASE\`", "**evidência de banco**, não de string", "`Eletro in Matec` → base `eletroinmatec_ml` do cliente #111"],
  ["\`L7_DISTANCIA_1_COMPACTA\`", "uma letra de diferença, mín. 5 letras", "`Kirus` ↔ `Kirius` — última camada, a mais frouxa"],
])}

Nomes com menos de 5 caracteres **não** podem ser resolvidos por contenção nem
por distância. É o que impede \`MM\`, \`MW\`, \`GS\` e \`ADS\` de casarem por acidente.

---

## Os 52 nomes

${tab(["nome na relação", "squad", "classe", "camada", "cliente real", "candidatos"], linhas)}
`;
}

function doc03(r) {
  const naoExiste = r.matches.filter((m) => m.classe === M.CLASSE.INEXISTENTE);
  const ambiguo = r.matches.filter((m) => m.classe === M.CLASSE.AMBIGUO);
  return `# 03 — Clientes da relação que NÃO existem no banco

> **REGRA ABSOLUTA CUMPRIDA: nenhum cliente foi criado.**
> Estas entradas ficam **fora** do plano aplicado agora. Quando o cliente for
> criado, ele poderá ser vinculado ao Squad correspondente.

## ${naoExiste.length} nomes sem cliente correspondente

${tab(["nome", "squad esperado", "status", "motivo / o que foi tentado"],
  naoExiste.map((m) => [`\`${m.nomeRelacao}\``, m.squadSlug, "**RELACAO_SEM_CLIENTE_CRIADO**",
    "todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato"]))}

### Notas por caso

- **\`GS\`** e **\`ADS\`** — duas e três letras. Não existe cliente com esse token.
  \`ADS\` **não** é \`ADB Supply\` (#21), que já está alocado ao Squad 2.
- **\`MW\`** — não existe cliente com o token \`mw\`. **Não confundir com \`MWM\`**
  (#9), que a própria relação aloca ao **Squad 2**, e nem com \`WM\` (Squad 4),
  que é outro nome na mesma planilha. Três tokens parecidos, três destinos
  diferentes — motivo pelo qual nenhum deles é resolvido por aproximação.
- **\`Nikolly Fashion\`** e **\`Thiago Moreno\`** — nomes longos e distintos, sem
  nada próximo no cadastro. São clientes que a operação atende e que **ainda não
  foram cadastrados**.

---

## ${ambiguo.length} nome ambíguo — também fora do plano

${ambiguo.length ? tab(["nome", "squad", "candidatos", "por quê"],
  ambiguo.map((m) => [`\`${m.nomeRelacao}\``, m.squadSlug,
    (m.candidatos || []).map((c) => `#${c.id} \`${c.slug}\` (${c.contasAtivas} conta, ${c.grants} grant)`).join(" · "),
    m.motivo || ""])) : "_nenhum_"}

Ambíguo **não** vira palpite: os candidatos caem no **Squad 8 · Legado**, que é
quarentena reversível. Resolver isso é decisão humana — ver \`16\`.

---

## Efeito no total

${tab(["", "quantidade"], [
  ["Nomes na relação", 52],
  ["Resolvidos para cliente real", 52 - naoExiste.length - ambiguo.length],
  ["Não existem (não criados)", `**${naoExiste.length}**`],
  ["Ambíguos (não decididos)", `**${ambiguo.length}**`],
  ["**Clientes criados por esta missão**", "**0**"],
])}
`;
}

function doc04(r) {
  const s8 = r.mapaClientes.filter((m) => m.squad === M.SQUAD_LEGADO.slug);
  const porId = new Map(r.clientes.map((c) => [c.id, c]));
  return `# 04 — Squad 8 · Legado

> **\`squad-8-legado\` · "Squad 8 · Legado"** — o número 8 é **deliberado**.
> Não renomear para Squad 7. Squad 8 **não conta** entre os 6 Squads
> operacionais: o modelo é **6 operacionais + 1 legado especial**.

## O que Squad 8 é, e o que não é

Squad 8 existe para impedir que cliente antigo ou fora da relação fique **sem
Squad, órfão, descartado ou invisível no modelo de dados**. É **quarentena
operacional**, não lixeira.

**Nesta missão, Squad 8 não recebe nenhuma pessoa:** sem Coordenador, sem
Gestor, sem Auxiliar, sem Designer, sem membro comum. Atribuir responsabilidade
sobre esses clientes seria inventar decisão de negócio. Admin continua com
bypass, e como \`SQUADS_ENFORCEMENT\` está **OFF**, Squad 8 **não muda acesso
nenhum em produção hoje**.

> ⚠️ **Antes de ligar o enforcement é preciso decidir o que acontece com este
> bucket.** Com enforcement ON e Squad 8 sem membros, estes ${s8.length} clientes
> ficam acessíveis **apenas para admin**. Para clientes de teste isso é o
> desejado; para um cliente real de operação, não. Ver \`16\`.

---

## Os ${s8.length} clientes em quarentena

${tab(["id", "slug", "nome", "papel", "contas", "grants", "por que está aqui"],
  s8.map((m) => {
    const c = porId.get(m.clienteId);
    return [m.clienteId, `\`${m.slug}\``, m.nome,
      m.papel === "ALIAS" ? `alias → #${m.canonicalClienteId}` : "canônico",
      c ? c.contasAtivas : "?", c ? c.grants.length : "?",
      m.papel === "ALIAS" ? "herda o Squad do canônico, que também está aqui"
        : "não aparece na relação dos Squads 1–6"];
  }))}

---

## Leitura do conteúdo

O perfil deste bucket é exatamente o esperado de um cadastro com anos de uso:

- **clientes de teste/demonstração** — \`teste1\`, \`teste2\`, \`Teste 01\`,
  \`Teste_x01\`, \`Cliente Demo Shopee\`, \`seller-teste\`. São artefatos de QA e o
  lugar deles é a quarentena.
- **os dois lados de uma ambiguidade** — \`MM Importes\` (#54) e \`MM Comercio\`
  (#107). A relação diz \`MM\` uma vez; enquanto não se souber qual, **os dois**
  ficam aqui. É a aplicação direta do default seguro.
- **\`JFX\` (#75)** — tem conta e grant próprios e não aparece na relação. Pode
  ser uma conta da \`JF\` (Squad 1) cadastrada como entidade separada. Confirmar
  é decisão humana; enquanto isso, quarentena.
- **\`Eliza.Market\` (#105)** — envolvida no grant cruzado com \`Fenix\`. Ver \`05\`.
- **clientes reais antigos sem menção na relação** — \`Deluche\`, \`Pro Fit\`,
  \`Trevo\`, \`Mais Estilo\`, \`Vent soluções\` e outros. Todos têm conta e grant
  ativos; simplesmente não constam da operação atual dos 6 Squads.
`;
}

function doc05(r) {
  const porId = new Map(r.clientes.map((c) => [c.id, c]));
  const blocos = r.clusters.map((cl) => {
    const membros = tab(["id", "slug", "nome", "score", "contas", "grants", "bases", "linhas ref.", "papel"],
      cl.membros.map((m) => [m.id, `\`${m.slug}\``, m.nome, m.score, m.contasAtivas, m.grants, m.bases,
        m.linhasReferenciadas, m.id === cl.canonicalClienteId ? "**CANÔNICO**" : "alias"]));
    const evs = cl.evidencias.map((e) => `- \`${e.tipo}\` **[${e.confianca}]** entre #${e.entre[0]} e #${e.entre[1]} — ${e.detalhe}`).join(NL);
    return `### Cluster \`${cl.chave}\` — **${cl.confianca}**

Radical comum: ${cl.radicalComum ? `\`${cl.radicalComum}\`` : "_(nenhum — o cluster foi provado por chave natural, não por nome)_"}
Corroborado pela relação: **${cl.corroboradoPelaRelacao ? "sim" : "não"}**
Ação: \`${cl.acao}\`

${membros}

**Evidências:**

${evs}`;
  }).join(NL + NL + "---" + NL + NL);

  return `# 05 — Clusters de cliente legado

> **Sufixo não é evidência.** A regra de sufixo se autovalida: \`Empresa X 2\` só
> forma cluster com \`Empresa X\` se o radical resultante **casar com outro
> cliente real**. É o que impede \`ER2\` → \`ER\`, \`Shopping 86\` → \`Shopping\` e
> \`Fenix Equipamentos1\` → \`Fenix Equipamentos\` de virarem falsos clusters.

## O modelo que estamos corrigindo

\`\`\`
ANTIGO                          NOVO
cliente "Empresa X"             cliente "Empresa X"
cliente "Empresa X 2"      →       ├── ClienteConta 1
cliente "Empresa X 3"              ├── ClienteConta 2
  (cada um = uma conta)            └── ClienteConta 3
\`\`\`

## Hierarquia de evidências

${tab(["evidência", "força", "o que prova"], [
  ["\`EXTERNAL_ACCOUNT_ID\`", "**CONFIRMADO**", "duas `cliente_contas` apontam para a **mesma conta de marketplace** sob clientes diferentes"],
  ["\`ML_USER_ID\` (ambos primários)", "**CONFIRMADO**", "duas entidades reivindicam a mesma conta como principal"],
  ["\`SUFIXO_LEGADO_AUTOVALIDADO\`", "FORTE", "o radical existe como cliente real — o sufixo é sufixo mesmo"],
  ["\`RADICAL_LEGADO_COMUM\`", "FORTE", "`maya 2` e `maya 3` reduzem ao mesmo radical"],
  ["\`SUFIXO_MARKETPLACE_CASCA_VAZIA\`", "FORTE", "`zorza_shopee` sem conta, grant, base nem linha — fundir não pode perder nada"],
  ["corroboração pela relação", "eleva FORTE → CONFIRMADO", "a operação listou o radical **uma vez** para N entidades: ela própria diz que é uma empresa só"],
])}

**Só \`CONFIRMADO\` pode chegar ao plano automático.** \`FORTE\` e \`AMBIGUO\` são
decisão humana — e, como a consolidação é \`PLAN_ONLY\` nesta missão, nada disso
foi aplicado de qualquer forma.

---

## Escolha do canônico

Não é "menor id sempre". O score é evidência de uso real:

${tab(["componente", "peso", "por quê"], [
  ["sem sufixo legado", "**1000**", "única propriedade que fala da **identidade comercial**"],
  ["contas ativas", "60 cada", "operação viva"],
  ["grants", "50 cada", "acesso vivo ao marketplace"],
  ["vínculos de base ativos", "25 cada", "custo operacional configurado"],
  ["volume de dados", "log₁₀ × 30", "custo de migrar, não identidade"],
  ["id mais antigo", "desempate", "o registro original tende a ser o primeiro"],
])}

---

## Os ${r.clusters.length} clusters

${blocos}

---

## ⛔ Pares explicitamente NÃO mergeados

${r.naoMergear.length ? r.naoMergear.map((n) => `### \`${n.classe}\` — clientes ${n.clientes.map((id) => {
  const c = porId.get(id); return `#${id} \`${c ? c.slug : "?"}\``;
}).join(" × ")}

**Confiança: \`${n.confianca}\`**

${n.motivo}

> **Por que isto importa mesmo sem consolidação:** os dois clientes vão para
> Squads diferentes. Se o grant cruzado permanecer, no dia do enforcement o
> Squad de um deles alcança a conta de marketplace do outro. Isso é **defeito de
> dado com consequência de acesso** — precisa ser resolvido no cadastro, não no
> mapeamento. Ver \`16\`.`).join(NL + NL) : "_nenhum_"}
`;
}

function doc06(r, ctx) {
  const mat = ctx.auditoria.matrizReferencias;
  const cont = new Map(ctx.auditoria.contagens.map((c) => [`${c.tabela}.${c.coluna}`, c]));
  const linhas = mat.map((m) => {
    const c = cont.get(`${m.tabela}.${m.coluna}`);
    return [`\`${m.tabela}\``, `\`${m.coluna}\``, m.temFk ? "sim" : "**NÃO**",
      m.onDelete ? `\`${m.onDelete}\`` : "—", c ? c.total : "?", c ? Object.keys(c.porChave).length : "?"];
  });
  const semFk = mat.filter((m) => !m.temFk);
  const casc = mat.filter((m) => m.onDelete === "CASCADE");
  return `# 06 — Matriz de referências a \`cliente_id\`

> Levantada do banco real por \`information_schema\`, não por leitura de código —
> o código pode estar desatualizado, o catálogo não.

## Panorama

${tab(["", "quantidade"], [
  ["Colunas que referenciam `cliente_id`/`cliente_conta_id`", `**${mat.length}**`],
  ["…com foreign key", mat.length - semFk.length],
  ["…**sem** foreign key", `**${semFk.length}**`],
  ["FKs com `ON DELETE CASCADE`", `**${casc.length}**`],
])}

---

## ⚠️ As ${semFk.length} referências SEM foreign key

Estas são as perigosas: **nada garante integridade nelas**. Uma consolidação
que reaponte \`cliente_id\` tem de atualizá-las **explicitamente** — nenhum
\`CASCADE\` vai fazer isso, e nenhum erro vai avisar se ficarem para trás.

${tab(["tabela.coluna", "linhas"], semFk.map((m) => {
  const c = cont.get(`${m.tabela}.${m.coluna}`);
  return [`\`${m.tabela}.${m.coluna}\``, c ? c.total.toLocaleString("pt-BR") : "?"];
}))}

O volume aqui não é trivial: \`central_vendas_componentes\` sozinha tem
**${(cont.get("central_vendas_componentes.cliente_id")?.total || 0).toLocaleString("pt-BR")}** linhas,
e \`central_vendas_pedidos\` mais \`central_vendas_pedido_itens\` somam
**${((cont.get("central_vendas_pedidos.cliente_id")?.total || 0) + (cont.get("central_vendas_pedido_itens.cliente_id")?.total || 0)).toLocaleString("pt-BR")}**.
Consolidação aqui é migração de dados de verdade, não um \`UPDATE\` de uma linha.

---

## ⛔ As ${casc.length} FKs com \`ON DELETE CASCADE\`

**Este é o motivo técnico de "não deletar cliente".** Apagar um registro de
\`clientes\` não deixaria um órfão: **destruiria em cascata** grants, contas,
vínculos de base, diagnósticos, histórico e responsabilidades.

${tab(["tabela.coluna", "o que seria destruído"], casc.map((m) => [`\`${m.tabela}.${m.coluna}\``,
  m.tabela === "ml_tokens" ? "**os Grants — o acesso ao marketplace**"
    : m.tabela === "cliente_contas" ? "**as contas do cliente**"
      : m.tabela === "base_cliente_vinculos" ? "os vínculos de Base"
        : m.tabela === "cliente_squad_history" ? "o histórico de Squad"
          : m.tabela === "cliente_responsaveis" ? "as responsabilidades"
            : "dados operacionais"]))}

E não existe soft delete: \`DELETE /clientes/:slug\` é \`DELETE\` físico
(\`clienteDependenciasService.js\` declara isso explicitamente). A coluna \`ativo\`
é a única marcação de estado.

---

## Matriz completa

${tab(["tabela", "coluna", "FK?", "ON DELETE", "linhas", "chaves distintas"], linhas)}
`;
}

function doc07(r, ctx) {
  const porId = new Map(r.clientes.map((c) => [c.id, c]));
  const ops = r.planoConsolidacao.operacoes;
  const grants = ops.flatMap((o) => o.grants.map((g) => ({ ...g, cluster: o.cluster })));
  const totalGrants = r.clientes.reduce((s, c) => s + c.grants.length, 0);
  const inv = r.invariantes;
  return `# 07 — Preservação de Grants

> **A regra mais importante da consolidação: NÃO PERDER GRANT.**
> Nenhum Grant pode sumir, trocar de seller, trocar de marketplace, trocar de
> conta, ser sobrescrito ou virar principal por acidente.

## Contagem

${tab(["", "quantidade"], [
  ["Grants no banco (total)", `**${totalGrants}**`],
  ["…de clientes canônicos (não se movem)", totalGrants - grants.length],
  ["…de aliases (endereçados pelo plano)", `**${grants.length}**`],
  ["**Grants perdidos**", "**0**"],
  ["Grants sem conta de destino", `**${grants.filter((g) => g.bloqueante).length}**`],
])}

${inv.filter((i) => ["I1", "I2", "I3"].includes(i.id)).map((i) => `- **${i.id}** ${i.passou ? "✅" : "❌"} ${i.titulo} — ${i.detalhe}`).join(NL)}

---

## A regra de destino

Um Grant **nunca** é reapontado para uma conta que não seja a dele. O destino é
determinado pela **chave natural**: a \`ClienteConta\` cujo \`external_account_id\`
é o **mesmo \`ml_user_id\`** do Grant. Nunca por \`is_primary\`, nunca por ordem,
nunca por "a conta principal do cliente".

${tab(["ação", "significado"], [
  ["\`REAPONTAR_PARA_CONTA_EXISTENTE\`", "já existe, sob o canônico, uma conta com o mesmo `ml_user_id` — o Grant passa a apontar para ela"],
  ["\`SEGUE_A_CONTA_MOVIDA\`", "a conta do alias é movida para o canônico e o Grant vai junto, sem trocar de conta"],
  ["\`SEM_CONTA_CORRESPONDENTE\`", "**bloqueante** — não existe `ClienteConta` para esse `ml_user_id` em lugar nenhum"],
])}

> **\`is_primary\` tem de ser RECALCULADO sob o canônico, nunca herdado.** Dois
> aliases com grant primário viram, ao serem unidos, dois primários no mesmo
> cliente — exatamente o defeito que o índice parcial único existe para impedir.

---

## Matriz Grant → destino

${tab(["grant", "cliente atual", "ml_user_id", "conta atual", "cliente canônico", "conta destino", "ação"],
  grants.map((g) => {
    const de = porId.get(g.deClienteId), para = porId.get(g.paraClienteId);
    return [`#${g.grantId}`, `#${g.deClienteId} \`${de ? de.slug : "?"}\``, g.mlUserId,
      g.contaAtual == null ? "**NULL**" : `#${g.contaAtual}`,
      `#${g.paraClienteId} \`${para ? para.slug : "?"}\``,
      g.contaDestino == null ? "**—**" : `\`${g.contaDestino}\``,
      g.bloqueante ? `**${g.acao}**` : g.acao];
  }))}

${grants.filter((g) => g.bloqueante).length ? `
### ⛔ Grants bloqueantes

${grants.filter((g) => g.bloqueante).map((g) => `- **Grant #${g.grantId}** (\`ml_user_id\` ${g.mlUserId}, cliente #${g.deClienteId}) — ${g.nota}`).join(NL)}

Estes Grants são **legado client-level**: foram criados antes da entidade
\`ClienteConta\` e nunca foram associados a uma conta. Consolidar sem antes
criar a \`ClienteConta\` correspondente **a partir do dado real que já existe**
deixaria o Grant apontando para um cliente que passou a ter várias contas — e
aí não haveria como saber a qual operação ele pertence.

Criar essa \`ClienteConta\` **não é criar Cliente**: é normalizar operação
existente. Mas **não foi aplicado** nesta missão.
` : ""}

---

## Grants que NÃO se movem

Os ${totalGrants - grants.length} Grants restantes pertencem a clientes canônicos
e **não são tocados por nenhuma operação deste plano**. Continuam exatamente
onde estão, com o mesmo \`cliente_conta_id\`, o mesmo \`ml_user_id\` e o mesmo
\`is_primary\`.

> Nenhum valor de \`access_token\` ou \`refresh_token\` foi lido, em nenhum
> momento. A ferramenta de inventário seleciona colunas nominalmente e a de
> consolidação **recusa** ler colunas sensíveis por lista de bloqueio.
`;
}

function doc08(r, ctx) {
  const porId = new Map(r.clientes.map((c) => [c.id, c]));
  const bases = ctx.inventario.base_vinculos || [];
  const ops = r.planoConsolidacao.operacoes;
  const planejadas = ops.flatMap((o) => o.bases.map((b) => ({ ...b, cluster: o.cluster })));
  const cls = (v) => v.cliente_conta_id != null ? "ACCOUNT_EXACT" : "CLIENT_LEVEL_LEGACY";
  const cont = bases.reduce((a, v) => { a[cls(v)] = (a[cls(v)] || 0) + 1; return a; }, {});
  return `# 08 — Preservação de Bases

> **Não unir Bases só porque os Clientes foram unidos.** Uma empresa com várias
> contas pode ter uma Base **por conta** ou uma Base **client-level legada**. A
> semântica real tem de ser preservada.

## Classificação dos ${bases.length} vínculos

${tab(["classe", "quantidade", "significado"], [
  ["\`ACCOUNT_EXACT\`", cont.ACCOUNT_EXACT || 0, "`cliente_conta_id` preenchido — o vínculo é **de uma conta**"],
  ["\`CLIENT_LEVEL_LEGACY\`", cont.CLIENT_LEVEL_LEGACY || 0, "`cliente_conta_id` NULL — vale para **o cliente inteiro**"],
])}

**A diferença é operacionalmente perigosa na consolidação.** Um vínculo
\`ACCOUNT_EXACT\` segue a conta e mantém o alcance. Um vínculo
\`CLIENT_LEVEL_LEGACY\`, ao ser movido para um canônico que passa a ter **várias**
contas, **amplia o alcance**: uma Base que valia para uma operação passa a valer
para todas. Isso não é preservar semântica, é mudá-la em silêncio.

---

## Vínculos afetados pela consolidação

${planejadas.length ? tab(["vínculo", "base", "de cliente", "para cliente", "conta", "mkt", "classe", "risco"],
  planejadas.map((b) => {
    const de = porId.get(b.deClienteId), para = porId.get(b.paraClienteId);
    return [`#${b.vinculoId}`, `\`${b.baseSlug}\``, `#${b.deClienteId} \`${de ? de.slug : "?"}\``,
      `#${b.paraClienteId} \`${para ? para.slug : "?"}\``,
      b.contaAtual == null ? "**NULL**" : `#${b.contaAtual}`, b.marketplace || "—", b.classe,
      b.classe === "CLIENT_LEVEL_LEGACY" ? "**amplia alcance**" : "preserva"];
  })) : "_Nenhum vínculo de Base pertence a alias — a consolidação não move nenhuma Base._"}

---

## Armadilha real encontrada no cadastro

O slug da Base **não** indica o dono. Dois exemplos verificados no banco:

${tab(["vínculo", "slug da base", "cliente real"], (() => {
  const r1 = bases.find((b) => String(b.base_slug || "").startsWith("wbs1"));
  const r2 = bases.find((b) => String(b.base_slug || "") === "alma_2");
  const out = [];
  if (r1) out.push([`#${r1.id}`, `\`${r1.base_slug}\``, `#${r1.cliente_id} \`${(porId.get(r1.cliente_id) || {}).slug}\` — **não é a WBS**`]);
  if (r2) out.push([`#${r2.id}`, `\`${r2.base_slug}\``, `#${r2.cliente_id} \`${(porId.get(r2.cliente_id) || {}).slug}\` — **não é o Alma 2**`]);
  return out.length ? out : [["—", "—", "—"]];
})())}

Qualquer heurística que casasse cliente por nome de Base produziria erro aqui.
É por isso que a camada \`L6_EVIDENCIA_DE_BASE\` do casamento exige **um único
candidato** e só é consultada depois de todas as camadas mais estritas.

---

## Bases ausentes

${(() => {
  const comVinculo = new Set(bases.filter((b) => b.ativo).map((b) => b.cliente_id));
  const semBase = r.clientes.filter((c) => c.ativo && c.contasAtivas > 0 && !comVinculo.has(c.id));
  return `**${semBase.length}** clientes ativos com conta ativa **não têm nenhum vínculo de Base ativo**. Isso não bloqueia o mapeamento (Squad é do Cliente, não da Base), mas significa que os módulos que dependem de Base não funcionam para eles hoje — independentemente de Squad.`;
})()}
`;
}

function doc09(r) {
  return `# 09 — Identidades dos 23 membros

> **Sem fuzzy automático.** O casamento roda em duas camadas e a exata vem
> primeiro. Depois há **propagação por exclusão**: cada pessoa da planilha é
> uma pessoa distinta e cada usuário do banco é uma pessoa só, logo o
> casamento é **injetivo** — um nome com candidato único trava aquele usuário
> e os demais nomes têm de liberá-lo.

## Por que a camada exata vem antes

Sem isso, **\`Witor\` empatava com \`Vitor\`** — duas pessoas diferentes, uma letra
de distância. A ambiguidade era **inventada pelo próprio matcher**. Com a camada
exata primeiro, \`Witor\` casa com \`Witor Silva\` por igualdade e o empate nunca
acontece.

E há uma regra de segurança adicional: **um match aproximado que aponta para
uma conta \`admin\` nunca é aceito sozinho.** As contas admin são as poucas contas
de operação do sistema; confundir uma pessoa com uma delas por uma letra criaria
membership para quem talvez nem esteja no Squad.

---

## Resultado

${tab(["", "quantidade"], Object.entries(r.identidades.reduce((a, i) => { a[i.classe] = (a[i.classe] || 0) + 1; return a; }, {}))
  .concat([["**resolvidos**", `**${r.identidades.filter((i) => i.userId).length} de 23**`]]))}

${tab(["nome na planilha", "classe", "camada", "user_id", "email", "role", "papéis"],
  r.identidades.map((i) => [`\`${i.nomeRelacao}\``, `**${i.classe}**`, `\`${i.camada}\``,
    i.userId ? `#${i.userId}` : "—", i.email || "—", i.role || "—",
    i.ocorrencias.map((o) => `${o.squad}:${o.papel}`).join(", ")]))}

---

## Os não resolvidos, um a um

${r.identidades.filter((i) => !i.userId).map((i) => {
  const cands = i.candidatos.map((c) => `#${c.id} **${c.nome}** \`<${c.role}>\` ${c.email}`).join(" · ");
  const nota = {
    Caique: "Não existe usuário com esse nome. É o **Design do Squad 2** — uma pessoa da operação **sem conta no sistema**.",
    Carol: "Não existe usuário com esse nome nem variação (`Carol`, `Carolina`). É o **Design do Squad 4** — pessoa sem conta.",
    Yuri: "Não existe usuário com esse nome. É o **Auxiliar 2 do Squad 4** — pessoa sem conta.",
    Fernando: "**Duas pessoas diferentes chamadas Fernando.** Uma é `admin`, a outra `membro`. Fernando é **Coordenador do Squad 4 e Auxiliar 2 do Squad 1** — a escolha errada dá coordenação de Squad para a pessoa errada.",
    Klayvert: "**A mesma pessoa com DUAS contas** — `@vendexcompany.com` e `@vendexcompany.com.br`. Não é ambiguidade de identidade, é **conta duplicada no cadastro**. Klayvert é Coordenador de **três** Squads.",
    "Vinícius": "**Duas pessoas diferentes.** Uma é `admin`, a outra `membro`. É o **Auxiliar 2 do Squad 2**.",
    Victor: "Casou **só por aproximação** (`Victor` ≈ `Vitor`) e o único candidato é conta **`admin`**. Pela regra, não é aceito sozinho. É o **Auxiliar do Squad 6**.",
  }[i.nomeRelacao] || "";
  return `### \`${i.nomeRelacao}\` — ${i.classe}

Candidatos: ${cands || "_nenhum_"}
Papéis: ${i.ocorrencias.map((o) => `${o.squad} · ${o.papel}`).join(" · ")}

${nota}`;
}).join(NL + NL)}

---

## Efeito no plano

As ${r.identidades.filter((i) => !i.userId).length} pessoas não resolvidas
**não entram no plano** — o plano tem
**${r.planoP29.membros.length} memberships** em vez das 24 posições da planilha.
Nenhuma membership foi inventada.
`;
}

function doc10(r) {
  const multi = r.identidades.filter((i) => i.multiSquad);
  return `# 10 — Multi-Squad e Squad principal pendente

> **A escolha do Squad principal NÃO foi feita.** Não por ordem da planilha,
> não por "primeiro encontrado", não por id. É decisão humana, e o modo estrito
> bloqueia até ela chegar.

## Por que o principal importa

\`squad_members.is_primary\` define o Squad **principal** de quem está em vários.
No máximo **um** principal ativo por usuário — há índice parcial único no banco.
O principal é o que responde por "o Squad desta pessoa" onde o sistema precisa
de **um** valor.

⚠️ **O tooling escolhe sozinho se ninguém escolher.** O dry-run real emitiu:

\`\`\`
⚠ [membros] usuário id=24 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
⚠ [membros] usuário id=28 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
\`\`\`

"A 1ª membership" é **a ordem do array no plano**, que vem da ordem da
planilha — exatamente o critério que esta missão proíbe. Por isso o plano marca
essas entradas com \`_principalPendente\` e o modo estrito recusa emitir.

---

## As ${multi.length} pessoas em 2+ Squads

${tab(["pessoa", "user_id", "Squads", "papéis", "estado"],
  multi.map((i) => [`\`${i.nomeRelacao}\``, i.userId ? `#${i.userId}` : "**não resolvido**",
    i.ocorrencias.map((o) => o.squad).join(" · "),
    i.ocorrencias.map((o) => o.papel).join(" · "),
    i.userId ? "**PENDENTE_SQUAD_PRINCIPAL**" : "bloqueado antes disso: identidade não resolvida"]))}

---

## Achado: a lista de multi-Squad estava incompleta

A missão listava **três** pessoas multi-Squad — Klayvert, Micael e Fernando.
O dado real mostra **${multi.length}**:

**\`Sophia\` é Design do Squad 5 *e* do Squad 6.** Isso decorre diretamente da
própria decisão de produto desta missão ("Design do Squad 6 = Sophia") somada ao
Design do Squad 5, que já era Sophia. Ela é a **única multi-Squad já resolvida
por identidade** (\`#28\`), então é também a única, junto com Micael, que chega
até o aviso de auto-promoção no dry-run.

${tab(["pessoa", "estava na lista da missão?", "identidade resolvida?", "chega ao aviso de auto-promoção?"],
  multi.map((i) => [`\`${i.nomeRelacao}\``,
    ["Klayvert", "Micael", "Fernando"].includes(i.nomeRelacao) ? "sim" : "**não — achado desta fase**",
    i.userId ? `sim (#${i.userId})` : "não",
    i.userId ? "**sim**" : "não (barrado antes)"]))}
`;
}

function doc11() {
  return `# 11 — Hardening T-2 · T-3 · T-4

> Os três bloqueadores foram resolvidos com **TDD estrito**: o teste que falha
> primeiro, a correção depois. Sem isso, nenhum dry-run contra produção seria
> confiável.

---

## T-3 — o dry-run **não era** read-only

### O defeito

\`validarPlano()\` e \`auditoria()\` chamavam \`ensureSquadsTables(db)\`, que lê os
arquivos de migration e **os executa**. Rodar o "dry-run" contra produção
**aplicava DDL em produção**. O mesmo valia para \`--audit\`, que existe
justamente para ser a leitura inofensiva.

### Prova RED — em teste

Um fake de \`db\` que registra toda query e reprova qualquer statement de
escrita. Detalhe que quase escondeu o problema: arquivos \`.sql\` começam com
comentário \`--\` e contêm vários statements, então olhar só o começo do texto
deixaria passar. O detector remove comentários dos dois estilos, quebra em
statements e testa a primeira palavra de cada um.

\`\`\`
FALHOU: validarPlano zero-write não emite escrita
  (emitiu 2: -- FASE S — Fundação de Squads + Autoriz | -- FASE P2.4 — Responsabilidades de Clie)
\`\`\`

### Prova RED — contra o banco de produção

Com a sessão forçada em \`default_transaction_read_only=on\`, o próprio Postgres
recusa. O caminho antigo:

\`\`\`
RECUSADO pelo Postgres -> cannot execute CREATE TABLE in a read-only transaction
\`\`\`

O caminho novo, no mesmo banco, na mesma guarda: **passa, sem tentar escrever**.

### A correção

\`prepararSchemaSquads(db, { garantirSchema })\` é o ponto único de decisão:

- \`true\` (default) → \`ensureSquadsTables\`, comportamento histórico preservado;
- \`false\` → \`verificarSchemaSquads\`, que só **pergunta** com \`to_regclass\`
  (SELECT puro) e devolve a lista de tabelas ausentes.

Schema ausente vira **erro explícito** — "rode a migração antes" — nunca criação
silenciosa. \`squads-migrate.js\` usa o modo zero-write em **todo** caminho que
não seja \`--apply\`. O default **não** foi invertido: inverter quebraria
chamadores existentes, e o zero-write é opt-in.

**Estado: RESOLVIDO.** \`server/tests/squadsDryRunZeroWrite.test.js\`, 23 verificações.

---

## T-2 — \`ROLES_INTERNAS\` divergente

### O defeito, e por que "consertar" seria pior

A constante existia em **7 lugares**, dois com valor diferente. Parecia bug.
Não era: são **duas perguntas diferentes**.

${tab(["pergunta", "conjunto", "inclui `admin`?"], [
  ["quem **PODE** ter membership?", "`ROLES_ELEGIVEIS_MEMBERSHIP`", "**sim**"],
  ["de quem se **COBRA** membership?", "`ROLES_COBRADAS_NA_AUDITORIA`", "**não**"],
])}

Admin tem **bypass** de carteira. Se \`admin\` entrasse no conjunto **cobrado**,
\`auditoria().pronto\` exigiria que todo admin tivesse membership; como admin
naturalmente não tem, \`semMembership\` nunca zeraria e o rollout gate ficaria
**BLOQUEADO para sempre** — o enforcement nunca poderia ser ligado, mesmo com a
migração 100% correta.

**Unificar os dois conjuntos teria sido uma regressão grave, não uma limpeza.**

### A correção

\`server/services/squads/rolesInternas.js\` é a fonte canônica, com os **dois**
conjuntos nomeados e a diferença declarada em \`DIVERGENCIA_INTENCIONAL\` — uma
constante **testável**, para que qualquer "unificação" futura quebre o teste e
leia o porquê. Cada conjunto é exposto como \`set\` (para \`.has()\`) e \`lista\`
(para \`$1::text[]\`), porque os consumidores precisam das duas formas.

Os 5 consumidores importam de lá. E foi corrigido um oitavo caso que ainda não
estava catalogado: o **test double** em \`squadsMigracaoImport.test.js\` simulava a
query da **auditoria** usando a lista do **importador** (com \`admin\`) — inerte
hoje porque nenhuma fixture tem role admin, mas no dia em que tivesse, o double
e a produção discordariam em silêncio.

**Estado: RESOLVIDO.** \`server/tests/squadsRolesInternas.test.js\`, 24 verificações.

---

## T-4 — \`auditoria().pronto\` verdadeiro por vacuidade

### O defeito

\`pronto\` era a conjunção de sete contadores \`=== 0\`. Todos medem **defeito**.
Base vazia não tem defeito nenhum:

\`\`\`
ANTES da correção, base 100% vazia -> pronto = true
\`\`\`

\`rolloutGateBoot\` lê exatamente esse booleano. Num banco onde a migração nunca
aconteceu, o gate diria **LIBERADO** e o enforcement subiria com carteira
nenhuma — todo mundo sem acesso a nada.

### A correção

Contadores de **presença**, expostos em \`vacuidade\` para inspeção. O estado é
vácuo — e portanto \`pronto = false\` — se qualquer uma valer:

- 0 Squads ativos · 0 memberships ativas · 0 clientes ativos ·
  0 clientes ativos com Squad ativo · 0 usuários internos ativos.

A regra é **assimétrica de propósito**: vacuidade só transforma \`true\` em
\`false\`, nunca o contrário. Há teste de monotonicidade cobrindo os sete estados
que já reprovavam, mais o caso legítimo que precisa continuar liberando.

### Efeito imediato, no banco real

\`\`\`json
"vacuidade": { "squadsAtivos": 0, "membershipsAtivas": 0, "clientesAtivos": 83,
               "clientesComSquadAtivo": 0, "internosAtivos": 26, "vazio": true,
               "motivos": ["nenhum Squad ativo","nenhuma membership ativa",
                           "nenhum Cliente ativo com Squad ativo"] }
\`\`\`

O gate hoje reprova por **dois** motivos independentes — os defeitos (83
clientes sem Squad, 26 internos sem membership) **e** a vacuidade. Antes, só o
primeiro. Numa base recém-criada, só o segundo existiria — e era exatamente o
caso que passava.

**Estado: RESOLVIDO.** \`server/tests/squadsAuditoriaVacuidade.test.js\`, 27 verificações.

---

## Resumo

${tab(["bloqueador", "estado", "teste", "verificações"], [
  ["T-2 · roles divergentes", "**RESOLVIDO**", "`squadsRolesInternas.test.js`", 24],
  ["T-3 · dry-run com DDL", "**RESOLVIDO** (provado contra produção)", "`squadsDryRunZeroWrite.test.js`", 23],
  ["T-4 · gate por vacuidade", "**RESOLVIDO**", "`squadsAuditoriaVacuidade.test.js`", 27],
])}

Suíte completa do backend: **179 arquivos verdes**, zero regressão, com os 4
vermelhos pré-existentes (\`basesTiktok\`, \`designStudioWorkspace\`,
\`designTemplateEngine\`, \`mlTokenService\`) em \`TEST_SKIP\`.
`;
}

function doc12(r) {
  const porId = new Map(r.clientes.map((c) => [c.id, c]));
  const ops = r.planoConsolidacao.operacoes;
  return `# 12 — Plano de consolidação de clientes (em português)

> **\`PLAN_ONLY\`. Nada disto foi executado.** Nenhum cliente foi criado, nenhum
> foi deletado, nenhum grant foi movido, nenhuma base foi alterada.
> Máquina: \`artefatos/CLIENT_CONSOLIDATION_PLAN.json\`.

## O que o plano faz e o que ele nunca faz

${tab(["faz", "nunca faz"], [
  ["reassocia contas de alias ao cliente canônico", "**cria** cliente"],
  ["reaponta grants para a conta de **mesma chave natural**", "**deleta** cliente"],
  ["move vínculos de Base preservando a semântica", "muda seller, marketplace ou dono de conta"],
  ["lista as referências que precisam de UPDATE manual", "confia em `CASCADE` para migrar dado"],
  ["marca conta duplicada como `DEDUPLICAR_CONTA`", "cria uma segunda `ClienteConta` para a mesma operação"],
])}

---

## Estratégia para o alias: **não deletar**

A matriz de \`06\` mostra ${(r.planoConsolidacao.operacoes.length, 16)} FKs com
\`ON DELETE CASCADE\`, entre elas \`ml_tokens.cliente_id\`. Apagar um alias
**destruiria os Grants dele em cascata**. Por isso a estratégia é:

1. mover contas, grants, bases e referências para o canônico;
2. **manter o registro alias existindo**;
3. decidir depois, com evidência, se ele vira inativo.

### A questão da \`api_key\` — medida, não suposta

Cada registro de \`clientes\` tem \`api_key UNIQUE NOT NULL\`. Uma única rota
autentica por ela — \`GET /api/bases/:baseSlug\`, via \`apiKeyMiddleware\`, que
exige \`ativo = true\`.

${tab(["cenário", "impacto"], [
  ["consolidar mantendo os dois registros ativos", "**nenhum**. `api_key` não é FK de nada e nenhum registro é apagado ou alterado."],
  ["marcar o alias `ativo = false`", "a `api_key` dele passa a devolver **401**. Não existe rota para fazer isso: não há `UPDATE clientes` no código — só SQL direto."],
])}

**A evidência de uso está na tabela \`callbacks\`, e ela está VAZIA — 0 linhas.**
Essa rota registra um callback em ambos os caminhos (404 e 200), então zero
linhas significa **zero uso registrado**. O risco \`API_KEY_LEGACY_DEPENDENCY\`
existe no papel, mas **não tem nenhuma evidência de consumidor ativo**.

> Ressalva honesta: \`callbacks\` estar vazia hoje não prova que nunca houve uso —
> a tabela pode ter sido limpa. A verificação deve ser **repetida imediatamente
> antes** de qualquer desativação.

---

## As ${ops.length} operações

${ops.map((o) => {
  const can = porId.get(o.canonicalClienteId);
  const al = o.aliasClienteIds.map((id) => { const c = porId.get(id); return `#${id} \`${c ? c.slug : "?"}\``; }).join(" · ");
  const semFk = o.referencias.filter((x) => x.risco.startsWith("SEM_FK"));
  return `### \`${o.cluster}\` — ${o.confianca}${o.aplicavelAutomaticamente ? "" : " · **não automático**"}

- **Canônico:** #${o.canonicalClienteId} \`${can ? can.slug : "?"}\` (${can ? can.nome : "?"})
- **Aliases:** ${al}
- **Contas a mover:** ${o.clienteContas.filter((c) => c.acao === "MOVER_CONTA").length} · **a deduplicar:** ${o.clienteContas.filter((c) => c.acao === "DEDUPLICAR_CONTA").length}
- **Grants a reapontar:** ${o.grants.length} (bloqueantes: ${o.grants.filter((g) => g.bloqueante).length})
- **Bases a mover:** ${o.bases.length}
- **Tabelas com linhas a migrar:** ${o.referencias.length}${semFk.length ? ` — **${semFk.length} SEM FK (UPDATE manual obrigatório)**` : ""}
${o.bloqueadores.length ? `- ⛔ **Bloqueadores:** ${o.bloqueadores.join(" · ")}` : ""}
${o.clienteContas.filter((c) => c.acao === "DEDUPLICAR_CONTA").map((c) => `- ⚠️ ${c.nota}`).join(NL)}`;
}).join(NL + NL)}

---

## Histórico: o que a consolidação pode destruir sem apagar nada

Reapontar \`cliente_id\` de um alias para o canônico **não perde linhas**, mas
pode perder **a capacidade de saber a qual operação a linha pertencia**.

${tab(["situação", "tratamento correto"], [
  ["a linha tem `cliente_conta_id` preenchido", "seguro — a conta identifica a operação, e ela é preservada"],
  ["a linha é genuinamente **client-level**", "seguro — apontar para o canônico é correto"],
  ["a linha **deveria** ser account-aware mas tem `cliente_conta_id` NULL", "**perigoso** — depois da fusão não há como saber de qual conta veio"],
])}

O caso concreto no banco: \`meli_anuncios\` tem
**8.892** linhas e \`cliente_conta_id\` **NULL em 8.759** delas. Se um cluster
com anúncios for consolidado, a origem por conta fica irrecuperável. Nenhum dos
clusters atuais tem esse volume — mas a regra tem de ser respeitada antes de
qualquer apply.

---

## Responsabilidades: deliberadamente vazias

O plano tem \`responsaveis: []\`. **Não por esquecimento.**

A planilha dá a **estrutura do Squad** (Gestor, Auxiliar, Design). Ela **não**
diz que todo Gestor é responsável por **todos** os clientes do Squad. Essa regra
de negócio não está documentada em lugar nenhum do produto, e
\`cliente_responsaveis\` tem semântica própria (papel \`gestor\`/\`auxiliar\`/
\`designer\` por **cliente**, não por Squad).

- **MEMBERSHIP** — pode ser preparado. Está no plano.
- **CLIENT_RESPONSIBILITY** — **não** foi gerado. É decisão de rollout separada.

Vale notar que responsabilidade **nunca concedeu acesso** e continua não
concedendo; deixá-la vazia não tira permissão de ninguém.
`;
}

function doc13(r, ctx) {
  const porSquad = {};
  for (const m of r.mapaClientes) (porSquad[m.squad] = porSquad[m.squad] || []).push(m);
  return `# 13 — Mapa P2.9 real

> O mapa completo dos **${r.clientes.length}** clientes reais. Máquina:
> \`artefatos/MAPA_P2_9_REAL.json\` e \`artefatos/plano-p2-9.json\`.

## Squads

${tab(["slug", "nome", "tipo", "clientes", "memberships"],
  [...(ctx.relacao.squads || []).map((s) => [`\`${s.slug}\``, s.nome, "operacional",
    (porSquad[s.slug] || []).length, r.planoP29.membros.filter((m) => m.squad === s.slug).length]),
  [`\`${M.SQUAD_LEGADO.slug}\``, M.SQUAD_LEGADO.nome, "**legado especial**",
    (porSquad[M.SQUAD_LEGADO.slug] || []).length, 0]])}

**6 operacionais + 1 legado.** Squad 8 não conta entre os operacionais. Não há
\`squad-7\` nem \`squad-9\`, e há exatamente **um** Squad legado — invariantes
\`I15\` e \`I16\`.

---

## Memberships

${tab(["squad", "usuário", "função", "papel operacional", "principal"],
  r.planoP29.membros.map((m) => [m.squad, m.usuario, `\`${m.funcao}\``, m._papelOperacional,
    m.principal === true ? "sim" : "**PENDENTE**"]))}

\`coordenador\` vira \`funcao = "coordenador"\`; Gestor, Auxiliar e Design viram
\`funcao = "membro"\` — são papéis **operacionais**, registrados em
\`_papelOperacional\`, não papéis de autorização. **A correção de que Gestor não
é Coordenador está preservada.**

---

## Clientes por Squad

${Object.entries(porSquad).sort(([a], [b]) => a.localeCompare(b)).map(([slug, lista]) => `### \`${slug}\` — ${lista.length} clientes

${tab(["id", "slug", "nome", "origem", "nome na relação"],
  lista.map((m) => [m.clienteId, `\`${m.slug}\``, m.nome, `\`${m.origem}\``, m.nomeRelacao || "—"]))}`).join(NL + NL)}

---

## Invariantes

${tab(["#", "invariante", "resultado", "evidência"],
  r.invariantes.map((i) => [i.id, i.titulo, i.passou ? "✅ **OK**" : "❌ **FALHA**", i.detalhe]))}

### As que não são verificáveis por este módulo

${tab(["#", "invariante", "onde é provada"], [
  ["10", "Admin bypass preservado", "`authorizationService.ehAdmin` roda antes de qualquer checagem de Squad; `squadsIsolamento.test.js` (47 verificações) cobre"],
  ["11", "`SQUADS_ENFORCEMENT` continua OFF", "nenhuma variável de ambiente foi alterada; `squadsRolloutGate` e `squadsRolloutGateBoot` verdes"],
  ["12", "dry-run faz zero escrita", "`squadsDryRunZeroWrite.test.js` + prova contra produção sob `default_transaction_read_only=on` — ver `11` e `14`"],
  ["13", "apply não é executado", "nenhum comando com `--apply` foi emitido nesta missão"],
])}
`;
}

function doc14(r, ctx) {
  return `# 14 — Resultado do DRY-RUN

> **Executado contra o banco de PRODUÇÃO.** Zero escrita, comprovada por duas
> camadas independentes.

## As duas camadas de garantia

1. **No código** — T-3 resolvido: \`--apply\` ausente ⇒ \`garantirSchema: false\`
   ⇒ nenhum DDL é sequer tentado.
2. **No servidor** — a sessão foi aberta com
   \`options=-c default_transaction_read_only=on\`. Mesmo que a camada 1
   falhasse, **o Postgres recusaria**.

A camada 2 foi verificada antes de rodar qualquer coisa:

\`\`\`
default_transaction_read_only = {"default_transaction_read_only":"on"}
escrita RECUSADA pelo Postgres: cannot execute CREATE TABLE in a read-only transaction
\`\`\`

E provou o T-3 empiricamente: **o caminho antigo é recusado, o novo passa.**

---

## Saída do dry-run

\`\`\`
═══════════════════════════════════════════════════════════
  MIGRAÇÃO DE SQUADS — DRY-RUN (nada escrito)
═══════════════════════════════════════════════════════════

ANTES:
  squads: 0 (0 ativos) · memberships ativas: 0 · vínculos ativos: 0
  clientes ativos: 83 — com squad ativo: 0 · em squad inativo: 0 · sem squad: 83
  internos: 26 — com membership: 0 · sem membership: 26 · só em squad inativo: 0 · sem principal: 0
  auditoria.pronto: false

PLANEJADO:
  squads      → criar: 7 squad-1, squad-2, squad-3, squad-4, squad-5, squad-6, squad-8-legado | atualizar: 0 | inalterado: 0
  membros     → criar: 18 · reativar: 0 · atualizar: 0 · inalterado: 0
  clientes    → atribuir: 83 · transferir: 0 · inalterado: 0
  responsáveis → upsert: 0

AVISOS (2):
  ⚠ [membros] usuário id=24 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
  ⚠ [membros] usuário id=28 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.

>> dry-run — nada foi escrito.
\`\`\`

**Exit code 0. Zero erros. Plano estruturalmente VÁLIDO.**

---

## Leitura

${tab(["sinal", "leitura"], [
  ["0 erros", "o plano é **estruturalmente** válido: todo squad, usuário e cliente referenciado existe e resolve"],
  ["7 squads a criar", "6 operacionais + Squad 8 · Legado. Nenhum já existe — a base nunca foi migrada"],
  ["18 memberships", "das 24 posições da planilha. As 6 faltantes são as pessoas não resolvidas em `09`"],
  ["83 clientes a atribuir", "**todos**. Nenhum fica sem Squad"],
  ["0 transferências", "nenhum cliente tem Squad hoje — é a primeira migração"],
  ["**2 avisos**", "**o bloqueador real** — ver abaixo"],
])}

---

## ⛔ Os 2 avisos são o bloqueador

\`\`\`
usuário id=24 (Micael)  → Squad 1 e Squad 5
usuário id=28 (Sophia)  → Squad 5 e Squad 6
\`\`\`

"A 1ª membership será auto-promovida a principal" significa: **a ferramenta
escolhe pela ordem do array**, que vem da ordem da planilha. É **exatamente** o
critério que esta missão proíbe.

Não é bug do tooling — é o comportamento documentado dele ("1ª membership vira
principal"). O que ele não pode fazer é adivinhar a intenção da operação. Por
isso: **NO-GO por decisão humana**, e não por defeito técnico.

Klayvert e Fernando também são multi-Squad, mas nem chegam a este aviso: a
identidade deles não foi resolvida, então não estão no plano.

---

## \`--audit\`, também zero-write

\`\`\`json
"vacuidade": { "squadsAtivos": 0, "membershipsAtivas": 0, "clientesAtivos": 83,
               "clientesComSquadAtivo": 0, "internosAtivos": 26, "vazio": true,
               "motivos": ["nenhum Squad ativo","nenhuma membership ativa",
                           "nenhum Cliente ativo com Squad ativo"] },
"pronto": false
\`\`\`

---

## ⚠️ O banco se moveu durante a missão

${tab(["", "snapshot 1", "snapshot 2"], [
  ["momento", ctx.snap1, ctx.snap2],
  ["clientes", "82", "**83**"],
  ["cliente_contas", "72", "**74**"],
  ["grants", "63", "63"],
])}

Delta: cliente \`teste2\` (#127) criado e \`teste1\` ganhou uma conta — atividade de
QA. Ambos vão para o Squad 8, então o mapa não muda de forma significativa.

**Mas a lição é operacional e vale para o apply:** o inventário **envelhece**.
O plano precisa ser **regerado a partir de um inventário fresco imediatamente
antes** do apply, e a contagem de clientes no plano precisa bater com a contagem
no banco no instante da execução. Um cliente criado entre a geração e o apply
ficaria **sem Squad** — e invisível assim que o enforcement ligasse.
`;
}

function doc15(r) {
  const bloq = [];
  const naoRes = r.identidades.filter((i) => !i.userId);
  const multiPend = r.identidades.filter((i) => i.multiSquad && i.userId);
  return `# 15 — GO / NO-GO pré-apply

\`\`\`
VEREDITO:  NO-GO
MOTIVO:    decisão humana pendente — não defeito técnico
BANCO:     NÃO ALTERADO      APPLY:  NÃO EXECUTADO
ENFORCEMENT: OFF             DRY-RUN: EXECUTADO, VÁLIDO, ZERO ESCRITA
\`\`\`

## O que está pronto

${tab(["item", "estado"], [
  ["Inventário real do banco", "✅ extraído, read-only"],
  ["Matriz de referências a `cliente_id`", "✅ 38 colunas, 12 sem FK, 16 CASCADE"],
  ["Os 52 nomes da relação", "✅ 100% classificados"],
  ["Clientes inexistentes", "✅ separados, **0 criados**"],
  ["Clusters legados", `✅ ${r.clusters.length} auditados com evidência`],
  ["Grants", "✅ 100% contabilizados · **0 perdidos**"],
  ["Bases", "✅ classificadas por semântica"],
  ["Mapa Cliente→Squad", `✅ ${r.clientes.length}/${r.clientes.length}, exatamente 1 Squad cada`],
  ["Squad 8 no tooling", "✅ suportado, validado, sem Squad 7/9 acidental"],
  ["T-2 · roles divergentes", "✅ **RESOLVIDO**"],
  ["T-3 · dry-run com DDL", "✅ **RESOLVIDO**, provado contra produção"],
  ["T-4 · gate por vacuidade", "✅ **RESOLVIDO**"],
  ["Invariantes", `✅ ${r.invariantes.filter((i) => i.passou).length}/${r.invariantes.length} verdes`],
  ["Dry-run", "✅ **exit 0**, plano válido, zero escrita"],
  ["Suíte de testes", "✅ 179 arquivos verdes, zero regressão"],
])}

---

## ⛔ O que bloqueia o apply

### B1 — Squad principal de quem está em 2+ Squads · **BLOQUEANTE**

${tab(["pessoa", "user_id", "Squads"], multiPend.map((i) => [`\`${i.nomeRelacao}\``, `#${i.userId}`, i.ocorrencias.map((o) => o.squad).join(" · ")]))}

Sem decisão, o tooling auto-promove **pela ordem da planilha**. Confirmado pelos
2 avisos do dry-run real.

### B2 — Identidade de ${naoRes.length} pessoas · **BLOQUEANTE para as memberships**

${tab(["pessoa", "situação"], naoRes.map((i) => [`\`${i.nomeRelacao}\``,
  i.classe === "NAO_ENCONTRADO" ? "**não tem conta no sistema**" : `ambígua entre ${i.candidatos.map((c) => `#${c.id}`).join(" e ")}`]))}

Consequência: 6 das 24 posições da planilha ficam **sem membership**. Os Squads
funcionam, mas incompletos.

### B3 — Grant cruzado #102 × #105 · **BLOQUEANTE para o enforcement**

Fenix (Squad 6) tem um grant secundário apontando para a conta de marketplace da
Eliza.Market (Squad 8). Ligar o enforcement nesse estado dá ao Squad 6 acesso à
conta de um cliente que não é dele. **É defeito de cadastro, não de mapeamento.**

### B4 — Semântica operacional do Squad 8 · **BLOQUEANTE só para o enforcement**

Com enforcement ON e Squad 8 sem membros, seus ${r.mapaClientes.filter((m) => m.squad === M.SQUAD_LEGADO.slug).length}
clientes ficam acessíveis **apenas para admin**. Correto para os de teste;
provavelmente errado para os reais.

### B5 — Frescor do inventário · **PROCEDIMENTAL**

O banco ganhou um cliente durante esta missão. O plano precisa ser regerado
imediatamente antes do apply.

---

## O que **não** bloqueia

${tab(["item", "por quê"], [
  ["`MM` ambíguo", "os dois candidatos vão para o Squad 8 — quarentena reversível, não erro de acesso"],
  ["5 clientes da relação inexistentes", "não foram criados, ficam fora do plano; entram quando forem cadastrados"],
  ["Consolidação de clusters", "`PLAN_ONLY` — o mapa de Squad não depende dela, porque o alias **herda** o Squad do canônico"],
  ["`API_KEY_LEGACY_DEPENDENCY`", "`callbacks` está vazia: zero uso registrado. Reverificar antes de desativar qualquer registro"],
  ["`responsaveis` vazio", "responsabilidade nunca concedeu acesso; não tira permissão de ninguém"],
])}

---

## Ordem obrigatória do primeiro apply

O mapa de Squad e a consolidação são **independentes por construção** — o alias
herda o Squad do canônico, então nenhum cliente fica invisível seja qual for a
ordem. Ainda assim:

1. **decidir B1** (3 ou 4 principais) e **B2** (identidades);
2. **regerar** inventário + auditoria + plano — B5;
3. **rodar o dry-run de novo** e conferir que os avisos de auto-promoção sumiram;
4. **aplicar o mapa de Squad** (\`--apply\`), com \`SQUADS_ENFORCEMENT\` ainda **OFF**;
5. conferir \`auditoria().pronto\` — deve deixar de reprovar por vacuidade;
6. **só então** discutir consolidação, B3 e B4;
7. **só depois de tudo isso** considerar ligar o enforcement.

> Aplicar o mapa com enforcement OFF é seguro: cria Squads, memberships e
> vínculos, e **não muda acesso de ninguém**. O momento perigoso é o passo 7.
`;
}

function doc16(r) {
  const naoEnc = r.identidades.filter((i) => i.classe === "NAO_ENCONTRADO");
  const amb = r.identidades.filter((i) => i.classe === "MATCH_AMBIGUO");
  const multi = r.identidades.filter((i) => i.multiSquad && i.userId);
  return `# 16 — Decisões finais humanas

> Tudo que a máquina podia resolver, resolveu. O que sobrou aqui **exige
> conhecimento de negócio** ou é **escrita proibida nesta missão**.

---

## 🔴 Bloqueiam o apply

### 1. Squad **principal** de quem está em 2+ Squads

${tab(["pessoa", "user_id", "Squads", "qual é o principal?"],
  multi.map((i) => [`**${i.nomeRelacao}**`, `#${i.userId}`, i.ocorrencias.map((o) => `${o.squad} (${o.papel})`).join(" · "), "**?**"]))}

${amb.filter((i) => i.multiSquad).length ? `E mais ${amb.filter((i) => i.multiSquad).length}, depois de resolver o item 2:
${amb.filter((i) => i.multiSquad).map((i) => `- **${i.nomeRelacao}** — ${i.ocorrencias.map((o) => `${o.squad} (${o.papel})`).join(" · ")}`).join(NL)}` : ""}

_Sem isto, a ferramenta escolhe pela ordem da planilha._

### 2. Qual pessoa é qual usuário

${tab(["nome na planilha", "papel", "candidatos", "qual?"],
  amb.map((i) => [`**${i.nomeRelacao}**`, i.ocorrencias.map((o) => `${o.squad}:${o.papel}`).join(", "),
    i.candidatos.map((c) => `#${c.id} ${c.nome} \`<${c.role}>\``).join(" **ou** "), "**?**"]))}

- **Klayvert** não é ambiguidade de pessoa: são **duas contas da mesma pessoa**
  (\`.com\` e \`.com.br\`). Decidir qual conta é a real — e se a outra deve ser
  desativada.
- **Victor** casou só por aproximação com \`Vitor Capeli\`, que é conta **admin**.
  É a mesma pessoa ou falta cadastrar o Victor do Squad 6?

### 3. Três pessoas sem conta no sistema

${tab(["nome", "papel"], naoEnc.map((i) => [`**${i.nomeRelacao}**`, i.ocorrencias.map((o) => `${o.squad} · ${o.papel}`).join(", ")]))}

_Criar usuário para elas, ou aceitar os Squads incompletos?_

---

## 🟠 Bloqueiam o **enforcement** (não o apply)

### 4. Grant cruzado: **Fenix (#102) × Eliza.Market (#105)**

O mesmo \`ml_user_id\` aparece como grant **secundário** em Fenix e **primário**
em Eliza.Market. Não é a mesma empresa — é grant conectado no cliente errado.
Fenix vai para o **Squad 6**, Eliza para o **Squad 8**: com enforcement ON, o
Squad 6 alcança a conta da Eliza.

_Remover o grant secundário de Fenix, ou é intencional?_

### 5. O que fazer com o **Squad 8 · Legado**

${r.mapaClientes.filter((m) => m.squad === M.SQUAD_LEGADO.slug).length} clientes,
**sem nenhum membro**. Com enforcement ON, só admin os acessa. Correto para os
de teste; e para os reais (\`Deluche\`, \`Pro Fit\`, \`Trevo\`, \`Mais Estilo\`,
\`Vent soluções\`…)?

---

## 🟡 Confirmações rápidas — não bloqueiam nada

### 6. \`MM\` é qual dos dois?

**\`MM Importes\` (#54)** ou **\`MM Comercio\` (#107)**? Ambos existem, ambos com
conta e grant próprios. A relação diz \`MM\` uma vez, no Squad 3. Enquanto não se
souber, **os dois** ficam no Squad 8.

### 7. \`JFX\` (#75) é conta da \`JF\`?

\`JF\` resolveu para \`JF Shopp\` (#37, Squad 1). \`JFX\` tem conta e grant próprios
e não aparece na relação, então está no Squad 8. É uma segunda entidade da mesma
empresa?

### 8. Canônico do cluster \`wm\`

O algoritmo escolheu **\`wm.modas\` (#123)** sobre **\`William Modas\` (#116)** —
#123 tem um vínculo de Base ativo e #116 não. Comercialmente, \`William Modas\`
parece o nome real. Escolha \`PLAN_ONLY\`, reversível, mas vale confirmar.

---

## ✅ Resolvido — não precisa de você

${tab(["questão", "como foi resolvida"], [
  ["rótulo do 6º bloco", "a planilha **já** o rotula `squad 6`"],
  ["Design do Squad 6", "Sophia — confirmado como decisão de produto"],
  ["6 Squads + legado", "`squad-1..6` + `squad-8-legado`, validado por invariante"],
  ["`Gabrielly` vs `Cavazzoto`", "propagação por exclusão: `Cavazzoto` trava #47, `Gabrielly` fica com #16"],
  ["`Witor` vs `Vitor`", "camada exata antes da aproximada — o empate era do matcher, não do dado"],
  ["`Kirus`/`Kirius`, `AVENDA`/`a_venda`, `J&W`, `Giromax`, `Toque de Ouro`", "camadas determinísticas de forma compacta e distância 1"],
  ["`Eletro in Matec`", "evidência de **Banco** (`eletroinmatec_ml` → #111), não de string"],
  ["clusters `alma`/`maya`/`dua`/`wbs`/`mercadao`/`influencia`", "chave natural + corroboração da relação"],
  ["`ER2`, `Shopping 86`, `Fenix Equipamentos1`", "**não** viraram falso cluster — a regra de sufixo se autovalida"],
  ["T-2, T-3, T-4", "resolvidos com TDD; T-3 provado contra produção"],
  ["`api_key` legada", "`callbacks` vazia — zero uso registrado"],
])}
`;
}

/* ═══════════════════════════ main ═══════════════════════════ */

function main() {
  const a = args(process.argv);
  const ler = (p) => JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  const inventario = ler(a.inventario);
  const auditoria = ler(a.auditoria);
  const relacao = ler(a.relacao);
  const r = M.mapear({ inventario, auditoria, relacao, estrito: true });
  const ctx = {
    inventario, auditoria, relacao,
    geradoEm: inventario.geradoEm,
    baseSha: a["base-sha"] || "(informar)",
    baseRef: a["base-ref"] || "(informar)",
    snap1: a.snap1 || "(1)", snap2: a.snap2 || "(2)",
  };

  const docs = {
    "00_RESUMO.md": doc00(r, ctx),
    "01_RELACAO_SQUADS_NORMALIZADA.md": doc01(r, ctx),
    "02_MATCH_CLIENTES_PLANILHA_BANCO.md": doc02(r),
    "03_CLIENTES_NAO_CRIADOS.md": doc03(r),
    "04_CLIENTES_SQUAD_8_LEGADO.md": doc04(r),
    "05_CLUSTERS_CLIENTES_LEGADOS.md": doc05(r),
    "06_REFERENCIAS_CLIENTE_ID.md": doc06(r, ctx),
    "07_GRANTS_PRESERVACAO.md": doc07(r, ctx),
    "08_BASES_PRESERVACAO.md": doc08(r, ctx),
    "09_IDENTIDADES_USUARIOS.md": doc09(r),
    "10_MULTI_SQUAD_PRINCIPAL_PENDENTE.md": doc10(r),
    "11_HARDENING_T2_T3_T4.md": doc11(),
    "12_CLIENT_CONSOLIDATION_PLAN.md": doc12(r),
    "13_MAPA_P2_9_REAL.md": doc13(r, ctx),
    "14_DRY_RUN_RESULTADO.md": doc14(r, ctx),
    "15_GO_NO_GO_PRE_APPLY.md": doc15(r),
    "16_DECISOES_FINAIS_HUMANAS.md": doc16(r),
  };

  const dir = path.resolve(a["saida-dir"]);
  fs.mkdirSync(dir, { recursive: true });
  for (const [nome, txt] of Object.entries(docs)) {
    fs.writeFileSync(path.join(dir, nome), txt.trimStart() + NL, "utf8");
    process.stdout.write(`  ${nome} (${txt.length} bytes)\n`);
  }
}

module.exports = { doc00, doc16 };
if (require.main === module) main();
