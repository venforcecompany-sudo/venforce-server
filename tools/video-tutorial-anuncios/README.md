# Vídeos tutoriais do Portal

Gera vídeos (1080p) mostrando cada funcionalidade de uma página do Portal,
usando a tela real com dados de demonstração (cliente fictício "Casa Bella
Utilidades"). Nenhuma requisição chega ao servidor real.

```bash
node tools/video-tutorial-anuncios/tour.js             # Anúncios ML (~3 min)
node tools/video-tutorial-anuncios/tour-financeiro.js  # Financeiro (~2 min)
```

Saída em `out/` (MP4 + `capitulos.json` com o instante de cada etapa).
Requer Playwright (Chromium) e ffmpeg.

- `server.js` — serve a pasta `Portal/` localmente.
- `gravador.js` — cursor, cliques, destaques, legendas, captura quadro a
  quadro (screencast do Chromium) e encode do MP4.
- `mock.js` / `financeiro-mock.js` — respondem às chamadas da API
  (`venforce-server.onrender.com`) com dados de demonstração.
- `tour.js` / `tour-financeiro.js` — o roteiro de cada página.

Se a tela mudar, rode de novo para regravar. Para mudar o texto ou a ordem das
etapas, edite as chamadas `cap(...)` do roteiro.

**Anúncios ML:** contexto (cliente/operação) · sincronização · indicadores
como filtro · busca · ordenação · colunas da lista · famílias · custo pontual ·
custos em massa / importar planilha · Radar de subsídios (promoção de
referência) · detalhe do anúncio (score, fotos, margem, simulação de promoção,
IA para título, descrição e ficha técnica, revisado).

**Financeiro:** competência · painel das 6 etapas · preparar (base de custos,
planilha de vendas, ajustes com ADS do Mercado Ads) · processar · resultado e
indicadores · da receita ao resultado · detalhes e conciliação Mercado Pago ·
produtos (busca, filtros, composição) · pendências de custo · salvar,
publicar e apresentação · Histórico e Relatórios.
