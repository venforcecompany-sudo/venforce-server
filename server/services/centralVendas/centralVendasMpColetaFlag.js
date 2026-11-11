// server/services/centralVendas/centralVendasMpColetaFlag.js
//
// Controle explícito da coleta automática de Mercado Pago Payments/charges
// (MP1) durante o Sync da Central de Vendas.
//
//   CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED
//     ausente / "true" / qualquer outro valor → coleta LIGADA (comportamento
//                                               anterior, sem mudança no deploy)
//     "false" / "0" / "off" / "no"            → coleta DESLIGADA
//
// Desligada, o Sync:
//   - NÃO chama api.mercadopago.com /v1/payments;
//   - NÃO grava central_vendas_mp_payments / central_vendas_mp_payment_charges;
//   - registra a fonte "payments" do run como `not_applicable`, com
//     metadata_json.motivo = MOTIVO_COLETA_DESLIGADA (evidência por run, para
//     a conciliação dizer "coleta desligada" e não "pendente"/zero).
// Pedidos, itens, componentes, margem, fechamento e completude do run
// (payments nunca esteve em REQUIRED_SOURCES_BASE) não mudam.
//
// A flag é lida a CADA run (não no require), para que a reversão seja só
// trocar a env e reiniciar — e para os testes alternarem sem recarregar módulos.
// Histórico já gravado nunca é apagado por esta flag.

const ENV_NAME = "CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED";
const MOTIVO_COLETA_DESLIGADA = "MP_PAYMENTS_COLETA_DESLIGADA";
const VALORES_DESLIGADO = new Set(["false", "0", "off", "no", "nao", "não"]);

function isColetaPaymentsMpHabilitada(env = process.env) {
  const raw = env[ENV_NAME];
  if (raw == null) return true;
  return !VALORES_DESLIGADO.has(String(raw).trim().toLowerCase());
}

module.exports = {
  ENV_NAME,
  MOTIVO_COLETA_DESLIGADA,
  isColetaPaymentsMpHabilitada,
};
