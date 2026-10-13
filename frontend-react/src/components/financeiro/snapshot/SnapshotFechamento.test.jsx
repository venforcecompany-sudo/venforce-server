// Fechamento SALVO por revisão: os números são do snapshot, a faixa diz que
// é histórico, dá para trocar de revisão e os produtos vêm paginados do
// backend (todas as linhas, não 50).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SnapshotFechamento } from "./SnapshotFechamento.jsx";
import { CompetenciaFechamento } from "../fechamento/CompetenciaFechamento.jsx";
import { EntregaPainel } from "../entrega/EntregaPainel.jsx";

const api = vi.hoisted(() => ({ buscar: vi.fn(), itens: vi.fn(), baseAtual: vi.fn() }));
vi.mock("../../../services/fechamentoSnapshotApi.js", () => ({
  buscarSnapshot: api.buscar,
  listarItensDoSnapshot: api.itens,
  listarSnapshots: vi.fn(),
  conferirBaseAtual: api.baseAtual,
}));
vi.mock("../../../services/apiClient.js", async (orig) => ({ ...(await orig()), requisitar: vi.fn(async () => ({ ok: true, entrega: { payload_json: {} } })), ehAdmin: () => false }));

const META = (rev, extra = {}) => ({
  id: 100 + rev, revisao: rev, periodo: "2026-09", marketplace: "shopee", totalItens: 4321, criadoEm: "2026-10-13T17:30:00.000Z",
  processadoEm: "2026-10-13T17:28:00.000Z", criadoPorEmail: "op@venforce", publicado: false, entregas: [],
  contagens: { total: 4321, saudavel: 4000, sem_custo: 300, critico: 21, pendencias: rev === 1 ? 17 : 3, linhasPendentes: rev === 1 ? 300 : 12 },
  ...extra,
});
// GET /:id devolve o mesmo `publicado`/`entregas` da lista (calculados no servidor).
const DETALHE = (rev, finalResult) => ({
  ...META(rev, rev === 1 ? { publicado: true, entregas: [{ id: 9, publicado: true }] } : {}), summary: { finalResult, grossRevenueTotal: 200000, calculatedCoveragePercent: rev === 1 ? 91 : 98, calculationMode: "real_financial" },
  origemCustos: { costsSource: "base", costsBase: { id: 9, nome: "zorza shopee 3" }, custos: { linhas: 1234, sha256: "f".repeat(64) } },
  ajustes: { ads: 5000, venforce: 1500, affiliates: null },
  arquivos: [
    { tipo: "vendas", nomeOriginal: "parentskudetail.20260901_20260930.xlsx", tamanhoBytes: 245760, sha256: "a1b2c3d4e5f6".padEnd(64, "0"), origem: "upload" },
    { tipo: "order_all", nomeOriginal: "Order.all.20260901_20260930.xlsx", tamanhoBytes: 3145728, sha256: "b".repeat(64), origem: "upload" },
    { tipo: "resultado", nomeOriginal: "fechamento-shopee.xlsx", tamanhoBytes: 9000, sha256: "c".repeat(64), origem: "gerado" },
  ],
  diagnostico: { unmatchedIds: [] },
});
const linha = (i) => ({ ordem: i, linha: { "ID do pedido": `25090${i}`, Produto: `Produto ${i}`, SKU: `S${i}`, "Receita bruta": 10, CMV: 3, LC: 2, MC: 20, "Match de custo": "direct_sku", "Cobertura de custo": "com custo" } });

beforeEach(() => {
  vi.clearAllMocks();
  api.buscar.mockImplementation(async (id) => ({ ok: true, snapshot: id === 102 ? DETALHE(2, 29500) : DETALHE(1, 25000) }));
  api.itens.mockImplementation(async (_id, { offset = 0, limit = 25 }) => ({ ok: true, total: 4321, itens: Array.from({ length: limit }, (_, k) => linha(offset + k + 1)) }));
});

const REVISOES = [META(2), META(1, { publicado: true, entregas: [{ id: 9, publicado: true }] })];

