import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const layoutPath = fileURLToPath(new URL("../../Portal/layout.js", import.meta.url));
let conteudo = await readFile(layoutPath, "utf8");

const href = "central-executiva-react.html";

if (!conteudo.includes(`href: "${href}"`)) {
  const ancoraLink = '{ label: "Cliente 360 V2", href: "cliente-360-react.html", icon: "users" },';
  const novoLink = `${ancoraLink}\n        { label: "Central Executiva", href: "${href}", icon: "bar-chart", adminOnly: true },`;

  if (!conteudo.includes(ancoraLink)) {
    throw new Error("[patch-layout] âncora da Cliente 360 V2 não encontrada em Portal/layout.js");
  }
  conteudo = conteudo.replace(ancoraLink, novoLink);
}

if (!conteudo.includes(`"${href}": "operacao"`)) {
  const ancoraGrupo = '"cliente-360-react.html": "operacao",';
  const novoGrupo = `${ancoraGrupo}\n    "${href}": "operacao",`;

  if (!conteudo.includes(ancoraGrupo)) {
    throw new Error("[patch-layout] mapeamento da Cliente 360 V2 não encontrado em Portal/layout.js");
  }
  conteudo = conteudo.replace(ancoraGrupo, novoGrupo);
}

await writeFile(layoutPath, conteudo, "utf8");
console.log("[patch-layout] Central Executiva registrada na sidebar compartilhada");
