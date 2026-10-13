// frontend-react/src/hooks/useAssinaturaArquivos.js
//
// sha256 dos arquivos escolhidos, NO NAVEGADOR (crypto.subtle) — o mesmo
// hash que o servidor grava no manifesto do snapshot. Serve ao pré-check
// para avisar "é o MESMO arquivo do mês passado" antes de processar.
// Indisponível (contexto inseguro, navegador antigo) = sem aviso, nunca erro.

import { useEffect, useState } from "react";

// File.arrayBuffer() onde existe; FileReader nos demais (navegador antigo, jsdom).
function lerBytes(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  if (typeof FileReader === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsArrayBuffer(file);
  });
}

async function sha256DoArquivo(file) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !file) return null;
  const bytes = await lerBytes(file);
  if (!bytes) return null;
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function useAssinaturaArquivos(arquivos) {
  const [assinaturas, setAssinaturas] = useState({});
  useEffect(() => {
    let vivo = true;
    const campos = Object.entries(arquivos || {}).filter(([, f]) => f);
    Promise.all(campos.map(async ([campo, f]) => [campo, await sha256DoArquivo(f).catch(() => null)])).then((pares) => {
      if (vivo) setAssinaturas(Object.fromEntries(pares));
    });
    return () => {
      vivo = false;
    };
  }, [arquivos]);
  return assinaturas;
}