describe("SnapshotFechamento", () => {
  it("abre a revisão mais nova, diz que é histórico e de quando é, e qual está publicada", async () => {
    render(<SnapshotFechamento revisoes={REVISOES} marketplace="shopee" periodo="2026-09" periodoLabel="Setembro/2026" />);
    const faixa = await screen.findByText(/É o histórico gravado/);
    const estado = faixa.closest("[data-estado]");
    expect(estado.dataset.estado).toBe("revisao");
    expect(within(estado).getByText("Revisão v2")).toBeInTheDocument();
    expect(within(estado).getByText("Publicado: v1")).toBeInTheDocument();
    expect(screen.getByLabelText("Resultado da revisão salva")).toBeInTheDocument();
    expect(screen.getByText(/3 produtos pendentes de custo/)).toBeInTheDocument();
  });

  it("trocar para v1 carrega o snapshot v1 (números de v1) e os produtos dele", async () => {
    const usuario = userEvent.setup();
    render(<SnapshotFechamento revisoes={REVISOES} marketplace="shopee" periodo="2026-09" periodoLabel="Setembro/2026" />);
    await screen.findByText(/3 produtos pendentes/);
    await usuario.click(screen.getByRole("button", { name: "v1 · publicada" }));
    await screen.findByText(/17 produtos pendentes de custo/);
    expect(api.buscar).toHaveBeenLastCalledWith(101, expect.anything());
    await waitFor(() => expect(api.itens).toHaveBeenLastCalledWith(101, expect.objectContaining({ offset: 0 })));
    expect(screen.getByText("Publicada")).toBeInTheDocument();
  });

  it("produtos: todas as linhas, paginadas e filtradas NO BACKEND", async () => {
    const usuario = userEvent.setup();
    render(<SnapshotFechamento revisoes={REVISOES} marketplace="shopee" periodo="2026-09" periodoLabel="Setembro/2026" />);
    expect(await screen.findByText(/4.321 linhas gravadas nesta revisão/)).toBeInTheDocument();
    await screen.findByText("Produto 1");
    expect(screen.getByText(/Página 1 de 173/)).toBeInTheDocument();
    await usuario.click(screen.getByRole("button", { name: "Próxima" }));
    await waitFor(() => expect(api.itens).toHaveBeenLastCalledWith(102, expect.objectContaining({ offset: 25, limit: 25 })));
    await screen.findByText("Produto 26");
    await usuario.click(screen.getByRole("button", { name: /Sem custo/ }));
    await waitFor(() => expect(api.itens).toHaveBeenLastCalledWith(102, expect.objectContaining({ status: "sem_custo", offset: 0 })));
    // contagem do filtro vem do snapshot (gravada), não da página
    expect(screen.getByRole("button", { name: /Sem custo/ })).toHaveTextContent("300");
  });
});

describe("SnapshotFechamento · arquivos e origem", () => {
  it("manifesto (nome, tamanho, sha256), origem dos custos, ajustes — e conferir se a base mudou", async () => {
    api.baseAtual.mockResolvedValue({ ok: true, aplicavel: true, disponivel: true, mesma: false, linhasNaRevisao: 1234, linhasAgora: 1240 });
    const usuario = userEvent.setup();
    render(<SnapshotFechamento revisoes={REVISOES} marketplace="shopee" periodo="2026-09" periodoLabel="Setembro/2026" />);
    await usuario.click(await screen.findByText(/Arquivos e origem · 2 arquivo\(s\) · base zorza shopee 3/));
    const tabela = screen.getByRole("table", { name: "Arquivos do fechamento" });
    expect(within(tabela).getByText("Order.all")).toBeInTheDocument();
    expect(within(tabela).getByText("3,0 MB")).toBeInTheDocument();
    expect(within(tabela).getByText("a1b2c3d4e5f6…")).toBeInTheDocument();
    const origem = screen.getByTestId("origem-fechamento");
    expect(origem).toHaveTextContent("Base vinculada zorza shopee 3 · 1.234 linhas · impressão ffffffffffff…");
    expect(origem).toHaveTextContent(/ADS R\$\s?5\.000,00 · Venforce R\$\s?1\.500,00/);
    await usuario.click(screen.getByRole("button", { name: "Conferir se a base mudou" }));
    expect(await screen.findByText(/A base mudou depois desta revisão \(1\.234 → 1\.240 linhas\)/)).toBeInTheDocument();
    expect(api.baseAtual).toHaveBeenCalledWith(102);
  });
});

