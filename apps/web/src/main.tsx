import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSentry } from "@/lib/sentry";
import "./index.css";

// Phase 15 plan 11 (OPS-08). Before the first render so a render-time error
// anywhere, including inside App itself, still has an initialized SDK to
// report to (a missing build-time DSN makes this a documented no-op, never
// a boot failure -- see lib/sentry.ts's header comment).
initSentry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
