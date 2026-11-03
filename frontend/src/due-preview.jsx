import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DueOnOffRamp } from "./components/DueOnOffRamp.jsx";
import "./styles.css";

const address = `0x${"a".repeat(40)}`;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <main className="due-preview-page">
      <p>Local preview of Add funds. This page does not sign you in and does not call Privy or Due.</p>
      <DueOnOffRamp address={address} email="preview@qcdao.local" defaultOpen />
    </main>
  </StrictMode>,
);
