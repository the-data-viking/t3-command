# t3-command

An RTS-style alternative frontend for [T3 Code](https://github.com/pingdotgg/t3code).
Your agent threads, across every T3 environment you run, are worker units on a map. Select one to
give it orders, watch it work, and respond to approval requests when they come up.

> **Unofficial, early, and experimental.** This project isn't affiliated with T3 / Ping. It talks to
> T3 Code's *internal* server protocol (see [`docs/PROTOCOL.md`](docs/PROTOCOL.md)), which changes
> between alpha releases. The stock T3 Code UI is never modified and remains your fallback.

## Status

Playable, tested against T3 Code 0.0.44–0.0.45 across six environments. Fleet-command styling
(hand-authored pixel sprites, with Night Shift as the default world):

- **Stations**: the fleet is laid out as a ship. The Hermes hall (or an operations hub) sits on
  top, the machines' engineering decks hang from its spine in a keel of rows of six, and the
  project modules spread below in wings: two columns around a corridor, each module beside the
  machines that serve it, a lone project centred under the keel. Terminal, files, comms, cryo
  bay, and archive chambers flank a central commons. Every machine runs a supply line in its team
  color down onto a bus under the decks and along a corridor to each project it serves, inside
  cased trunks that narrow as lines turn off; lines cross only on the bus, packets keep one speed
  round every bend, and shared repositories keep their crew together. A solid supply
  line means that machine has crew awake at the station; a project it merely has checked out is
  a dim dotted hairline. Lines thicken as you zoom out, so the network never vanishes, and deck
  callsigns shorten from the middle (TLS…01, TLS…02) so machines stay told apart.
- **Truthful telemetry** (borrowed from [StarNet](https://starnetos.com/)): the map never shows
  activity T3 can't prove. Consoles light up only during a real turn; crew walk to the terminal,
  file archive or comms dish only for a real open tool call, and that system's screen lights while
  they stand at it; crew on an unreachable machine turn grey with static over their heads; drones orbit crew for each running
  background task; a health bar shows how much context window is left. While an agent works
  through a plan, pips over its head and its roster row show the step it's on ("3/5 · Write
  tests"), and the unit panel lists the whole plan. The unit panel also splits each turn into agent
  time and time waiting on you, with tokens processed and the latest context compaction. A running turn with
  no activity for 10 minutes and nothing waiting on you shows three amber dots and "Quiet 14m",
  and is announced once in the comms log (and as a desktop alert, if on). A long tool call or
  background tasks are named instead. Past 90% context the unit panel warns what happens next: the provider
  will compact automatically soon, or (if it won't) turns may start failing and a fresh thread is
  wiser. It's noted once in the comms log. Damage is drawn from real state too. A failed turn throws
  sparks for a minute, then leaves a scorch mark and a wisp of smoke until the thread moves on. An
  unreachable machine's deck shows snow on its screens and NO SIGNAL, with severed supply lines. Its crew's panels say LAST KNOWN, with no live timer and nothing to send, and W cycles
  to them last.
  A disk that's nearly full gets hazard stripes, and crew beam out when their thread is archived
  or removed. All of it is static after the first minute, so it never keeps the map redrawing.
  Each station hull is stepped pixel plating with its own exterior: viewports, an engine block and
  a dish or mast, varied per project. Claude crew wear a round bubble helmet and Codex crew an
  angular helmet with a visor slit and crest; the chest plate carries the machine's team colour, and
  crew sit at their consoles instead of standing in front of them.
  A crew member who finishes a job throws a brief burst of pixel confetti. A station with an approval
  waiting flashes red beacons on its roof, and the asking crew member's console pulses. Each deck's cooling fins run a light faster the busier its
  CPU is. Frame tabs use the map's pixel font, and the help legend shows the real badges.
  Zoomed out past half size, the map switches to a fleet view: stations become flat blocks of
  their rooms (lit while occupied), and each awake crew member and Hermes operator a status glyph
  in the room they're in (most urgent first), so a large fleet stays readable instead of breaking
  up. Its glyphs are controls: click one to select that crew member (an asking one opens their
  request), double-click to go to them. Deck callsigns keep a glyph-free row, and a deck whose disk
  is about to fill wears a hazard frame. A working turn gone quiet shows an ellipsis, and a room with more crew than fit ends in a
  "+" tile (nobody is dropped silently). Crew seated at a console are drawn from behind, facing its screen.
  Each station there carries a one-line summary (who's waiting and for how long, who's working,
  open PRs), and a waiting crew member's glyph gets a frame that thickens with the wait. Close in,
  crew wear a short tag; the one you point at or select shows their full title. **P** is photo
  mode: the HUD goes away, the map stands alone over a planet's horizon with a pixel-type title
  (framed at half size, in its art, whenever the whole ship fits the screen there),
  and **Save PNG** exports it at twice screen size.
  Zoomed out, each engineering deck shows its machine's callsign in large type on a plate in its team color, and
  Hermes operators keep their names. A crew member whose turn has run past 2, 6, 12 and 24 hours
  gets a pip for each beside the head (amber, then magenta past 12 hours). Rooms are lit only
  while in use: a bridge while its station has crew on duty, a system room while someone works
  there. Crew walk to quarters, a cryo bay of stasis pods, when their thread settles (frost
  glints down the glass of their upright pod, its base lamp breathes) and back when it wakes, doors slide
  open as they pass, and a freshly recruited crew member beams in at their seat. Camera jumps
  ease into place.
- **Readable at any zoom**: map labels use a 5×7 pixel font that matches the art. Zoomed out they
  stay crisp at one screen pixel per font pixel and shorten with "…" rather than overlap.
  Status reads by shape as well as color: on the minimap and engineering-deck plates, ▲ approval,
  ◆ question, ● working, ○ monitoring, ✓ report, ✕ failed. With your system's **reduced motion**
  setting the map holds still (no blinking, pulsing or walking; crew are placed), camera moves snap
  and HUD animations stop. Crew portraits are their actual map sprites, and HUD icons are pixel
  art rather than emoji. On the desktop the top bar is two fixed rows, so nothing below it moves
  when Needs you appears: the counters, spend, limits and tools (fit, worlds, alerts, sound), then
  the machines (scrolling sideways if they don't fit), Hermes and the work views (**Board**,
  **Dock**, **Timeline**, with the log, history and **Machines** under **More**). On phones the top bar is one row
  (active, alerts, reports) with a menu holding the machines, spend, limits and the rest, and a tab
  bar along the bottom: **Needs you** (the roster, which opens by itself the first time something
  needs you), **Board**, **Dock** and **Map**. Panels and dialogs fill the screen. The map pinch-zooms, and a tap just beside a small crew member still
  selects them. Return adds a line in the order box (Send sends), and opening a unit doesn't raise
  the keyboard.
- **Host resources**: each environment's engineering deck shows whole-host CPU load as lit
  rack LEDs and RAM used as its coolant level, with green/amber/magenta gauge thresholds; its
  core cells light for that environment's working (pulsing) and monitoring crew. Click a deck to zoom in and open its readings;
  environment chips also open the host panel. Samples refresh every 10 seconds while visible,
  with stale readings clearly marked. The Command server also samples every T3 machine once a
  minute and keeps 7 days. The host panel charts CPU and RAM over the last hour, day or week, with
  each span's peak CPU shown as a band on longer ranges. RAM used is total minus reported availability, not a measurement of memory pressure.
- **Storage**: each deck's status plate shows disk use for the fullest disk holding that machine's
  checkouts and worktrees (green, then amber under 15 GB or 10% free, rose under 5 GB or 3%). The host
  panel lists each disk, peak use per 6 hours over the last week, and the largest T3 worktrees
  (`~/.t3/worktrees/<project>/<worktree>`), named by the thread that uses them. The Command server measures
  disks every 5 minutes and worktree sizes every 15, with no browser open. It reads the Command host
  directly and other machines through a short-lived T3 terminal that it always closes (`df`/`du`, or
  PowerShell on Windows). A machine getting worse adds a comms entry and, with desktop alerts on, a
  notification.
  The host panel also lists the machine's agent CLI versions (Claude Code, Codex) as T3 reports
  them; when one is behind, **Update to x.y.z** has T3 install the latest compatible release there.
  CLIs T3 can't update itself show the command to run instead.
- **Usage estimates**: the top bar shows today's fleet API-equivalent value, with per-environment
  breakdowns, seven-day daily totals, cached-input share and estimated cache savings. T3's
  provider-history scan includes work outside T3; shared physical sources count once. This is
  estimated usage value, not subscription billing. Usage refreshes every minute while visible.
- **Provider limits**: **LIMITS** shows the fullest quota window any provider reports (for example
  Codex's weekly window), with reset times. Machines signed in to the same account share a row.
  Providers that can't report quota, and health notes such as an outdated CLI, are listed. Updates
  arrive live from T3's provider status stream. When only part of the fleet reports (Claude doesn't
  report quotas, and a provider's probe can fail), the chip adds how many provider sign-ins the
  number covers (for example "1/6"), and the breakdown lists which are silent and which failed.
- **Long turns**: the Command server notes in the comms log when a running turn passes 2, 6, 12
  and 24 hours, so a runaway agent stands out with nobody watching. Per-turn cost isn't shown,
  because T3 only prices usage per day and model.
- **Mission telemetry**: the crew panel shows why a failed turn failed (also on hover in the
  roster) and the thread's linked pull requests with state, checks and review. A collapsible
  **Changes** list shows each recent turn's files and +/- counts, with a full-screen diff per turn.
  **Roll back to here** restores the agent's files and conversation to just after an earlier turn,
  dropping later turns. It only appears while the agent is idle on a provider that supports rollback,
  and asks for confirmation first. A module's panel shows the checkout's branch, ahead/behind,
  uncommitted files and the branch's pull request while it's open.
- **Turn history**: **History** (or **H**) shows what the fleet got done over 7, 30 or 90 days.
  It covers turns per day (done, failed, interrupted), typical and slowest turn times, long-running
  turns (running over an hour right now, and the longest finished ones by agent time), failure rate
  and the most common failures, busiest projects and models, recent turns, and daily spend. The
  Command server records every finished turn on every station around the clock, with no browser
  open, into owner-only files in `T3C_DATA_DIR`. Records are kept 90 days. Recording starts when
  this version is deployed (no backfill). After a restart or outage, each thread's latest turn is
  recovered; outages over 5 minutes are listed because additional turns in them can be missing.
  Spend history comes from each machine's own T3 usage scan, asked for when the panel opens (up to
  30 days).
- **Comms log**: **Log** (or **L**) opens a scrollable history of the comms feed. The Command
  server records fleet events around the clock, even with no browser open, and every device sees
  the same log. Events include approvals, questions, failed turns, finished jobs, crew getting to
  work, machines lost for more than 90 seconds and back online, and low disk. They are kept 30 days
  in an owner-only file. Messages about what this browser did (recruits, errors, quiet turns it
  noticed) stay in this browser. **Clear** hides the log in this browser only. Click an entry to
  jump to its crew member.
- **Light**: every room has ceiling tubes in its world's lamp colour (cold fluorescent for Night
  Shift, warm white by day, sodium for Kestrel, candy pink for Pastel), lit with a dithered bloom
  while the room is in use and dark otherwise. The viewports along the top of each hull show the
  lamp of the room under them, so from outside you can tell which rooms are in use. A station
  whose machines have all dropped off browns out: its bridge lamps (and windows) catch now and then.
  Light is drawn additively in dithered pixels (it stays off the console screens, whose few pixels
  carry each crew member's state): lit tubes bloom just under the ceiling, a working
  console throws a pool onto the floor (lamp-coloured, only a quarter toward its screen's hue),
  and whoever is waiting on you lights their own console. Zoomed out, the fleet view is night lights
  from orbit: rooms with crew in them glow under their lamps, empty rooms go dark, and an
  unreachable machine's rooms stay dark. Each hull's row of windows is drawn large enough to read
  there, lit over occupied rooms: a station's signature from far away. High Contrast skips the light. The layout is compact,
  and the planet's horizon low (88% down the screen), so a typical fleet opens at 0.5 zoom on a
  1440×900 screen, where the art shows one-to-one, rather than in the flat fleet view. Lit windows
  spill a little dithered light off the hull into space.
- **Screens**: a crew member writing at their console types lines that scroll, with a blinking
  cursor; a terminal in use runs a prompt over scrolling output; a console waiting on you or
  reporting back shows its status shape (▲ ◆ ✓ ✕) dark on the lit screen, matching the badges.
- **Update T3 on a machine**: a machine's host panel shows its T3 Code version against the newest
  release on npm (`GET /api/t3/latest`, cached for an hour) and, when it's behind, **Update T3 to
  …** uses T3's own self-update (`server.updateServer`; for the desktop app, then
  `server.commitDesktopUpdate`). The confirmation says how it happens (the background service
  restarts, or the desktop app closes and relaunches), what happens to crew mid-turn there (they
  carry on when T3 supports it, and Command asks it to), and whether that version already runs
  elsewhere in the fleet: an unproven release might speak a newer protocol Command can't follow
  yet. Machines that can't update remotely say how to do it there. The palette lists "Update T3 on
  …" for every machine that's behind.
- **Station memory**: stations wear what they've been through. Every merged PR from a project's
  threads is a painted tally mark on its hull (groups of five), every failed turn in the Command
  server's 90-day history a riveted patch plate with soot beside it (up to eight), and the archive's
  shelves fill with books as the station finishes work (one shelf per five clean turns; bare slots
  until then). `GET /api/memory` serves the per-project counts.
- **Cargo pods**: each open PR hangs under its station's hull as a cargo pod, newest outermost
  (up to four, then "+N"), with a light for its checks: green passing, red failing, white pending,
  dim for a draft. Close up each shows its number; tapping one opens the PR. When a PR merges, its
  pod drops off its strut and away into space on a dithered exhaust, and the new tally mark
  flashes onto the hull (not under reduced motion). PR states come from T3, corrected by GitHub:
  the Command server re-reads every PR a machine still calls open (every few minutes, through its
  own host's `gh` login), so a PR whose machine can't refresh it doesn't stay docked after it
  merges. One that turns out to have merged long ago joins the tally quietly, without a launch.
- **Hazard telegraphs**: warnings before something runs out, not after. A disk filling up (a
  least-squares line over the last six hours of readings) shows **FULL IN 8H** on its engineering
  deck and in the station panel, turns amber under two days and critical (with hazard stripes)
  under six hours, and the Command server posts a comms warning (and a push) once it's under 12
  hours. When the fullest provider quota is 75% or more, the top bar's **LIMITS** chip shows when
  it resets (↺1h12m).
- **Drafts never get lost**: every message box (a crew member's orders, recruiting, answers to
  questions, squad orders, the palette's order prompt, Hermes tasks) keeps what you've typed in
  this browser as you type, and clears it when the message is sent, so a reload, a crash or a
  new release never wipes it. Unsent drafts are kept for 14 days. When a new release goes live
  while you're typing, the page waits: a banner says it's ready, and it reloads once you leave
  the field (or the tab is in the background), or when you click **Reload now**.
- **Review** ("is this done?"): a report's first choice, the board's **Review** button, and the
  palette open a review of a crew member's latest turn. Its report (what it claims) sits beside what
  Command can observe: its PR's checks from the host, the test and lint commands it actually ran
  this turn and how each ended, and the PR against its base (conflicts, commits behind, reviewers).
  Below that, the whole branch's changes, file by file. Verdicts: **Mark report read** (reading
  isn't approving the outcome), **Request changes** (your notes go to the agent as an order;
  drafts are kept), **Open PR**, or mark it read and send to camp. Merging stays on GitHub: it can't be undone from here.
- **One "Needs you"**: the top bar's **▶ Needs you N** (its only urgent count: approvals,
  questions, failures and reports are all in it; Space and . still jump), the phone dock, the
  roster's Needs you group, the work board's Blocked on you column (with reports in their own), the queue run and the tab title all count the same list, in the same order:
  approvals and questions (longest wait first), plans waiting for approval, failed turns, turns
  that may be stuck, then reports. A turn that may be stuck (the same command failing three times,
  or an hour with no file change) gets an amber ↻ on the map and an amber underline in the fleet
  view, and its card offers Halt, Halt and ask what's blocking, Open the crew log, or It's fine:
  that sign leaves Needs you until a new one shows up. A failed turn is a triage card: ask the crew member to find and fix the cause, open
  its log, dismiss it ("I've seen it"), or send it to camp; a dismissed failure or read report
  stops needing you until that crew member's next turn. Push notifications for something to
  decide open straight to its card (`#decide/<machine>/<thread>`).
- **Work the queue** (**Q**, the **▶ Queue N** button in the top bar, or the palette): one run
  through everything waiting on you, one card at a time — every approval and question, longest
  wait first (anything new that starts waiting mid-run goes next), then every unread report,
  oldest first — ending on a **Queue clear** card with how many you handled. Esc (or tapping
  outside on a phone) stops the run and leaves the rest as it was. **Later** (**S**) leaves a card
  waiting and moves on; the run won't bring it back, and the clear card says how many you left. On a
  phone the cards are bottom sheets with full-size choices, and you can swipe: left for later,
  right on a report to mark it read. A swipe never approves anything.
- **Work board** (**B**, or the palette): every crew member's current work as a card in the column
  for what it needs next, with missions and orders to several crew on top: **Needs you** (approvals, questions, failed turns),
  **Building**, **Report ready**, and **In review** (report read, PR still open). Cards show the
  state with its shape, how long it's waited or run, the station, machine and model, what an
  approval or question asks, the last error, and PR chips; **Decide**, **Answer** and **Read
  report** act from the card, and a failed turn has **Fix it** (asks the crew member to find and fix
  the cause) and **Retry** (sends its last order again), in its panel too, and clicking one goes to its crew member. Crew at camp or idle
  are off the board. A **mission** (⚑) is only ever several crew on one named goal.
- **Shipping dock** (**D**, the palette, or the work board's header): every open PR in the fleet,
  once each, in four lanes: **Ready to merge** (the host reports checks that ran and passed and a
  clean merge; not a draft, not behind its base), **Needs attention** (failing checks, conflicts,
  commits behind, changes requested), **In progress** (drafts, checks running) and **Not
  verified** (nothing bad is known, but the host wasn't read, no checks ran, or mergeability isn't
  known yet: silence is never taken for clearance), each with the reasons. It reads each
  PR's detail from GitHub a few at a time, through the GitHub CLI (`gh`) signed in on the Command
  server's own host, so one login reads every repo it can see. (The agent machines' T3 is asked
  only if that fails; a fine-grained token there can't read checks at all.) A PR that GitHub says
  has merged or closed since T3 last looked leaves the dock. **Review** opens the crew member's review panel,
  **Rebase** sends them your saved `/rebase` order (queued if they're busy), and **Open ↗** goes to
  the host. Merging stays on the host.
- **Fleet timeline** (**T**, or the command palette): every crew member's turns over the last 6
  hours, 24 hours or 3 days, one lane each, grouped by project. Bars are coloured and named by
  outcome (done, failed, interrupted), and the right edge is live: what's running, or waiting on
  your approval or answer, right now. Hover a bar for its times, model, agent time and time spent
  waiting on you; click a bar to keep its turn's card open, or a lane's name to go to that crew
  member. Time a turn spent waiting on your
  approvals and answers is hatched over its bar (recorded as spans for turns watched live). Served
  by `GET /api/history/timeline`.
- **Posture and plan-first**: the crew panel shows what a crew member may do without asking (Ask
  before acting, Auto-accept edits, Auto, Full access; raising it to full access asks first) and a
  **Plan first** toggle (T3's plan mode). Recruits can start in plan mode ("Plan first: propose
  before building" in the recruit form). A plan-mode crew member whose turn finishes reads
  **Plan ready** (and **PLAN** in the roster); **Approve plan and build** switches it to building
  and tells it to go ahead, or reply with changes to revise the plan.
- **Approvals with context**: the request card shows why the agent is asking, from its own turn:
  what it said just before asking, the order that started the turn, its last three tool calls, and
  where it runs (machine, workspace, branch). While the card is open, the crew panel behind it
  says "Deciding in the request card" instead of showing a second set of buttons.
- **Risk lens**: an approval whose command or files look dangerous is marked ⚠ in the roster, the
  event card and the crew panel, with the reasons ("deletes files recursively", "force-pushes",
  "drops or empties database data", "reads secrets or keys", "runs a script straight from the
  internet"…). A dangerous one puts **Deny** first, arms its buttons more slowly, and drops "approve
  for the rest of this session", so it's only ever approved on its own. Cautions (migrations,
  `sudo`, `--force`, pushing to main, publishing, `.env` and CI workflow edits) are marked in amber
  and keep every choice. It's a heuristic reading of the request, not a sandbox.
- **Attention**: an always-on **Inbox** of everything waiting on you (approvals, questions, failed
  turns, reports), edge-of-screen arrows for off-screen alerts, and RTS hotkeys: **Space** next
  alert, **.** next report, **W** next active crew, **X** next failed turn, **F** fit the fleet, **Z** up to the whole fleet and back down to where you were, **L** comms log, **Esc** deselect.
  A jump lands at 1× and leaves the keyboard on the map, so the same key cycles on; **O** or
  **Enter** goes to the selected crew member's order box. A request card that arrives mid-pan or
  mid-drag is announced instead of popping up under the pointer (**Space** opens it), and
  **Review** from a queue run comes back to the run when it closes.
  The tab title shows how many crew are waiting on you, and the bell turns on desktop alerts for
  approvals and questions while the tab isn't in view.
  Waiting badges use the oldest unanswered request timestamp when available; crew show running
  turn duration, and the thread panel also shows the last completed turn's duration. Live timers
  tick every second while visible.
- **Command palette and squads**: **Ctrl/⌘-K** finds any crew member, station, machine or panel.
  It can also switch themes, sound or alerts, and send the selected crew to camp or wake them.
  Shift-click crew (on the map or roster) or shift-drag a box on the map to pick a squad, then send
  them all to camp or wake them from the squad bar, or give them all one order (it names how many
  it goes to; busy crew can get it as a follow-up when their turn ends). **Ctrl or Alt + 1–9** saves the squad (or the
  selected crew member) as a control group. **1–9** recalls it, and pressing again frames it on the
  map. Alt works where the browser keeps Ctrl+digit for switching tabs. **Backspace** (or Alt+←) goes back
  to where you were before the last jump (Space, a roster row, a link, the queue…): camera and
  what was open, up to eight jumps deep. **?** lists every key and
  explains what the map's lights and effects mean.
- **Links, reports and catching up**: the address bar follows what's open (`#crew/…`, `#host/…`,
  `#station/…`), so a link opens the same crew member, machine or station on any device once that
  machine connects. **Mark read** on a crew member's report takes it out of Needs you and the
  Needs you count in this browser until the thread's next turn (also "Mark all reports read" in the
  palette). After 30 minutes or more away, a **While you were away** card sums up the comms log:
  jobs done, failures, crew waiting on you, and lost machines, disk and long-turn warnings. A
  thread's pull request for its current branch is listed first. Threads that share a title show
  their branch in the palette, and History shows when each turn started.
- **Navigation**: sector minimap, station chips in the top bar that jump to their station, and
  project banners that stay readable when zoomed out. Environment chips frame all of that environment’s
  project modules and attached engineering nodes.
- **Command**: select crew to read the live Markdown transcript with clickable links, give orders, halt, approve or deny tool
  use, answer agent questions with selectable options or custom text, or send them to quarters.
  Select a module to recruit new crew (a new thread) with any model.
  Recruitment offers the current checkout, the latest active worktree, a new worktree, or a
  specific existing worktree on the selected machine. Choose `main` or another checkout/base
  branch; switching the current checkout also affects workers sharing it. New worktrees use
  T3 Code’s setup flow and project setup scripts, with an option to start from the latest
  origin branch. Local Hermes workers use their configured workspace checkout.
  Imported CLI history lives in each module's archive pod. Drag the chat panel's left edge to resize it,
  use its arrow-key controls, or double-click the edge to reset; width is saved per browser.
  Consecutive tool events, including tool failures, are collapsed into expandable **Tool activity**
  rows with a failure count. Turn errors and approval requests stay visible.
- Synthesized sound effects with a volume control (the sound button). Approvals sound a klaxon
  and questions a rising tone. The same sound never plays twice within 0.35 s, and alerts take
  turns 0.9 s apart, so a reconnect or a wave of finished turns plays the most urgent sound once
  instead of a pile of alarms. Plus a comms feed of events.

The map uses compact suited crew and wraparound system consoles. The theme button (showing a tiny
scene in the current theme) opens the **world** picker, each with a rendered preview:

- **Night Shift**, the default: a graveyard-shift engineering bay over a cold blue planet under a
  crescent moon. Its tubes stutter as they come on. **Day** is the same world in sunlight (formerly
  Signal): porcelain hulls, a cool slate-and-white HUD, and a dawn-blue sky brightening toward a teal
  horizon, its sun's glare washing out all but the brightest stars.
- **Kestrel**: the warm FTL hull over an amber desert world, walnut decks under a bronze-and-leather
  HUD, with a ringed giant overhead and warm dust in the starlight. Its stations are ships: deep
  angular corners, long slot ports, a dorsal spine and twin engine nacelles with a glowing exhaust,
  and its sodium lamps warm up through amber as a room comes on.
- **Pastel Ops**: candy dusk, a cream HUD over a pink planet, a big pale crescent moon, and pink and
  mint stars. Its stations are soft: rounded hulls, round portholes, a glass dome on the roof (it
  glows pink while the bridge under it is lit) and a rounded engine pod.

**High contrast** is a switch under the worlds, an accessibility mode rather than a world: black
space and wells, white frames and text, light hulls on dark floors, a bare sky. Turning it off
returns you to your last world. It is chosen automatically if your system asks for more contrast
and you haven't picked a theme yet.

Each world's thumbnail previews it. Each world recolors the map and brings its own HUD chrome: bevelled
corners for Night Shift and Kestrel, rounded for Day and Pastel, square for High Contrast. Status
and gauge colors keep their meaning everywhere; on the light HUDs (Day, Pastel) they're hand-tuned
darker so they stay readable. Switching crossfades the map, except under reduced motion. Earlier
saved preferences carry over.

Behind the fleet, the sky is layered for depth when you pan: a grade from space down toward the
world's horizon colour in dithered bands, dim far stars, nearer stars, a few bright stars that
twinkle, the world's light (a moon, the sun or the ringed giant) with a pixel-dithered glow, and its
planet's horizon along the bottom of the frame. That light catches the hulls: a faint rim along each
station's top and right side. When the last crew on duty stands down, the lights go out station by
station, bow to stern, and the sky deepens while the fleet sleeps.

The pixel-art map renders at one backing pixel per CSS pixel and at most 30 FPS. It stops
redrawing when the fleet is idle and pauses while the page is hidden; live connections and
thread updates continue. Camera controls and incoming updates wake it automatically. The
minimap also skips unchanged frames and pauses while hidden.

The production build includes `/styleboard.html` for palette and asset review, with pause,
scale controls and scene PNG export. Open `/styleboard.html?palette=flightdeck-nightshift`
for the shipped direction. Earlier concept studies remain available for comparison.

## Architecture

t3-command runs on a host that also runs its own T3 Code instance. A small t3-command server on that
host serves the UI and maintains the connections to every T3 environment:

```
browser (any device on your tailnet)
   │  HTTPS, via `tailscale serve`
   ▼
t3-command server (on the host, bound to 127.0.0.1)
   ├─ serves the UI
   ├─ environment registry + one T3 token per environment (on disk, never sent to browsers)
   └─ proxies the WebSocket connections ──► T3 on this host (127.0.0.1:3773)
                                         ├─► T3 environment B (over the tailnet)
                                         └─► T3 environment C (over the tailnet)
```

Why it needs a server of its own:

- **T3 servers don't relay to each other.** Each T3 server only knows about itself. The stock
  app's list of connected environments is stored encrypted on the client side and isn't exposed
  over the API, so t3-command keeps its own environment list and connects to each one directly.
- **Pair once per environment, not once per browser.** The tokens live on the host, so any of your
  devices can use the UI without pairing again.
- **Only one thing has to be exposed.** Browsers only ever talk to the t3-command server, so there
  are no CORS or HTTPS/`ws://` mismatch issues with individual environments.

Each environment sees t3-command as its own connection under **Settings → Connections**, separate
from the stock app's, and you can revoke it there at any time.

### Hermes control center

T3 Command can also launch [Hermes Agent](https://github.com/NousResearch/hermes-agent) workers
on the same machine as the Command server. Hermes has its own control center for persistent
operators, separate from T3 environments and repository-defined projects. T3 Code needs no provider changes. The browser uses the same authenticated Command server,
which launches `hermes acp` and translates its local Agent Client Protocol stream into crew state.

1. Install and configure Hermes on the Command host as the same OS user that runs Command:
   run `hermes setup`, then `hermes acp --check`. Use a Hermes release with ACP session modes
   (`default` and `accept_edits`) and session loading.
2. Open **Machines → Local Hermes**, enter an existing absolute default working directory on that host,
   and choose **Connect Hermes**. No T3 pairing link or additional network listener is needed.
3. Open **Hermes** in the header or select its large control-center node on the map. Choose a bot
   and **Talk to bot** for its ongoing Bot Chat, or **New task session** for a separate conversation.
   Each uses the selected profile's model, credentials, tools, and memory.

Replies and reasoning stream into the crew log. Permission requests use the existing approval controls. Each bot appears once as an operator;
its conversations and task sessions live underneath that identity. **Halt** sends ACP cancellation and waits for the
agent's prompt to finish before showing it as interrupted. The available permission choices are
**Ask before edits** and **Accept workspace edits**; Hermes retains its own command and sensitive
path approval rules. Change the configured model with `hermes model` before recruiting, or use
Hermes's `/model` command in an existing worker's orders.

Change **Bot Chat edit permissions** in the control center, or **Edit permissions** above
the conversation log. Command saves the choice for that conversation across reconnects and
restarts and applies it to each new turn. During a running turn, a change applies to subsequent
edit checks; pending approval requests still need a response. These settings govern Command
conversations, independently of Hermes Desktop chats and scheduled routines.

Closing or reconnecting the browser leaves workers running. Command stores its transcripts and
Hermes session IDs in owner-only files under `T3C_DATA_DIR`. After a Command host restart, prior
running turns become interrupted; the next order reloads the saved Hermes session. Removing a
Hermes base stops its processes and deletes Command's transcripts; Hermes's own saved sessions
remain. Command can reopen a bot's canonical Bot Chat and refresh its native transcript.
Images, structured questions, background-task telemetry, and spend estimates remain unsupported.

Open **Hermes → Manage bots**, **Identity & memory**, or **Routines** to create or clone native Hermes profiles, edit their role, SOUL.md and curated memory
files, configure the model, toggle installed skills/toolsets/MCP servers, and open Bot Chat.
The map links the control center to engineering nodes, not projects. Uplinks show connection
topology only; automated delegation and live handoff tracking are not implemented yet.

Existing profiles are discovered automatically. Clones copy identity and memory; their sessions
and routines start empty, and OAuth providers may require login separately for each bot.

The **Routines** tab manages Hermes jobs: schedules, prompts, model/provider/reasoning pins,
working directories, skills, local or Bot Chat delivery, previous-run continuity, script-only
jobs, and change monitors. Pause, resume, run now, delete, and view execution history/output.
Hermes's gateway or Serve/Desktop backend executes jobs independently of Command. Scheduler
health is checked for the selected profile; offline profiles cannot be triggered from Command.

Command permits only one active turn per bot across all Hermes stations. Configuration/memory
edits and profile deletion are blocked while that bot is working in Command. Each turn opens a
fresh ACP process and reloads its saved session, so profile memory and capabilities are refreshed.
Canonical Bot Chats receive Hermes's native bot-to-bot messaging protocol;
a small SessionManager extension restores native Bot Chats from other interfaces without
changing their provenance. Hermes’s session leases prevent concurrent writers across clients.
An open Bot Chat in Hermes Desktop or a terminal can hold that lease even while idle.
To send an order from Command, close that chat in the other interface first, then retry
the order. Command reports the conflict without taking over or duplicating the chat.
Native chat history refreshes every 30 seconds while Command is connected. Model edits
update the canonical Bot Chat; existing task sessions may retain their model choice.
Group-room and shared Kanban management are not yet exposed. Avoid concurrently driving the same bot from another
Hermes client; Command's ownership guard covers Command stations only.

Management requires a Hermes launcher supporting `--print-runtime-command` and the native
profiles, cron, and SessionDB APIs (verified against Hermes 0.21.6). The server runs a JSON helper
inside Hermes's own runtime/bootstrap. Credentials and raw configuration never reach the browser.
The alternative Python/module ACP launcher below supports tasks but not management.

The Command service must be able to find Hermes on its `PATH`. For launchers outside that path,
set the executable and arguments on the host, then restart Command:

```sh
T3C_HERMES_COMMAND=/absolute/path/to/hermes npm start
# Alternative: launch the ACP module through Hermes's Python environment.
T3C_HERMES_COMMAND=/absolute/path/to/hermes/.venv/bin/python \
T3C_HERMES_ARGS='["-m","acp_adapter"]' npm start
```

`T3C_HERMES_COMMAND` defaults to `hermes`; `T3C_HERMES_ARGS` defaults to `["acp"]` and must be a
JSON array of strings. These settings are server-only; the browser chooses the workspace, never
an executable or shell command. Verification uses an ACP fixture through the actual HTTP and
WebSocket server; a configured real Hermes installation is still needed for a model-backed smoke test.

### Protocol versions

On connect, t3-command reads each environment's `GET /.well-known/t3/environment` and checks
`orchestrationProtocolVersion`. Environments running an unsupported version are shown as
"needs update" instead of being driven with the wrong message format.

Supported: **orchestration protocol v1** (T3 Code 0.0.44). T3 Code moved to v2 upstream on
2026-10-02, so expect to need a t3-command update when your T3 instances auto-update.

## Deploying on a host with Tailscale

Requirements: Node.js 22+, Tailscale, and a T3 Code instance on the host. The other T3
environments must be reachable from the host over the tailnet.

### 1. Install and build

```sh
git clone https://github.com/the-data-viking/t3-command.git
cd t3-command
npm ci
npm run build
```

### 2. Run the t3-command server

The server binds to `127.0.0.1` only, so the sole way in is through `tailscale serve`. That
matters because access control relies on the identity headers Tailscale adds (next step).

```sh
T3C_PORT=4773 \
T3C_DATA_DIR=~/.t3-command \
T3C_ALLOWED_USERS=you@example.com \
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `T3C_PORT` | `4773` | Local port the server listens on (always `127.0.0.1`). |
| `T3C_DATA_DIR` | `~/.t3-command` | Environment registry and T3 tokens. Created with owner-only permissions on Linux/macOS; on Windows it relies on your user profile's permissions. |
| `T3C_ALLOWED_USERS` | *(required)* | Comma-separated Tailscale login names allowed to use the UI. Requests without a matching `Tailscale-User-Login` header are rejected. |
| `T3C_PUSH_SUBJECT` | `https://github.com/the-data-viking/t3-command` | Contact URL (or `mailto:` with a real address) that push notifications are signed with. Apple's push service rejects non-routable ones such as `mailto:…@localhost`. |

To keep it running on Linux, use a systemd unit like this:

```ini
# /etc/systemd/system/t3-command.service
[Unit]
Description=t3-command
After=network-online.target tailscaled.service

[Service]
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/t3-command
Environment=T3C_PORT=4773
Environment=T3C_ALLOWED_USERS=you@example.com
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now t3-command
```

### 3. Expose it on your tailnet with `tailscale serve`

```sh
tailscale serve --bg 4773
tailscale serve status
```

The UI is now at `https://<host>.<your-tailnet>.ts.net/`, with a certificate issued by Tailscale
(enable HTTPS certificates for your tailnet in the Tailscale admin console if you haven't already).

- Use `tailscale serve`, **not** `tailscale funnel`. Funnel would expose the UI, and through it
  every T3 environment it can drive, to the public internet.
- Tailscale only adds the `Tailscale-User-Login` header for requests from a user's device. Requests
  from tagged devices have no user identity, so they're rejected by `T3C_ALLOWED_USERS`.
- You can also restrict who can reach the host on port 443 with your tailnet ACLs.

**A name of its own.** To serve Command at `https://command.<your-tailnet>.ts.net/` without renaming
the host, run a second, userspace Tailscale node on it as your own device (no tags, so identity
headers still arrive), and serve from that node too:

```sh
brew install tailscale   # the open-source tailscaled; the Mac app is untouched
D=~/.t3-command/tailscale-command; mkdir -p $D
tailscaled --tun=userspace-networking --statedir=$D --socket=$D/tailscaled.sock --port=0 &
tailscale --socket=$D/tailscaled.sock up --hostname=command   # approve the login link once
tailscale --socket=$D/tailscaled.sock serve --bg --https=443 http://127.0.0.1:4773
```

Keep `tailscaled` running with a launch agent (`RunAtLoad`, `KeepAlive`), and disable key expiry
for the `command` machine in the admin console so the address doesn't lapse.

### 4. Add your T3 environments

**Easiest: import from T3 desktop.** If the host runs the T3 Code desktop app and it's already
connected to your other environments, open **Bases → Import from T3 desktop**. Every direct
connection T3 desktop has saved becomes a *linked* base. Linked bases use T3 desktop's own
logins: t3-command decrypts its connection catalog in memory (as the same OS user) whenever it
needs a token, and never writes those tokens anywhere. Re-pairing or removing a connection in
T3 desktop carries over automatically; run the import again to pick up new connections. Notes:

- Tested on Windows (DPAPI). macOS (Keychain) and Linux (keyring, or Chromium's fallback key)
  follow Electron's standard scheme but are untested.
- A headless T3 used through a browser keeps its connections in that browser, so there's nothing
  on the host to import; pair those environments below instead.
- Commands from linked bases run under T3 desktop's login on each environment, so they don't show
  up as a separate "t3-command" connection there.

**SSH environments** (ones T3 desktop reaches over SSH) are the easiest: in t3-command open
**Bases → SSH host** and enter the same destination you use in T3 (`user@host` or an
`~/.ssh/config` alias). t3-command finds the T3 server that T3 desktop's SSH launcher left
running there, opens its own `ssh -L` tunnel to it, and pairs automatically using T3's own CLI on
that machine. Requirements:

- The host running t3-command needs non-interactive (key or agent) SSH access to that machine.
  Password prompts aren't supported.
- T3 desktop must have connected to that machine at least once, so T3 and its server are there.
  t3-command doesn't start or stop remote servers; if the server isn't running, the base shows
  as unreachable until T3 desktop starts it again.
- Set `T3C_SSH` to use a specific `ssh` binary.

For other environments (direct URLs), including the T3 instance on the host itself:

1. In that environment's T3 Code app, open **Settings → Connections** and create a pairing link.
   On a headless T3 server, use its CLI instead:
   `t3 auth pairing create --label t3-command --ttl 10m --json`
   For the T3 on the host itself, the shortcut is
   `npm run pair:local -- --user you@example.com`, which pairs it in one step.
2. In t3-command, open **Bases** and paste the pairing link. If the host reaches that T3 at a different address than the link shows, also enter its URL as seen *from the host*
   (for example):
   - the host's own T3: `http://127.0.0.1:3773`
   - another machine on the tailnet: `http://<machine>.<your-tailnet>.ts.net:3773`, or its
     `https://…` address if that environment is itself behind `tailscale serve`
3. The t3-command server exchanges the one-time credential for a 30-day token and stores it in
   `T3C_DATA_DIR`. Pairing credentials expire after a few minutes and work only once.

When a token expires or is revoked, the environment shows up as "needs pairing". Repeat the steps
above to pair it again.

Plain `http://` between the host and other environments is fine: tailnet traffic is already
encrypted by WireGuard, and browsers never see those addresses.

## Development

```sh
npm install
T3C_DEV_NO_AUTH=1 npm run dev     # t3-command server on :4773 + Vite UI on http://localhost:5173
npm run pair:local                 # pair the T3 Code running on this machine (in another terminal)
npm run check:layout               # desktop + phone layout check against the built-in demo fleet
```

`T3C_DEV_NO_AUTH=1` turns off the Tailscale identity check so you can use it from localhost.

In development, open the UI with `?demo` (for example `http://localhost:5173/?demo`) to load a fixed
demo fleet straight into the store. It covers crew in every state, three machines, disk readings,
history and host charts, with no server and no real agents. `npm run check:layout` drives that demo
at 1440×900, 1280×800, iPhone 14 and iPhone SE with the system Chrome. It checks that panels stay below
the top bar, History charts keep their height, the comms log doesn't cover the roster, phone sheets
stay on screen, and nothing overflows sideways. Screenshots of each view are kept for a look.
Never run it that way behind `tailscale serve`.

`npm run pair:local` uses the installed T3 Code desktop app's own CLI to create a one-time
pairing credential and hands it straight to the t3-command server, so it's never printed. On a
headless T3 install, set `T3_CLI` to your `t3` executable.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run build`.

### Updating from the web interface

The **Update** button in the top bar shows the running commit, the latest commit on `main`,
and build progress. **Check main** checks the configured repository; **Redeploy main** installs
dependencies and builds a fresh release, then restarts Command and reloads connected browsers.
T3 agent turns continue on their own environments during the brief relay reconnection.
Running local Hermes turns must be halted before a redeploy; idle Hermes sessions are saved and
reload on their next order.

To enable it, use the stable launcher as your service entry point:

```sh
node /absolute/path/to/t3-command/tools/managed-launcher.mjs
```

For the systemd example above, replace `ExecStart` with your Node executable and that launcher
path. On macOS, use the same command in your launch agent's `ProgramArguments`. Keep the existing
data directory and access-control environment variables. The service user needs `git`, `npm`,
Node.js 22+, and access to the installation's `origin` remote on its `PATH`.

The launcher preserves the installation checkout, including local edits. Each update clones
only committed `main` into a private release directory under `T3C_DATA_DIR/updates`; unpublished
local changes are not part of that release. The data directory and environment credentials stay
in place. A failed fetch, install, or build leaves the running version alone. If a new server
fails to signal readiness within 60 seconds, the launcher restores the previous release and
shows the failure in the update panel. Closing the panel or browser does not cancel a build.
The active and previous managed releases are retained; older managed build directories are
removed after successful startup.
Only one update can run at a time, and the authenticated APIs accept no browser-supplied refs,
repositories, paths, or commands. `main` must include managed-update protocol 1 before it can
replace this version.

Server-only overrides: `T3C_UPDATE_REMOTE` selects a trusted repository URL, and `T3C_UPDATE_ROOT`
changes the release directory. Ordinary `npm start` still works; its Update panel explains how
to enable managed updates. The launcher's own file is the stable bootstrap and must remain in
place when the service switches releases.

Layout:

- `server/`: the t3-command server (Node 22.18+ runs the TypeScript directly; no build step)
- `src/t3/`: T3 protocol client. Everything protocol-specific lives here, so a T3 protocol
  change should only touch this folder.
- `src/game/`: the PixiJS map and sound effects
- `src/ui/`: React HUD (panels, top bar, modals)
- `shared/`: types shared by server and UI

## Tools

- `tools/extract-rpcs.mjs` regenerates the RPC method list (`tools/rpcs.tsv`) from an installed T3
  Code server bundle, so you can diff protocol changes after a T3 update.

## Push notifications to your phone

T3 Command can push fleet events to any device that turns it on, even with no tab open: approvals
and questions, failed turns, turns that may be spinning (the same command failing three or more
times, or an hour with no file change while it keeps working; the server reads the turn's own
activity, and the roster shows it too), turns gone quiet (no update for 20 minutes) or running long, merged
PRs, finished jobs, machines going offline and low disks. Open the bell menu in the top bar to
turn push on for this device, choose which events come through, and set quiet hours (only the
kinds you allow, approvals by default, get through overnight). Tapping a notification opens T3
Command at that crew member.

On iPhone and iPad, web push needs the app on the Home Screen: open T3 Command in Safari, tap
Share → **Add to Home Screen**, then open it from the Home Screen and turn push on. The Command
server keeps its keys, subscriptions and rules in owner-only files in its data directory.

## Follow-ups

When a crew member is busy, **After turn ↻** (or Alt+Enter) in their order box queues the order on
the Command server, which sends it the moment their current turn completes cleanly, with or
without a browser open. A follow-up is dropped (and the comms log says why) if the turn fails or
is interrupted, if another order starts a new turn first, or after 12 hours. There's at most one
per crew member; it shows in their panel and roster row and can be cancelled, every send is logged
as "sent by follow-up", and the command palette can pause them all. Replacing a queued one is
logged too.

**Standing orders**: the ×N picker beside Send gives an order 2–10 times. It goes now (or after
this turn), and the server gives it again after each turn it starts that ends cleanly; it stops at
a failure, an interruption, your next order, a send that never starts a turn, or a reply that ends
**NOTHING LEFT** (the server reads each reply itself before repeating, so this works with every
browser closed; if it can't read the reply after a few tries, it stops rather than repeat blind). A send that
errors waits to see whether its turn shows up before retrying (with backoff, up to five tries), so
it's never sent twice.

## Orders to several crew, and missions

An order to two or more picked crew is followed as an **order**: the work board and a top-bar
**ORDER n/N** chip show each recipient's receipt (sent, queued for after its turn, didn't start,
working, needs you, reported, failed, never delivered, or machine offline), worked out from their
own turns. **Read replies** puts every crew member's answer side by side; **Copy debrief** copies
them as markdown; **Close order** stops following it, and if crew still have it queued for after
their turn it says so and cancels those sends too.

A **mission** (⚑, **Mission…** in the squad bar) is several crew on one named goal, each with
their own part. Each gets a brief with the mission, the goal, their part and who else is on it,
and the rules every round repeats: stay in your lane, start with `BLOCKED:` if blocked, end with
`STATUS: done | partial | blocked`. The server reads that line from each finished report, so a
receipt says **blocked** (with what they need) or **partly done** rather than just "reported".
**Follow up…** in its replies orders the same crew again, optionally passing each one what the
others reported (clipped from the middle, so each one's STATUS line survives). The server watches
every order and mission and says once in the comms log (and by push, if you allow it) when
everyone's part is over: "Mission "Ship it": 2 done, 1 blocked (needs the staging DB password)".
Mission crew carry ⚑ on the map and in the roster.

## Saved orders

Type **/** at the start of any order box (a crew member's, the squad bar's, or the command
palette's) to pick a saved order: arrows move, Tab or Enter picks. `/status`, `/wrapup`, `/rebase`,
`/explain` and `/tests` come built in. Sending `/name` with text after it sends the saved order
followed by your text. **Edit saved orders…** (under the list, or in the command palette) adds,
changes and removes them; they live on the Command server (`playbooks.json`, owner-only), so every
device has the same ones.
