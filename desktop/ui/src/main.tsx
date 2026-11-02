import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "./theme.css";
import App from "./App";
import i18n from "./i18n";
import { applyInitialStyle } from "./lib/style";
import { applyInitialTheme } from "./lib/theme";

// First paint must already use the cached theme and style; the config is
// synced later. Both attributes are set before React renders (no flash).
applyInitialTheme();
applyInitialStyle();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>,
);
