// Station memory from the Command server's turn history: loaded at startup and every ten minutes.

import type { FleetMemory } from "../../shared/memory";
import { useGame } from "../store";
import { fetchJson } from "./environment";

export const MEMORY_REFRESH_MS = 10 * 60_000;

export async function loadMemory(): Promise<void> {
  try {
    const memory = await fetchJson<FleetMemory>("/api/memory");
    // Unchanged: keep the same object, so stations don't redraw.
    if (JSON.stringify(memory) !== JSON.stringify(useGame.getState().memory)) useGame.setState({ memory });
  } catch { /* Memory is decoration; try again next time. */ }
}
