# 16 — Decisões finais humanas

> Tudo que a máquina podia resolver, resolveu. O que sobrou aqui **exige
> conhecimento de negócio** ou é **escrita proibida nesta missão**.

---

## 🔴 Bloqueiam o apply

### 1. Squad **principal** de quem está em 2+ Squads

| pessoa | user_id | Squads | qual é o principal? |
|---|---|---|---|
| **Micael** | #24 | squad-1 (coordenador) · squad-5 (coordenador) | **?** |
| **Sophia** | #28 | squad-5 (design) · squad-6 (design) | **?** |

E mais 2, depois de resolver o item 2:
- **Fernando** — squad-1 (auxiliar2) · squad-4 (coordenador)
- **Klayvert** — squad-2 (coordenador) · squad-3 (coordenador) · squad-6 (coordenador)

_Sem isto, a ferramenta escolhe pela ordem da planilha._

### 2. Qual pessoa é qual usuário

| nome na planilha | papel | candidatos | qual? |
|---|---|---|---|
| **Fernando** | squad-1:auxiliar2, squad-4:coordenador | #5 Fernando Salgado `<admin>` **ou** #45 Fernando Montoro `<membro>` | **?** |
| **Klayvert** | squad-2:coordenador, squad-3:coordenador, squad-6:coordenador | #22 Klayvert Rodrigues `<user>` **ou** #35 Klayvert Rodrigues `<user>` | **?** |
| **Victor** | squad-6:auxiliar | #6 Vitor Capeli `<admin>` | **?** |
| **Vinícius** | squad-2:auxiliar2 | #29 Vinicius Bergo `<admin>` **ou** #44 Vinicius Dias `<membro>` | **?** |

- **Klayvert** não é ambiguidade de pessoa: são **duas contas da mesma pessoa**
  (`.com` e `.com.br`). Decidir qual conta é a real — e se a outra deve ser
  desativada.
- **Victor** casou só por aproximação com `Vitor Capeli`, que é conta **admin**.
  É a mesma pessoa ou falta cadastrar o Victor do Squad 6?

### 3. Três pessoas sem conta no sistema

| nome | papel |
|---|---|
| **Caique** | squad-2 · design |
| **Carol** | squad-4 · design |
| **Yuri** | squad-4 · auxiliar2 |

_Criar usuário para elas, ou aceitar os Squads incompletos?_

---

## 🟠 Bloqueiam o **enforcement** (não o apply)

### 4. Grant cruzado: **Fenix (#102) × Eliza.Market (#105)**

O mesmo `ml_user_id` aparece como grant **secundário** em Fenix e **primário**
em Eliza.Market. Não é a mesma empresa — é grant conectado no cliente errado.
Fenix vai para o **Squad 6**, Eliza para o **Squad 8**: com enforcement ON, o
Squad 6 alcança a conta da Eliza.

_Remover o grant secundário de Fenix, ou é intencional?_

### 5. O que fazer com o **Squad 8 · Legado**

26 clientes,
**sem nenhum membro**. Com enforcement ON, só admin os acessa. Correto para os
de teste; e para os reais (`Deluche`, `Pro Fit`, `Trevo`, `Mais Estilo`,
`Vent soluções`…)?

---

## 🟡 Confirmações rápidas — não bloqueiam nada

### 6. `MM` é qual dos dois?

**`MM Importes` (#54)** ou **`MM Comercio` (#107)**? Ambos existem, ambos com
conta e grant próprios. A relação diz `MM` uma vez, no Squad 3. Enquanto não se
souber, **os dois** ficam no Squad 8.

### 7. `JFX` (#75) é conta da `JF`?

`JF` resolveu para `JF Shopp` (#37, Squad 1). `JFX` tem conta e grant próprios
e não aparece na relação, então está no Squad 8. É uma segunda entidade da mesma
empresa?

### 8. Canônico do cluster `wm`

O algoritmo escolheu **`wm.modas` (#123)** sobre **`William Modas` (#116)** —
#123 tem um vínculo de Base ativo e #116 não. Comercialmente, `William Modas`
parece o nome real. Escolha `PLAN_ONLY`, reversível, mas vale confirmar.

---

## ✅ Resolvido — não precisa de você

| questão | como foi resolvida |
|---|---|
| rótulo do 6º bloco | a planilha **já** o rotula `squad 6` |
| Design do Squad 6 | Sophia — confirmado como decisão de produto |
| 6 Squads + legado | `squad-1..6` + `squad-8-legado`, validado por invariante |
| `Gabrielly` vs `Cavazzoto` | propagação por exclusão: `Cavazzoto` trava #47, `Gabrielly` fica com #16 |
| `Witor` vs `Vitor` | camada exata antes da aproximada — o empate era do matcher, não do dado |
| `Kirus`/`Kirius`, `AVENDA`/`a_venda`, `J&W`, `Giromax`, `Toque de Ouro` | camadas determinísticas de forma compacta e distância 1 |
| `Eletro in Matec` | evidência de **Banco** (`eletroinmatec_ml` → #111), não de string |
| clusters `alma`/`maya`/`dua`/`wbs`/`mercadao`/`influencia` | chave natural + corroboração da relação |
| `ER2`, `Shopping 86`, `Fenix Equipamentos1` | **não** viraram falso cluster — a regra de sufixo se autovalida |
| T-2, T-3, T-4 | resolvidos com TDD; T-3 provado contra produção |
| `api_key` legada | `callbacks` vazia — zero uso registrado |

