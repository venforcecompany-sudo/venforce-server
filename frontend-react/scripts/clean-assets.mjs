import { rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const alvos = [
  "../../Portal/assets/cliente-360-react",
  "../../Portal/assets/frontend-react",
].map((caminho) => fileURLToPath(new URL(caminho, import.meta.url)));

for (const alvo of alvos) {
  await rm(alvo, { recursive: true, force: true });
  console.log(`[clean-assets] limpo: ${alvo}`);
}
