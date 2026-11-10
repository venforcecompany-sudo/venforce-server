// frontend-react/src/components/financeiro/fechamento/OrigemVendas.jsx
//
// Peças do modo API do Fechamento (Mercado Livre), que moram no drawer
// "Preparar fechamento":
//   · OrigemVendas      — o controle "API do Mercado Livre | Planilha de vendas"
//                         e a confirmação de troca quando há trabalho em andamento;
//   · SincronizacaoVendas — o estado do sync do mês + "Sincronizar agora" (admin).
// Os custos do modo API (base do sync, base atual ou planilha) ficam em
// CustosModoApi.jsx.
//
// Nenhum número é calculado aqui. A tela só mostra o que o backend devolveu.

import { VFButton } from "../../ui/VFButton/index.js";
import { formatarDataHora } from "../../../utils/dates.js";

const OPCOES = [
  { id: "api", rotulo: "API do Mercado Livre" },
  { id: "planilha", rotulo: "Planilha de vendas" },
];

const ROTULO_ORIGEM = { api: "API do Mercado Livre", planilha: "Planilha de vendas" };

// "2026-10-31" → "31/10" (data de cobertura: só o dia/mês importam na tela).
function diaMes(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ""));
  return m ? `${m[3]}/${m[2]}` : null;
}

export function OrigemVendas({ valor, onChange, pendente, onConfirmar, onCancelar }) {
  return (
    <section className="vf-stack vf-stack--sm">
      <h4 className="vf-fin-mesa__rotulo-grupo">Origem das vendas</h4>
      <div className="vf-segmented" role="group" aria-label="Origem das vendas">
        {OPCOES.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`vf-segmented__item${valor === o.id ? " is-active" : ""}`}
            aria-pressed={valor === o.id}
            onClick={() => onChange(o.id)}
          >
            {o.rotulo}
          </button>
        ))}
      </div>
      {pendente && (
        <div className="vf-banner is-warning vf-banner--compact" role="alertdialog" aria-label="Confirmar troca de origem">
          <div className="vf-banner__content">
            <p className="vf-banner__description">
              Trocar para <strong>{ROTULO_ORIGEM[pendente]}</strong> descarta o arquivo escolhido e o resultado processado. Os
              ajustes digitados ficam. Continuar?
            </p>
            <div className="vf-cluster">
              <VFButton variant="danger" size="sm" onClick={onConfirmar}>
                Trocar e limpar
              </VFButton>
              <VFButton variant="ghost" size="sm" onClick={onCancelar}>
                Manter {ROTULO_ORIGEM[valor]}
              </VFButton>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function SincronizacaoVendas({ statusApi, sincronizacao, periodoLabel, admin }) {
  const { status, sync, sincronizado, runEmAndamento, erro } = statusApi;

  if (status === "carregando" || status === "inativo") {
    return (
      <div className="vf-fin-base is-carregando">
        <span className="vf-spinner vf-spinner--sm" aria-hidden="true" />
        <span className="vf-fin-base__texto">Verificando os dados sincronizados…</span>
      </div>
    );
  }

  if (status === "erro") {
    return (
      <p className="vf-field__hint" role="alert">
        Não foi possível verificar os dados sincronizados. {erro?.message || ""}
      </p>
    );
  }

  const ocupado = sincronizacao.emAndamento || !!runEmAndamento;
  const ate = diaMes(sync?.coberturaAte);

  return (
    <div className={`vf-fin-base ${sincronizado ? "is-encontrada" : "is-ausente"}`}>
      <div className="vf-fin-base__principal">
        <span className="vf-fin-base__marca" aria-hidden="true">{sincronizado ? "✓" : "!"}</span>
        <div className="vf-fin-base__corpo">
          <p className="vf-fin-base__titulo">
            {sincronizado ? "Vendas sincronizadas da API do Mercado Livre" : "Mês ainda não sincronizado"}
          </p>
          <p className="vf-fin-base__detalhe">
            {sincronizado
              ? `Dados até ${ate || "—"}${sync?.publicadoEm ? ` · publicado em ${formatarDataHora(sync.publicadoEm)}` : ""}`
              : `Sincronize ${periodoLabel} para fechar pela API.`}
          </p>
          {sincronizado && sync?.completo === false && (
            <p className="vf-fin-base__nota">
              Cobertura incompleta{sync.motivoIncompleto ? `: ${sync.motivoIncompleto}` : "."}
            </p>
          )}
          {ocupado && (
            <p className="vf-fin-base__nota" role="status">Sincronizando pedidos via API do Mercado Livre…</p>
          )}
          {sincronizacao.fase === "concluido" && !ocupado && (
            <p className="vf-fin-base__nota" role="status">Sincronização concluída.</p>
          )}
          {sincronizacao.erro && (
            <p className="vf-field__hint" role="alert">{sincronizacao.erro}</p>
          )}
        </div>
      </div>
      {admin ? (
        <VFButton size="sm" variant="ghost" disabled={ocupado} onClick={() => sincronizacao.iniciar()}>
          Sincronizar agora
        </VFButton>
      ) : (
        <p className="vf-field__hint">Só um administrador sincroniza a Central. Peça para sincronizar o mês.</p>
      )}
    </div>
  );
}
