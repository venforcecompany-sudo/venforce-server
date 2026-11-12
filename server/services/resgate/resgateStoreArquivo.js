// server/services/resgate/resgateStoreArquivo.js
//
// Persistência da auditoria em ARQUIVOS locais (CLI). Usada quando a auditoria
// roda fora do servidor contra o banco de produção em modo somente leitura:
// nada é gravado no PostgreSQL. Estrutura:
//   <dir>/execucao.json                 metadados + status
//   <dir>/contas/<id>/itens.jsonl       1 linha por anúncio (última versão vence)
//   <dir>/contas/<id>/checkpoint.json   retomada
//   <dir>/contas/<id>/conta.json        resumo + matriz de compatibilidade
//   <dir>/LOCK                          execução única por diretório

const fs = require("fs");
const path = require("path");

function criarStoreArquivo(dir) {
  const contaDir = (id) => path.join(dir, "contas", String(id));
  const garantir = (d) => fs.mkdirSync(d, { recursive: true });
  const escreverJson = (f, obj) => { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, f); };
  const lerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } };

  return {
    tipo: "arquivo",
    dir,
    adquirirLock() {
      garantir(dir);
      const f = path.join(dir, "LOCK");
      try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); return true; } catch (_) {
        const pid = Number(fs.readFileSync(f, "utf8"));
        try { process.kill(pid, 0); return false; } catch (_e) { fs.writeFileSync(f, String(process.pid)); return true; }
      }
    },
    liberarLock() { try { fs.unlinkSync(path.join(dir, "LOCK")); } catch (_) { /* já liberado */ } },
    async iniciarExecucao(meta) {
      garantir(dir);
      const existente = lerJson(path.join(dir, "execucao.json"));
      const exec = existente && existente.status !== "concluida" ? { ...existente, retomadaEm: new Date().toISOString(), status: "em_andamento" }
        : { id: meta.id || `resgate-${Date.now()}`, iniciadaEm: new Date().toISOString(), status: "em_andamento", ...meta };
      escreverJson(path.join(dir, "execucao.json"), exec);
      return exec.id;
    },
    async finalizarExecucao(_id, status, resumo) {
      const f = path.join(dir, "execucao.json");
      escreverJson(f, { ...(lerJson(f) || {}), status, finalizadaEm: new Date().toISOString(), resumo });
    },
    async lerCheckpoint(_id, contaId) { return lerJson(path.join(contaDir(contaId), "checkpoint.json")); },
    async salvarCheckpoint(_id, contaId, cp) { garantir(contaDir(contaId)); escreverJson(path.join(contaDir(contaId), "checkpoint.json"), { ...cp, em: new Date().toISOString() }); },
    async salvarItens(_id, contaId, itens) {
      garantir(contaDir(contaId));
      fs.appendFileSync(path.join(contaDir(contaId), "itens.jsonl"), itens.map((x) => JSON.stringify(x)).join("\n") + (itens.length ? "\n" : ""));
    },
    async lerItens(_id, contaId) {
      const f = path.join(contaDir(contaId), "itens.jsonl");
      if (!fs.existsSync(f)) return [];
      const m = new Map();
      for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; const x = JSON.parse(l); m.set(x.itemId, x); }
      return [...m.values()];
    },
    async salvarConta(_id, contaId, dados) { garantir(contaDir(contaId)); escreverJson(path.join(contaDir(contaId), "conta.json"), dados); },
    async lerConta(_id, contaId) { return lerJson(path.join(contaDir(contaId), "conta.json")); },
    async listarContas() {
      const d = path.join(dir, "contas");
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).map((id) => ({ id: Number(id), ...(lerJson(path.join(d, id, "conta.json")) || {}) })).filter((x) => x.resumo);
    },
  };
}

module.exports = { criarStoreArquivo };
