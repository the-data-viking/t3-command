# t3-command

An RTS-style alternative frontend for [T3 Code](https://github.com/pingdotgg/t3code).
Your agent threads are worker units on a map. Select one to give it orders, watch it work,
and respond to approval requests when they come up.

> **Unofficial, early, and experimental.** This project isn't affiliated with T3 / Ping. It talks to
> T3 Code's *internal* server protocol (see [`docs/PROTOCOL.md`](docs/PROTOCOL.md)), which changes
> between alpha releases. The stock T3 Code UI is untouched and remains your fallback.

## Status

Scaffolding only. Nothing is playable yet.

## How it works

T3 Code's desktop app runs a local server (default port `3773`) that its own UI connects to over a
WebSocket. t3-command is a second, independent client of that same server:

- Its login is separate from the stock UI's. It appears under **Settings → Connections** in T3 Code and can be revoked there.
- It's a static web app, so it doesn't have to run on the same machine as T3 Code.
- On startup it checks the server's orchestration protocol version and refuses to run against one it doesn't support.

Supported T3 Code orchestration protocol: **v1** (T3 Code 0.0.44).

## Development

```sh
npm install
npm run dev
```

## Deploying over Tailscale (planned)

1. On the T3 Code host, put the T3 server behind HTTPS so browsers allow a secure `wss://`
   connection to it: `tailscale serve --bg --https=3773 http://127.0.0.1:3773`
2. Build and serve this UI anywhere on your tailnet: `npm run build`, then serve `dist/`
   (for example `tailscale serve --bg ./dist`).
3. Generate a one-time pairing code on the T3 host (helper script coming), open the UI, and enter
   the T3 server URL and the code.

An HTTPS page can't open a plain `ws://` connection, so if the UI is on HTTPS, T3 must be too.

## Tools

- `tools/extract-rpcs.mjs` regenerates the RPC method list (`tools/rpcs.tsv`) from an installed T3 Code server bundle, so you can diff protocol changes after a T3 update.
