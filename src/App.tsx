import { useEffect, useState } from "react";
import type { MeResponse } from "../shared/api";
import { sfx } from "./game/sfx";
import { installActiveWatches } from "./game/watch";
import { addLog, openEvent, useGame } from "./store";
import { fetchJson, onUnitTransition, refreshEnvironments } from "./t3/environment";
import { BuildingPanel } from "./ui/BuildingPanel";
import { EnvManager } from "./ui/EnvManager";
import { CommsLog, EventLog } from "./ui/EventLog";
import { HistoryPanel } from "./ui/HistoryPanel";
import { LibraryPanel } from "./ui/LibraryPanel";
import { installHotkeys } from "./ui/hotkeys";
import { MapView } from "./ui/MapView";
import { Minimap } from "./ui/Minimap";
import { CrewRoster } from "./ui/CrewRoster";
import { EventDialog } from "./ui/EventDialog";
import { TopBar } from "./ui/TopBar";
import { UnitPanel } from "./ui/UnitPanel";
import { HostPanel } from "./ui/HostPanel";
import { HermesControlCenter } from "./ui/HermesControlCenter";
import { refreshHermesBots } from "./t3/hermes";
import { refreshStorage, STORAGE_REFRESH_MS } from "./t3/storage";
import { installTitleBadge, notifyAttention } from "./ui/attention";

const ENV_REFRESH_MS = 30_000;

/** Turn unit state changes into sound effects and event-log lines. */
function announceTransitions(): () => void {
  return onUnitTransition(({ envId, thread, from, to }) => {
    const name = `"${thread.title || "Untitled"}"`;
    const at = { envId, threadId: thread.id };
    if (to === "alert" || to === "question") {
      sfx.alert();
      notifyAttention(envId, thread, to);
      addLog({ tone: "alert", text: to === "alert" ? `${name} needs your approval` : `${name} has a question`, ...at });
      // FTL-style: pop the event, unless you're busy typing or already looking at one.
      const active = document.activeElement?.tagName;
      if (!useGame.getState().event && active !== "TEXTAREA" && active !== "INPUT") openEvent(at);
    } else if (to === "error") {
      sfx.error();
      addLog({ tone: "bad", text: `${name} was hurt — the turn failed`, ...at });
    } else if (to === "monitoring" && from === "working") {
      addLog({ tone: "info", text: `${name} is monitoring background work`, ...at });
    } else if (to === "done" && (from === "working" || from === "monitoring")) {
      sfx.done();
      addLog({ tone: "good", text: `Job's done: ${name}`, ...at });
    } else if (to === "working" && from !== "alert" && from !== "question") {
      addLog({ tone: "info", text: `${name} got to work`, ...at });
    }
  });
}

export default function App() {
  const selection = useGame((s) => s.selection);
  const hostPanel = useGame((s) => s.hostPanel);
  const showEnvManager = useGame((s) => s.showEnvManager);
  const showLog = useGame((s) => s.showLog);
  const showHistory = useGame((s) => s.showHistory);
  const [fatal, setFatal] = useState<string>();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    // Keeps polling in the background so a filling disk can still raise a desktop notification.
    const storageTimer = setInterval(() => void refreshStorage().catch(() => {}), STORAGE_REFRESH_MS);
    (async () => {
      try {
        const me = await fetchJson<MeResponse>("/api/me");
        useGame.setState({ me });
        await refreshEnvironments();
        void refreshHermesBots();
        void refreshStorage().catch(() => {});
        if (Object.keys(useGame.getState().envs).length === 0) useGame.setState({ showEnvManager: true });
        // Profile listing spawns a Hermes helper on the host; skip it while nobody is looking.
        timer = setInterval(() => void refreshEnvironments().then(() => document.hidden ? undefined : refreshHermesBots()).catch(() => {}), ENV_REFRESH_MS);
      } catch (err) {
        setFatal((err as Error).message);
      }
    })();
    const offHotkeys = installHotkeys();
    const offTransitions = announceTransitions();
    const offTitle = installTitleBadge();
    const offWatches = installActiveWatches();
    return () => {
      clearInterval(timer);
      clearInterval(storageTimer);
      offHotkeys();
      offTransitions();
      offTitle();
      offWatches();
    };
  }, []);

  if (fatal) {
    return (
      <div className="fatal">
        <h1>T3 COMMAND</h1>
        <p>Can't reach the t3-command server: {fatal}</p>
      </div>
    );
  }

  return (
    <div className="game">
      <MapView />
      <TopBar />
      <CrewRoster />
      <Minimap />
      <EventLog />
      {showLog && <CommsLog />}
      {showHistory && <HistoryPanel />}
      {hostPanel && <HostPanel envId={hostPanel} />}
      {selection?.kind === "hermes" && <HermesControlCenter key={selection.envId} envId={selection.envId} profile={selection.profile} />}
      {selection?.kind === "unit" && <UnitPanel key={`${selection.envId}:${selection.threadId}`} envId={selection.envId} threadId={selection.threadId} />}
      {selection?.kind === "library" && <LibraryPanel key={`lib:${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      {selection?.kind === "building" && <BuildingPanel key={`${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      <div className="hint">DRAG pan · SCROLL zoom · SPACE next alert · . next report · W next active · M next monitoring · F fit fleet · L log · H history</div>
      <EventDialog />
      {showEnvManager && <EnvManager />}
    </div>
  );
}
