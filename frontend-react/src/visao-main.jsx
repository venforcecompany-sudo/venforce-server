// frontend-react/src/visao-main.jsx
// Ponto de entrada da página visao.html — hoje a tela de Início (cópia do
// Início do Lucratto 360), que substituiu a Visão. O nome do arquivo/rota
// ficou "visao" para não quebrar links salvos nem o item da sidebar.
//
// Quem desenha sidebar/topbar e resolve o contexto operacional é vf-shell.js/
// vf-context.js (script módulo carregado junto, ver visao.html).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import InicioPage from "./pages/InicioPage.jsx";
// visao.css: os blocos Ads e Configuração reaproveitam os componentes da Visão.
import "./styles/visao.css";
import "./styles/inicio.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ErrorBoundary>
      <InicioPage />
    </ErrorBoundary>
  </StrictMode>
);
