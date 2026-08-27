import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CentralExecutivaPage from "./pages/CentralExecutivaPage.jsx";
import "./styles/central-executiva.css";

if (typeof window.initLayout === "function") {
  window.initLayout();
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <CentralExecutivaPage />
  </StrictMode>
);