describe("SnapshotFechamento · comparar revisões", () => {
  it("v1 → v2 com diferenças objetivas (valor, p.p., pendências)", async () => {
    const usuario = userEvent.setup();
    const comSummary = [
      { ...META(2), summary: { finalResult: 29500, contributionMarginCalculated: 0.182, calculatedCoveragePercent: 98, revenueWithoutCost: 3700 } },
      { ...META(1, { publicado: true }), summary: { finalResult: 25000, contributionMarginCalculated: 0.15, calculatedCoveragePercent: 91, revenueWithoutCost: 12000 } },
    ];
    render(<SnapshotFechamento revisoes={comSummary} marketplace="shopee" periodo="2026-09" periodoLabel="Setembro/2026" />);
    await usuario.click(await screen.findByText("Comparar revisões · v1 → v2"));
    const tabela = screen.getByRole("table", { name: "Comparação v1 → v2" });
    const linha = (k) => tabela.querySelector(`[data-metrica="${k}"]`);
    expect(linha("finalResult")).toHaveTextContent(/\+R\$\s?4\.500,00/);
    expect(linha("finalResult").dataset.tom).toBe("melhora");
    expect(linha("mcCalculada")).toHaveTextContent("+3,2 p.p.");
    expect(linha("cobertura")).toHaveTextContent("+7,0 p.p.");
    expect(linha("revenueWithoutCost")).toHaveTextContent(/−R\$\s?8\.300,00/);
    expect(linha("pendencias")).toHaveTextContent("17 → 3");
  });
});

describe("CompetenciaFechamento · linha das revisões", () => {
  const base = { periodo: "2026-09", status: { label: "Rascunho salvo", tom: "info" }, onPedirTroca: () => {}, onConfirmarTroca: () => {}, onCancelarTroca: () => {} };
  it("salva v2, publicado v1, v2 ainda não publicada", () => {
    render(<CompetenciaFechamento {...base} revisoes={REVISOES} />);
    const linhaRev = screen.getByTestId("revisoes-competencia");
    expect(linhaRev).toHaveTextContent("Revisão v2");
    expect(linhaRev).toHaveTextContent("2 revisões");
    expect(linhaRev).toHaveTextContent("Publicado: v1");
    expect(linhaRev).toHaveTextContent("v2 ainda não foi publicada");
  });
  it("sem revisões diz isso; lista indisponível não inventa nada", () => {
    const { rerender } = render(<CompetenciaFechamento {...base} revisoes={[]} />);
    expect(screen.getByTestId("revisoes-competencia")).toHaveTextContent("Nenhuma revisão salva");
    rerender(<CompetenciaFechamento {...base} revisoes={null} />);
    expect(screen.queryByTestId("revisoes-competencia")).toBeNull();
  });
});

describe("EntregaPainel · revisão apresentada", () => {
  it("diz qual revisão a entrega apresenta e avisa quando há uma mais nova", () => {
    const entrega = { id: 9, publicado: true, token_publico: "t", created_at: "2026-10-01T10:00:00Z", published_at: "2026-10-01T11:00:00Z" };
    render(
      <EntregaPainel entrega={entrega} entregas={{ acaoEmCurso: null }} clienteNome="Zorza" marketplace="shopee" contaNome="Shopee" clienteContaId={121} periodo="2026-09" periodoLabel="Setembro/2026" revisoes={REVISOES} snapshots={REVISOES} />
    );
    expect(screen.getByTestId("revisao-entrega")).toHaveTextContent("v1");
    expect(screen.getByText(/a v2 é mais nova/)).toBeInTheDocument();
  });
  it("entrega antiga (sem snapshot) é 'anterior às revisões'", () => {
    const entrega = { id: 5, publicado: false, token_publico: null, created_at: "2026-08-01T10:00:00Z" };
    render(<EntregaPainel entrega={entrega} entregas={{ acaoEmCurso: null }} clienteNome="Zorza" marketplace="shopee" clienteContaId={121} periodo="2026-09" periodoLabel="Setembro/2026" revisoes={REVISOES} snapshots={REVISOES} />);
    expect(screen.getByTestId("revisao-entrega")).toHaveTextContent("anterior às revisões");
  });
});
