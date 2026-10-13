// The fleet comms log from the Command server (server-sent events). EventSource reconnects on
// its own and resumes after the last entry it saw.

import type { CommsEntry } from "../../shared/comms";
import { mergeServerLog } from "../store";

export function connectComms(): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource("/api/comms/stream");
  // Backlog entries arrive one per event; batch them so the log re-sorts once per burst.
  let batch: CommsEntry[] = [];
  let flush: ReturnType<typeof setTimeout> | undefined;
  source.onmessage = (event) => {
    try { batch.push(JSON.parse(event.data) as CommsEntry); } catch { return; }
    flush ??= setTimeout(() => { flush = undefined; mergeServerLog(batch); batch = []; }, 50);
  };
  return () => { clearTimeout(flush); source.close(); };
}
