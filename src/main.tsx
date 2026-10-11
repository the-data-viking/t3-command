import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./ftl.css";
import App from "./App.tsx";
import { useGame } from "./store";

document.documentElement.dataset.art = useGame.getState().artStyle;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
