import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import { SessionProvider } from "./context/SessionContext.jsx";
import { WalletProvider } from "./context/WalletContext.jsx";
import { privyAppId, privyConfig } from "./lib/privy.js";
import { applyTheme, initialTheme } from "./lib/theme.js";
import "./styles.css";

applyTheme(initialTheme());

const queryClient = new QueryClient();

function AppTree() {
  return (
    <WalletProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </WalletProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {privyAppId ? (
      <PrivyProvider appId={privyAppId} config={privyConfig}>
        <QueryClientProvider client={queryClient}>
          <AppTree />
        </QueryClientProvider>
      </PrivyProvider>
    ) : (
      <QueryClientProvider client={queryClient}>
        <AppTree />
      </QueryClientProvider>
    )}
  </React.StrictMode>,
);
