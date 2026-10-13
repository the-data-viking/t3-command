// The fleet comms log from the Command server (server-sent events). EventSource reconnects on
// its own and resumes after the last entry it saw.

import type { CommsEntry } from "../../shared/comms";
import { mergeReadMarks, mergeServerLog, setReadSink, useGame } from "../store";
import { fetchJson } from "./environment";

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
  // Report read marks are shared through the server: every mark on connect, then each change.
  source.addEventListener("read", (event) => {
    try { mergeReadMarks(JSON.parse((event as MessageEvent).data) as Record<string, string>); } catch { /* Skip a bad frame. */ }
  });
  // Marks made here go to the server (and on to other devices). Ones made before this connection
  // existed are sent once it opens, so a mark from an older browser isn't lost.
  const send = (marks: Record<string, string>) => void fetchJson("/api/read", { method: "PUT", body: JSON.stringify({ marks }) }).catch(() => {});
  setReadSink(send);
  const local = useGame.getState().readReports;
  if (Object.keys(local).length) send(Object.fromEntries(Object.entries(local).slice(-500)));
  return () => { clearTimeout(flush); source.close(); setReadSink(undefined); };
}
