# t3-command

An RTS-style alternative frontend for [T3 Code](https://github.com/pingdotgg/t3code).
Your agent threads, across every T3 environment you run, are worker units on a map. Select one to
give it orders, watch it work, and respond to approval requests when they come up.

> **Unofficial, early, and experimental.** This project isn't affiliated with T3 / Ping. It talks to
> T3 Code's *internal* server protocol (see [`docs/PROTOCOL.md`](docs/PROTOCOL.md)), which changes
> between alpha releases. The stock T3 Code UI is never modified and remains your fallback.

## Status

Playable, tested against T3 Code 0.0.44–0.0.45 across six environments. Fleet-command styling
(hand-authored pixel sprites, with Flight Deck in Night Shift as the default):

- **Stations**: every T3 environment is a station in a sector grid, with its own team color. Each
  project is a module docked to the station core, crewed by its threads.
- **Truthful telemetry** (borrowed from [StarNet](https://starnetos.com/)): the map never shows
  activity T3 can't prove. Consoles light up only during a real turn; crew walk to the terminal,
  file archive or comms dish only for a real open tool call; drones orbit crew for each running
  background task; a health bar shows how much context window is left.
- **Attention**: an always-on **Inbox** of everything waiting on you (approvals, questions, failed
  turns, reports), edge-of-screen arrows for off-screen alerts, and RTS hotkeys: **Space** next
  alert, **.** next report, **W** next active crew, **F** fit the fleet, **Esc** deselect.
- **Navigation**: sector minimap, station chips in the top bar that jump to their station, and
  station banners that stay readable when zoomed out.
- **Command**: select crew to read the live Markdown transcript with clickable links, give orders, halt, approve or deny tool
  use, or send them to quarters. Select a module to recruit new crew (a new thread) with any model.
  Imported CLI history lives in each module's archive pod. Drag the chat panel's left edge to resize it,
  use its arrow-key controls, or double-click the edge to reset; width is saved per browser.
- Synthesized sound effects (mutable) and a comms feed of events.

The map uses compact suited crew and wraparound system consoles. Switch between Night Shift
and warm Flight Deck plating with the style button. Existing Kestrel/Night Shift browser
preferences carry forward to the corresponding Flight Deck palette.

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
```

`T3C_DEV_NO_AUTH=1` turns off the Tailscale identity check so you can use it from localhost.
Never run it that way behind `tailscale serve`.

`npm run pair:local` uses the installed T3 Code desktop app's own CLI to create a one-time
pairing credential and hands it straight to the t3-command server, so it's never printed. On a
headless T3 install, set `T3_CLI` to your `t3` executable.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run build`.

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
