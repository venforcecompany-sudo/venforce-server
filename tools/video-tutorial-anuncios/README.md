# Vídeos tutoriais do Portal

Vídeos curtos (1080p, legendados em português) que mostram uma página REAL
do Portal sendo usada: cursor animado, destaques e uma legenda por etapa.
O backend é trocado por dados de demonstração (cliente fictício "Casa Bella
Utilidades"); nenhuma requisição chega ao servidor real.

| Tela | Roteiro | Backend falso | Duração | Página publicada |
|---|---|---|---|---|
| Anúncios ML (`anuncios-meli.html`) | `tour.js` | `mock.js` | 3min05s | https://claude.ai/artifact/LHW542zXZ4T4Fw3ny4XsUn |
| Financeiro (`financeiro-v3.html`) | `tour-financeiro.js` | `financeiro-mock.js` | 2min13s | https://claude.ai/artifact/RqGGzQeMD4GQe8EBdnGb66 |

```bash
node tools/video-tutorial-anuncios/tour.js             # Anúncios ML
node tools/video-tutorial-anuncios/tour-financeiro.js  # Financeiro
```

Saída em `out/<nome>/` (ignorado pelo git): o MP4 e `capitulos.json` com o
segundo em que cada legenda numerada aparece. Requer Playwright (Chromium) e
ffmpeg. Cada gravação leva o tempo real do vídeo + ~2 min de encode.

## Arquivos

- `server.js` — serve `Portal/` localmente.
- `gravador.js` — `gravar({ nome, caminho, rotear, prontoQuando, role, roteiro })`:
  overlay (cursor, clique, destaque, legenda, cartão de abertura/fechamento),
  captura quadro a quadro e encode. O `roteiro` recebe `page` e os helpers
  `go, click, hl, hlOff, cap, capOff, card, scrollTo, scrollToEl, digitar, wait`.
- `*-mock.js` — `rotear(page)`: responde às rotas de
  `venforce-server.onrender.com` (e às imagens de `http2.mlstatic.com`).
- `tour*.js` — o roteiro de cada tela.
- `pagina/modelo.html` — página do player com botão de download e etapas
  clicáveis (placeholders `{{TELA}}`, `{{SUBTITULO}}`, `{{ARQUIVO}}`,
  `{{DURACAO}}`, `{{TAMANHO}}`, `{{ETAPAS}}`).

`tour.js` (Anúncios) é anterior ao `gravador.js` e ainda tem a própria cópia
do overlay; telas novas devem usar o `gravador.js`.

## Como fazer o vídeo de uma tela nova

1. **Achar a página e os contratos.** Ver qual HTML o menu abre
   (`Portal/vf-shell.js`, lista de módulos; para MELI pode haver
   `rotaPorMarketplace`). Telas React carregam o bundle de
   `Portal/assets/<tela>/` — o bundle do disco é o que aparece no vídeo, então
   trazer o `main` atualizado antes de gravar. As fixtures dos testes de UI
   (`Portal/*-ui.test.js`) já têm o formato de cada endpoint: copiar de lá.
2. **Backend falso** (`<tela>-mock.js`): sempre responder `/me/context`,
   `/operacao/cliente-360/clientes` e `/clientes/:slug/contas` (o Shell
   precisa deles), mais as rotas da tela. Dados realistas e coerentes entre si
   (contagens dos filtros batendo com as linhas, nomes de produto variados).
   Rota sem mock devolve 404 e a tela mostra erro — procurar no
   `services/*Api.js` toda rota que a tela chama.
3. **Explorar antes de gravar:** screenshots de cada estado (página inteira,
   cada drawer/modal) para achar seletores e erros de dados. É mais rápido que
   gravar e descobrir no vídeo.
4. **Roteiro** (`tour-<tela>.js`): abertura com `card`, uma legenda `cap("N", …)`
   por etapa (o número vira capítulo), destaque com `hl` no que a legenda cita,
   fechamento com `card` de resumo. Legenda curta, voz ativa, dizendo o que o
   usuário faz e o que acontece. Dar ~1 s de tela por 3 palavras de legenda.
5. **Gravar e revisar:** rodar, depois montar uma folha de quadros
   (`ffmpeg -i x.mp4 -vf "fps=1/4,scale=480:-1,tile=4x4" folha.png`) e
   conferir legendas, destaques e se nada ficou fora do lugar.
6. **Publicar:** copiar `pagina/modelo.html`, preencher os placeholders
   (etapas com os tempos de `capitulos.json`), gerar uma capa
   (`ffmpeg -ss 40 -i x.mp4 -frames:v 1 -vf scale=1280:-1 capa.jpg`) e
   publicar como Artifact com `files` (MP4 + capa) e
   `capabilities: {downloads: true}`. Atualizar a tabela acima.

## O que aprendemos (não repetir)

- **Qualidade:** o `recordVideo` do Playwright grava VP8 a ~750 kbps e borra
  o texto. O gravador usa screencast JPEG + `deviceScaleFactor: 1.2`
  (1920×1080 nativo) e x264 `-crf 22 -preset veryslow -tune stillimage`.
- **Tamanho:** cada arquivo de uma página Artifact tem limite de 15 MB. ~3 min
  nesse formato dá ~12–13 MB. Se passar, subir o CRF um ponto.
- **Download:** o envio de arquivo pelo chat não funcionou para a usuária;
  o caminho que funciona é a página Artifact com o botão de download
  (capability `downloads`). Links `<a download>` não funcionam dentro dela.
- **Mostrar o fluxo que o usuário de fato vê.** Ex.: no Financeiro, logo após
  processar, "Ver e corrigir" abre uma gaveta de pendências que a equipe
  nunca usa; com o fechamento salvo, "Ver produtos" rola até o filtro
  "Sem custo" com "+ Custo". O roteiro salva, recarrega e mostra o segundo.
  Na dúvida, perguntar como a equipe usa a tela antes de gravar.
- **Só o vídeo muda:** ajustes pedidos para o vídeo não mexem no código do
  Portal, a menos que peçam explicitamente.
- `select` nativo não abre em headless: mostrar a troca com `selectOption`.
- `Ctrl+A` fora de um campo seleciona a página inteira (aparece tudo azul).
- `page.reload()` no meio do roteiro funciona: o overlay volta sozinho e a
  captura continua.

## Pedidos já atendidos

- Anúncios ML: Radar de subsídios precisa dizer que, antes de analisar, se
  escolhe a promoção de referência e só os anúncios dela são analisados.
- Financeiro: mostrar a página inteira; pendências pelo filtro "Sem custo";
  drawer Detalhes na versão nova (PR #360).
