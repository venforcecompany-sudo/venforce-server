// server/services/raioX/raioXConexao.js
//
// Validação da URL do banco do Raio-X ANTES de qualquer conexão.
//
// Por que não basta `new URL(url).hostname`: o driver (pg + pg-connection-string)
// deixa o parâmetro `?host=` SOBRESCREVER o host da URL — "postgres://u@localhost/db?host=remoto"
// conecta em "remoto". Aqui o host efetivo vem do MESMO parser que o driver usa,
// e a URL só é aceita se (a) só tiver parâmetros inofensivos (allowlist), (b) o host
// efetivo coincidir com o host sintático da URL e (c) houver host explícito.
// Quem exibe o host na interface usa `efetivo.host` (o destino real).

const { parse } = require("pg-connection-string");

const LOCAIS = new Set(["localhost", "127.0.0.1", "::1"]);
// Único conjunto de parâmetros aceitos na query. Tudo o mais (host, hostaddr,
// port, service, options, sslrootcert, target_session_attrs, …) é recusado.
const PARAMS_PERMITIDOS = new Set(["sslmode", "ssl", "application_name", "connect_timeout"]);
// Variáveis de ambiente do libpq/pg que também poderiam redirecionar a conexão.
const ENV_PG = /^PG(HOST|HOSTADDR|PORT|SERVICE|SERVICEFILE|OPTIONS|DATABASE|USER|PASSWORD|PASSFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY|CONNECT_TIMEOUT|TARGETSESSIONATTRS)$/;

function erro(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; return e; }
const semColchetes = (h) => String(h).replace(/^\[|\]$/g, "").toLowerCase();

function validarUrlRaioX(url) {
  if (!url || typeof url !== "string") throw erro("URL_AUSENTE", "RAIO_X_DATABASE_URL ausente");
  let u;
  try { u = new URL(url); } catch { throw erro("URL_INVALIDA", "RAIO_X_DATABASE_URL não é uma URL válida"); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw erro("PROTOCOLO_INVALIDO", "a URL precisa ser postgres:// ou postgresql://");
  for (const chave of new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()))) {
    if (!PARAMS_PERMITIDOS.has(chave)) {
      throw erro("PARAMETRO_NAO_PERMITIDO", `parâmetro "${chave}" não é aceito na URL do Raio-X (pode redirecionar a conexão); permitidos: ${[...PARAMS_PERMITIDOS].join(", ")}`);
    }
  }
  // Chaves repetidas com variação de caixa (ex.: Host=) também não passam: o
  // allowlist compara em minúsculas, mas o pg só reconhece a forma exata.
  let efetivo;
  try { efetivo = parse(url); } catch { throw erro("URL_INVALIDA", "RAIO_X_DATABASE_URL não pôde ser interpretada pelo driver"); }
  const host = efetivo.host ? semColchetes(efetivo.host) : "";
  if (!host) throw erro("HOST_AUSENTE", "a URL precisa de um host explícito (sem host o driver usa socket/PGHOST)");
  if (host.startsWith("/")) throw erro("SOCKET_NAO_PERMITIDO", "socket Unix não é aceito; use host explícito");
  if (host !== semColchetes(decodeURIComponent(u.hostname))) {
    throw erro("HOST_AMBIGUO", `o host efetivo do driver (${host}) difere do host da URL (${u.hostname})`);
  }
  return {
    host,
    port: efetivo.port ? Number(efetivo.port) : 5432,
    banco: efetivo.database || null,
    local: LOCAIS.has(host),
  };
}

// Remove do ambiente as variáveis PG* que poderiam redirecionar a conexão.
function limparEnvPg(env = process.env) {
  for (const k of Object.keys(env)) if (ENV_PG.test(k)) delete env[k];
}

// Decide se pode conectar: local sempre; remoto só com --autorizo-host=<host efetivo>.
function autorizar(destino, autorizoHost) {
  if (destino.local) return { permitido: true };
  const aut = typeof autorizoHost === "string" ? semColchetes(autorizoHost) : null;
  if (aut && aut === destino.host) return { permitido: true };
  return { permitido: false, motivo: `host efetivo "${destino.host}" não é local; confirme com --autorizo-host=${destino.host}` };
}

module.exports = { validarUrlRaioX, autorizar, limparEnvPg, LOCAIS, PARAMS_PERMITIDOS };
