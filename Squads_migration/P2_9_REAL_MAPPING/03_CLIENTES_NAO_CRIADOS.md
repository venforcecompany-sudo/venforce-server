# 03 — Clientes da relação que NÃO existem no banco

> **REGRA ABSOLUTA CUMPRIDA: nenhum cliente foi criado.**
> Estas entradas ficam **fora** do plano aplicado agora. Quando o cliente for
> criado, ele poderá ser vinculado ao Squad correspondente.

## 5 nomes sem cliente correspondente

| nome | squad esperado | status | motivo / o que foi tentado |
|---|---|---|---|
| `GS` | squad-2 | **RELACAO_SEM_CLIENTE_CRIADO** | todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato |
| `ADS` | squad-3 | **RELACAO_SEM_CLIENTE_CRIADO** | todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato |
| `MW` | squad-3 | **RELACAO_SEM_CLIENTE_CRIADO** | todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato |
| `Nikolly Fashion` | squad-4 | **RELACAO_SEM_CLIENTE_CRIADO** | todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato |
| `Thiago Moreno` | squad-5 | **RELACAO_SEM_CLIENTE_CRIADO** | todas as 10 camadas de casamento foram aplicadas e nenhuma produziu candidato |

### Notas por caso

- **`GS`** e **`ADS`** — duas e três letras. Não existe cliente com esse token.
  `ADS` **não** é `ADB Supply` (#21), que já está alocado ao Squad 2.
- **`MW`** — não existe cliente com o token `mw`. **Não confundir com `MWM`**
  (#9), que a própria relação aloca ao **Squad 2**, e nem com `WM` (Squad 4),
  que é outro nome na mesma planilha. Três tokens parecidos, três destinos
  diferentes — motivo pelo qual nenhum deles é resolvido por aproximação.
- **`Nikolly Fashion`** e **`Thiago Moreno`** — nomes longos e distintos, sem
  nada próximo no cadastro. São clientes que a operação atende e que **ainda não
  foram cadastrados**.

---

## 1 nome ambíguo — também fora do plano

| nome | squad | candidatos | por quê |
|---|---|---|---|
| `MM` | squad-3 | #107 `mm_comercio` (1 conta, 1 grant) · #54 `mm_importes` (1 conta, 1 grant) | a camada L4_PREFIXO_DE_TOKENS encontrou 2 candidatos de empresas distintas — resolver por máquina seria adivinhar |

Ambíguo **não** vira palpite: os candidatos caem no **Squad 8 · Legado**, que é
quarentena reversível. Resolver isso é decisão humana — ver `16`.

---

## Efeito no total

|  | quantidade |
|---|---|
| Nomes na relação | 52 |
| Resolvidos para cliente real | 46 |
| Não existem (não criados) | **5** |
| Ambíguos (não decididos) | **1** |
| **Clientes criados por esta missão** | **0** |

