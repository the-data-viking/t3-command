import { useEffect, useState } from "react";
import type { MeResponse } from "../shared/api";
import { sfx } from "./game/sfx";
import { installActiveWatches } from "./game/watch";
import { openEvent, useGame } from "./store";
import { fetchJson, onUnitTransition, refreshEnvironments } from "./t3/environment";
import { BuildingPanel } from "./ui/BuildingPanel";
import { EnvManager } from "./ui/EnvManager";
import { CommsLog, EventLog } from "./ui/EventLog";
import { HistoryPanel } from "./ui/HistoryPanel";
import { SquadBar } from "./ui/SquadBar";
import { AwayDigest } from "./ui/AwayDigest";
import { IncomingToast } from "./ui/IncomingToast";
import { DebriefCard } from "./ui/DebriefCard";
import { PhotoMode } from "./ui/PhotoMode";
import { PlaybooksDialog } from "./ui/PlaybooksDialog";
import { pruneDrafts } from "./ui/drafts";
import { TimelinePanel } from "./ui/TimelinePanel";
import { MissionBoard } from "./ui/MissionBoard";
import { QueueClear } from "./ui/QueueButton";
import { registerServiceWorker } from "./t3/push";
import { loadPlaybooks } from "./t3/playbooks";
import { loadMemory, MEMORY_REFRESH_MS } from "./t3/memory";
import { scheduleT3Latest } from "./t3/t3-update";
import { mayAutoOpen, noteKey } from "./ui/event-guard";
import { CommandPalette } from "./ui/CommandPalette";
import { HelpOverlay } from "./ui/HelpOverlay";
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
import { connectComms } from "./t3/comms";
import { DEMO, loadDemoFleet } from "./demo";
import { installDeepLinks } from "./ui/deeplink";
import { installQuietWatch, installTitleBadge, notifyAttention } from "./ui/attention";

const ENV_REFRESH_MS = 30_000;

/**
 * Unit state changes as sound effects, desktop notifications and event popups. The matching
 * comms lines come from the Command server, so every device logs the same events.
 */
function announceTransitions(): () => void {
  return onUnitTransition(({ envId, thread, from, to }) => {
    const at = { envId, threadId: thread.id };
    if (to === "alert" || to === "question") {
      if (to === "alert") sfx.alert(); else sfx.question();
      notifyAttention(envId, thread, to);
      // FTL-style: pop the event, unless you're busy typing or already looking at one. If you just
      // pressed a number key (a control group, say), announce it instead: popping the card under
      // that keypress could turn it into "Approve".
      const active = document.activeElement?.tagName;
      const s = useGame.getState();
      if (!s.event && active !== "TEXTAREA" && active !== "INPUT") {
        // Never over a report card or a dialog: the card's number keys would land on it too.
        const covered = !!s.debrief || s.showPalette || s.showHelp || s.showPlaybooks || s.showBoard || s.showTimeline || s.showHistory;
        if (mayAutoOpen() && !covered) openEvent(at);
        else useGame.setState({ incoming: { ...at, at: Date.now() } });
      }
    } else if (to === "error") {
      sfx.error();
    } else if (to === "done" && (from === "working" || from === "monitoring")) {
      sfx.done();
    }
  });
}

export default function App() {
  const selection = useGame((s) => s.selection);
  const hostPanel = useGame((s) => s.hostPanel);
  const showEnvManager = useGame((s) => s.showEnvManager);
  const showLog = useGame((s) => s.showLog);
  const showHistory = useGame((s) => s.showHistory);
  const photo = useGame((s) => s.photo);
  const showPalette = useGame((s) => s.showPalette);
  const showHelp = useGame((s) => s.showHelp);
  const showPlaybooks = useGame((s) => s.showPlaybooks);
  const showTimeline = useGame((s) => s.showTimeline);
  const showBoard = useGame((s) => s.showBoard);
  const [fatal, setFatal] = useState<string>();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    // Keeps polling in the background so a filling disk can still raise a desktop notification.
    const storageTimer = setInterval(() => void refreshStorage().catch(() => {}), STORAGE_REFRESH_MS);
    (async () => {
      // `?demo` (dev builds): a fixed fleet in the store, nothing on the network.
      if (DEMO) { loadDemoFleet(); return; }
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
    registerServiceWorker();
    pruneDrafts();
    void loadPlaybooks();
    void loadMemory();
    const memoryTimer = setInterval(() => void loadMemory(), MEMORY_REFRESH_MS);
    const offT3Latest = scheduleT3Latest();
    window.addEventListener("keydown", noteKey, true);
    const offTransitions = announceTransitions();
    const offTitle = installTitleBadge();
    const offWatches = installActiveWatches();
    const offQuiet = installQuietWatch();
    const offComms = DEMO ? () => {} : connectComms();
    const offLinks = installDeepLinks();
    return () => {
      clearInterval(timer);
      clearInterval(storageTimer);
      clearInterval(memoryTimer);
      offT3Latest();
      offHotkeys();
      window.removeEventListener("keydown", noteKey, true);
      offTransitions();
      offTitle();
      offWatches();
      offQuiet();
      offComms();
      offLinks();
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

  if (photo) {
    return (
      <div className="game photo">
        <MapView />
        <PhotoMode />
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
      {showTimeline && <TimelinePanel />}
      {showBoard && <MissionBoard />}
      <SquadBar />
      <AwayDigest />
      <IncomingToast />
      <DebriefCard />
      <QueueClear />
      {showPalette && <CommandPalette />}
      {showHelp && <HelpOverlay />}
      {showPlaybooks && <PlaybooksDialog />}
      {hostPanel && <HostPanel envId={hostPanel} />}
      {selection?.kind === "hermes" && <HermesControlCenter key={selection.envId} envId={selection.envId} profile={selection.profile} />}
      {selection?.kind === "unit" && <UnitPanel key={`${selection.envId}:${selection.threadId}`} envId={selection.envId} threadId={selection.threadId} />}
      {selection?.kind === "library" && <LibraryPanel key={`lib:${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      {selection?.kind === "building" && <BuildingPanel key={`${selection.envId}:${selection.projectId}`} envId={selection.envId} projectId={selection.projectId} />}
      <div className="hint">CTRL-K command · ? keys and help · P photo mode</div>
      <EventDialog />
      {showEnvManager && <EnvManager />}
    </div>
  );
}
