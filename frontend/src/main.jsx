import React from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.jsx";
import { SessionProvider } from "./context/SessionContext.jsx";
import { wagmiConfig } from "./lib/wagmi.js";
import { applyTheme, initialTheme } from "./lib/theme.js";
import "./styles.css";

applyTheme(initialTheme());

const queryClient = new QueryClient();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
