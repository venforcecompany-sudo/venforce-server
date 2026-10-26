# Vídeo tutorial — Anúncios ML

Gera um vídeo de ~3 minutos (1080p) mostrando cada funcionalidade da página
`Portal/anuncios-meli.html`, usando a tela real do Portal com dados de
demonstração (cliente fictício "Casa Bella Utilidades").

```bash
node tools/video-tutorial-anuncios/tour.js
# → tools/video-tutorial-anuncios/out/tutorial-anuncios-ml.mp4
```

- `server.js` — serve a pasta `Portal/` localmente.
- `mock.js` — responde às chamadas da API (`venforce-server.onrender.com`) com
  dados de demonstração; nenhuma requisição chega ao servidor real.
- `tour.js` — roteiro: cursor, cliques, destaques e legendas de cada etapa.

Se a tela mudar, rode de novo para regravar. Para mudar o texto ou a ordem das
etapas, edite as chamadas `cap(...)` em `tour.js`.

Etapas: contexto (cliente/operação) · sincronização · indicadores como filtro ·
busca · ordenação · colunas da lista · famílias · custo pontual · edição de
custos em massa / importar planilha · Radar de subsídios · detalhe do anúncio
(score, fotos, composição da margem, simulação de promoção, IA para título,
descrição e ficha técnica, marcar como revisado).
