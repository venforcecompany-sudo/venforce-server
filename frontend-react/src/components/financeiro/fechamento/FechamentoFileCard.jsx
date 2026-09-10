// frontend-react/src/components/financeiro/fechamento/FechamentoFileCard.jsx
//
// Card de upload compacto — substitui o "[Escolher arquivo] Nenhum arquivo
// escolhido" nativo. Vazio: dropzone com arraste/clique. Preenchido: nome +
// tamanho + trocar/remover. Denso o suficiente para caberem lado a lado num
// desktop corporativo.
//
// O <input type="file"> real fica visualmente escondido mas continua
// associado ao <label> (acessibilidade + testes por getByLabelText).

import { useRef, useState } from "react";
import { cx } from "../../../utils/cx.js";

const ACCEPT = ".xlsx,.xls,.csv";
const FORMATOS = ".xlsx · .xls · .csv";

function tamanhoLegivel(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FechamentoFileCard({ rotulo, obrigatoriedade, descricao, file, aviso, onPick }) {
  const inputRef = useRef(null);
  const [arrastando, setArrastando] = useState(false);
  const abrir = () => inputRef.current?.click();

  const badge =
    obrigatoriedade === "obrigatorio"
      ? { texto: "Obrigatório", classe: "is-danger" }
      : obrigatoriedade === "recomendado"
        ? { texto: "Recomendado", classe: "is-info" }
        : { texto: "Opcional", classe: "is-neutral" };

  function aoSoltar(e) {
    e.preventDefault();
    setArrastando(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) onPick(dropped);
  }

  if (file) {
    return (
      <div className={cx("vf-fin-file", "has-file", aviso && "is-invalid")}>
        <div className="vf-fin-file__head">
          <span className="vf-fin-file__rotulo">{rotulo}</span>
          <span className={cx("vf-tag", badge.classe)}>{badge.texto}</span>
        </div>
        <div className="vf-fin-file__filled">
          <span className="vf-fin-file__check" aria-hidden="true">✓</span>
          <span className="vf-fin-file__name" title={file.name}>{file.name}</span>
          <span className="vf-fin-file__size">{tamanhoLegivel(file.size)}</span>
          <span className="vf-fin-file__acoes">
            <button type="button" className="vf-btn vf-btn--ghost vf-btn--sm" onClick={abrir}>
              Trocar
            </button>
            <button
              type="button"
              className="vf-btn vf-btn--icon vf-btn--ghost vf-btn--sm"
              aria-label={`Remover ${rotulo}`}
              onClick={() => onPick(null)}
            >
              ×
            </button>
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="vf-visually-hidden"
          accept={ACCEPT}
          aria-label={rotulo}
          onChange={(e) => onPick(e.target.files?.[0] || null)}
        />
      </div>
    );
  }

  return (
    <div className={cx("vf-fin-file", aviso && "is-invalid")}>
      <div className="vf-fin-file__head">
        <span className="vf-fin-file__rotulo">{rotulo}</span>
        <span className={cx("vf-tag", badge.classe)}>{badge.texto}</span>
      </div>
      <div
        role="button"
        tabIndex={0}
        className={cx("vf-fin-file__drop", arrastando && "is-dragover")}
        onClick={abrir}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrir(); }
        }}
        onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
        onDragLeave={() => setArrastando(false)}
        onDrop={aoSoltar}
      >
        <span className="vf-fin-file__prompt">
          Arraste o arquivo aqui ou <span className="vf-fin-file__link">selecionar arquivo</span>
        </span>
        <span className="vf-fin-file__formatos">{FORMATOS}</span>
      </div>
      {descricao && <p className="vf-fin-file__descricao">{descricao}</p>}
      {aviso && <p className="vf-fin-file__aviso">⚠ {aviso}</p>}
      <input
        ref={inputRef}
        type="file"
        className="vf-visually-hidden"
        accept={ACCEPT}
        aria-label={rotulo}
        onChange={(e) => onPick(e.target.files?.[0] || null)}
      />
    </div>
  );
}
