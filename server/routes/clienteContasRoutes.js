// server/routes/clienteContasRoutes.js
// Fundação de Contas do Marketplace (Fase 1) — cliente → cliente_conta.
//
// Leitura de metadados operacionais (cliente, conta, marketplace, ml_user_id,
// token_status, is_primary, base associada, ativo/inativo) fica disponível
// às roles internas (admin/user/membro), mesmo padrão de
// requireAutomacoesAccess usado em métricas/automações/Cliente 360 — para
// que Ads, Anúncios, Financeiro e Central de Margem possam reaproveitar
// esta API sem exigir admin só para ler. Nenhum destes endpoints retorna
// access_token/refresh_token (ver services/clienteContas/clienteContaService.js
// — cliente_contas nunca guarda tokens).
//
// Mutações (criar/editar/ativar/desativar/tornar principal/vincular base/
// desconectar grant) continuam admin-only.

const express = require("express");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const {
  requireClienteNaCarteira,
  requireClienteContaNaCarteira,
} = require("../middlewares/carteiraMiddleware");
const controller = require("../controllers/clienteContasController");

const router = express.Router();

// P2.1 — para rotas por ID de conta: resolve conta → cliente → carteira.
// "A conta veio da lista autorizada" era premissa do frontend, não
// enforcement; contra URL/id manipulado não vale.
const contaNaCarteira = requireClienteContaNaCarteira("id");


// Leitura das contas de um cliente: além do gate de role, autorização real
// por carteira (V3 S4) — 403 CLIENTE_FORA_DA_CARTEIRA para cliente fora do
// Squad do usuário interno. Admin e seller (seller_clientes) inalterados.
router.get(
  "/clientes/:cliente/contas",
  authMiddleware,
  requireAutomacoesAccess,
  requireClienteNaCarteira("cliente"),
  controller.listar
);

router.post(
  "/clientes/:cliente/contas",
  authMiddleware,
  requireAdmin,
  controller.criar
);

router.get(
  "/cliente-contas/:id",
  authMiddleware,
  requireAutomacoesAccess,
  contaNaCarteira,
  controller.obter
);

router.patch(
  "/cliente-contas/:id",
  authMiddleware,
  requireAdmin,
  contaNaCarteira,
  controller.atualizar
);

router.patch(
  "/cliente-contas/:id/principal",
  authMiddleware,
  requireAdmin,
  contaNaCarteira,
  controller.definirPrincipal
);

router.get(
  "/cliente-contas/:id/base",
  authMiddleware,
  requireAutomacoesAccess,
  contaNaCarteira,
  controller.obterBase
);

router.get(
  "/cliente-contas/:id/bases-elegiveis",
  authMiddleware,
  requireAutomacoesAccess,
  contaNaCarteira,
  controller.basesElegiveis
);

router.put(
  "/cliente-contas/:id/base",
  authMiddleware,
  requireAdmin,
  contaNaCarteira,
  controller.vincularBase
);

router.delete(
  "/cliente-contas/:id/ml-grant",
  authMiddleware,
  requireAdmin,
  contaNaCarteira,
  controller.desconectarMlGrant
);

module.exports = router;
