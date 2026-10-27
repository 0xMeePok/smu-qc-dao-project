import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import { CurrencyProvider } from "./context/CurrencyProvider.jsx";
import { SessionProvider } from "./context/SessionContext.jsx";
import { WalletProvider } from "./context/WalletContext.jsx";
import { isPrivyConfigured, privyAppId, privyConfig } from "./lib/privy.js";
import { enableBrowserRpcStats } from "./lib/rpc.js";
import { applyTheme, initialTheme } from "./lib/theme.js";
import "./styles.css";

applyTheme(initialTheme());
if (import.meta.env.DEV) enableBrowserRpcStats();

const queryClient = new QueryClient();

const app = (
  <QueryClientProvider client={queryClient}>
    <WalletProvider>
      <SessionProvider>
        <CurrencyProvider><App /></CurrencyProvider>
      </SessionProvider>
    </WalletProvider>
  </QueryClientProvider>
);

// Without an app id the app still renders; sign-in explains what is missing.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isPrivyConfigured ? <PrivyProvider appId={privyAppId} config={privyConfig}>{app}</PrivyProvider> : app}
  </React.StrictMode>,
);
