# Agent widgets

An agent can put up a small live dashboard ("widget") in T3 Command instead of you asking it for
updates: a benchmark sweep's progress, a deploy's state, a queue's depth. The widget shows in the
crew member's panel, and you can drag it onto the map to pin it there.

Ask for one with the `/widget` saved order (it carries the spec below), e.g.
`/widget track the Synthbench runs in ~/runs: done, running, failed, and the mean score`.

## For agents: the spec

- **Page:** `.t3/widgets/<id>.html` in your working directory, one self-contained page.
  `<id>` is lowercase letters, digits and dashes, up to 40 characters. A workspace can have several.
  Keep `.t3/` out of git (`.git/info/exclude`).
- **Data:** `.t3/widgets/<id>.json`, at most 1 MB. Command re-reads it every 5 s while the widget
  is on screen and posts it into the page without reloading it. Write it atomically (`<id>.json.tmp`,
  then `mv`) and include a top-level `"updatedAt"` (ISO 8601, or epoch seconds or ms).
- **Feeder:** a live process that keeps running after your turn ends (`nohup … &`, tmux, launchd)
  and rewrites the JSON every 30–60 s. Log to `.t3/widgets/<id>.log`, keep its PID in
  `.t3/widgets/<id>.pid`, and have it write a final JSON and exit once what it watches is finished.
- **In the page:** `t3widget.onData((data, updatedAt) => render(data))` is called with the current
  data (if any) and on every change; `t3widget.data` and `t3widget.updatedAt` hold the latest.
- **Sandbox:** the page runs in an iframe with `sandbox="allow-scripts"` and this policy:
  inline scripts and styles, plus scripts, styles, fonts and images from `https:` URLs, are
  allowed. Network requests (`fetch`, XHR, WebSocket), cookies, `localStorage`, popups, forms and
  navigation are blocked. All data comes through the JSON file.
- **Theme:** style the page with Command's colours so it matches where it's shown and follows the
  map's theme: `--t3-bg` (the page's default background), `--t3-surface`, `--t3-text`, `--t3-muted`,
  `--t3-line`, `--t3-accent`, `--t3-ok`, `--t3-warn`, `--t3-bad`, and `--t3-font` (a monospace
  stack). In the crew panel they're the station's materials (deck, walls, the station's team colour
  as the accent); pinned, they're the HUD's. They change live, without a reload.
- **Optional meta tags:** `<title>` names the widget.
  `<meta name="t3-widget-size" content="420x260">` is its size when pinned (default 380×240), and
  `<meta name="t3-widget-stale-after" content="300">` is how many seconds without an update before
  it's flagged stale (default 600).
- **Changes:** rewrite the HTML and Command picks it up within 30 s. To remove a widget, stop its
  feeder and delete its files.

## In Command

- **Found by:** every 30 s (and when a panel opens) Command lists `.t3/widgets/` in the workspace
  of each live thread on connected T3 machines, using T3's `projects.listEntries` and
  `projects.readFile`. A new widget is announced in the comms log. Threads sharing a workspace
  (no worktree) share its widgets. Hermes operators have no workspace files, so no widgets.
- **Crew panel:** a WIDGETS section lists the workspace's widgets, live, with the data's age. Each is
  drawn as a module of the station, in the world's materials: its nameplate above the hull, then
  the hull plating with the world's corners, light and shade bands, ribs and viewports (lit while
  the widget is live), a port plate in the station's team colour, and the page in a walled room on
  the deck. Its age turns amber ("stale") when the data is older than the page allows, and says so
  when the data file is unreadable or the machine is unreachable.
- **Pinning:** drag a widget's title bar onto the map, or use **Pin to map** / **Pin to screen**.
  - A *map* pin is part of the map. It's anchored to a world spot and keeps the size it was
    pinned at relative to the map: pinned at 0.5× zoom, it doubles when you zoom to 1× and halves
    at 0.25×, like the stations around it. Off screen, it becomes an edge marker you can click.
  - A *screen* pin stays put while the map moves.
  - Drag a pinned window's title bar to move it and its corner to resize it. ⌖/▭ switches between
    map and screen, ✕ unpins it, and its title selects the crew member.
- **Pins are kept on the Command server** (`widget-pins.json`, owner-only) and shared by every
  device over the comms stream. A pin goes when its thread is archived or removed, or when its
  machine is removed. The widget's files and feeder stay in the workspace.
