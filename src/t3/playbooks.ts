// Saved orders from the Command server: loaded at startup, edited in the Saved orders dialog.

import type { Playbook } from "../../shared/playbooks";
import { useGame } from "../store";
import { fetchJson } from "./environment";

export async function loadPlaybooks(): Promise<void> {
  try { useGame.setState({ playbooks: await fetchJson<Playbook[]>("/api/playbooks") }); } catch { /* Keep the built-in defaults. */ }
}

export async function savePlaybooks(playbooks: Playbook[]): Promise<void> {
  useGame.setState({ playbooks: await fetchJson<Playbook[]>("/api/playbooks", { method: "PUT", body: JSON.stringify({ playbooks }) }) });
}
