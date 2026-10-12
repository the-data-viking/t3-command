import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { useGame } from "./store";
import { applyHudTheme } from "./game/theme";

// Before the first render, so the HUD never paints without its colors.
applyHudTheme(useGame.getState().artStyle);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
