import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/inter";
import "./styles.css";
import { App } from "./app/App";
import { Providers } from "./app/Providers";
import { applyTheme, storedTheme } from "./lib/theme";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } } });

async function boot() {
  applyTheme(storedTheme()); // light unless the user chose dark
  if (import.meta.env.VITE_USE_MOCKS === "true") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass" });
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <Providers><App /></Providers>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
boot();
