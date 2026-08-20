# Central Executiva de Contas

Página React da carteira VenForce, construída sobre a Fundação Global V2.

## Fonte dos números

A página não replica matemática financeira no navegador. O endpoint
`GET /operacao/cliente-360/carteira/resultado` agrega o contrato oficial de
`cliente360ResultadoService` para cada conta ativa.

## Leitura executiva

- fechamento operacional e resultado após Ads;
- variação contra a competência comparada;
- saúde e prioridade da conta;
- principal causa vinda da ponte operacional;
- potencial de recuperação comprovável;
- confiança e receita bloqueada;
- ações operacionais registradas e crédito apurado;
- acesso direto à Cliente 360 V2.

## Build

```bash
cd frontend-react
npm ci
npm test
npm run build
```

O build é multi-entry e publica:

- `Portal/cliente-360-react.html`;
- `Portal/central-executiva-react.html`;
- assets em `Portal/assets/frontend-react/`.

Antes do Vite, `scripts/patch-layout.mjs` registra a Central Executiva na
sidebar compartilhada de forma idempotente.
