import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/public-sans";
import "./styles.css";
import { App } from "./app/App";

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } } });

async function boot() {
  if (import.meta.env.VITE_USE_MOCKS === "true") {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass" });
  }
  try { document.documentElement.dataset.theme = localStorage.getItem("es-theme") ?? "dark"; } catch { /* storage blocked */ }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}><BrowserRouter><App /></BrowserRouter></QueryClientProvider>
    </React.StrictMode>,
  );
}
boot();
