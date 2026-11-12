// server/routes/financeiroVisaoRoutes.js
// Montado em server/index.js: app.use("/financeiro", financeiroVisaoRoutes).
// Não confundir com /fechamentos (fechamentosFinanceiroRoutes.js — fluxo de
// upload/processamento, intocado).
const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteNaCarteira } = require("../middlewares/carteiraMiddleware");
const controller = require("../controllers/financeiroVisaoController");

const router = express.Router();

// Planilha de custos opcional do fechamento pela API (custosOrigem=upload):
// mesmo armazenamento e limite do upload de custos do fechamento por planilha.
// Sem multipart, o multer só repassa (o JSON continua aceito).
const uploadCustos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
}).fields([{ name: "costs", maxCount: 1 }]);

// Erro do multer no envelope do fechamento pela API ({ ok:false, error, code }),
// não no handler global (que responde com `erro`).
function receberPlanilhaCustos(req, res, next) {
  uploadCustos(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: "A planilha de custos passa de 20 MB.", code: "CUSTOS_ARQUIVO_GRANDE" });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, error: `Erro no upload: ${err.message}`, code: "UPLOAD_INVALIDO" });
    }
    return next(err);
  });
}

// Autorização real por carteira (V3 S4).
router.get("/:cliente", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.financeiro);
// Campo ADS do Fechamento — investimento do Mercado Ads da conta na competência.
router.get("/:cliente/ads", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.ads);
// Campo FULL do Fechamento — armazenagem, coleta e retirada do Full no faturamento do ML.
router.get("/:cliente/full", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.full);
// Foto dos produtos da lista (Mercado Livre), lida da base do sync de Anúncios ML.
router.get("/:cliente/miniaturas", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.miniaturas);
// Fechamento pela API do Mercado Livre (Central de Vendas, sem planilha):
// status do sync da competência e geração do resultado. Leitura pura.
// O POST aceita JSON ou multipart (planilha de custos no campo `costs`); a
// carteira usa o :cliente da URL, então o multer pode vir depois dela.
router.get("/:cliente/fechamento-api/status", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.fechamentoApiStatus);
router.post("/:cliente/fechamento-api", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), receberPlanilhaCustos, controller.fechamentoApi);

module.exports = router;
