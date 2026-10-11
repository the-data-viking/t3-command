#!/usr/bin/env node
// Pair the T3 Code instance on THIS machine with the t3-command server on this machine.
//
// Runs T3's own CLI to mint a one-time pairing credential, then hands it straight to
// t3-command (POST /api/envs), which exchanges it for a token. The credential is never printed.
//
// Usage: npm run pair:local -- [--user you@example.com] [--label "My desktop"] [--t3-url http://127.0.0.1:3773]
//   --user   your Tailscale login; needed unless t3-command runs with T3C_DEV_NO_AUTH=1
//
// Env: T3C_PORT (t3-command port, default 4773), T3_HOME (T3 data dir, default ~/.t3),
//      T3_CLI (path to a `t3` executable, for headless installs)

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);

const { values: args } = parseArgs({
  options: {
    user: { type: "string" },
    label: { type: "string" },
    "t3-url": { type: "string", default: "http://127.0.0.1:3773" },
  },
});

const t3Home = process.env.T3_HOME ?? path.join(os.homedir(), ".t3");
const commandUrl = `http://127.0.0.1:${process.env.T3C_PORT ?? 4773}`;

/** How to invoke T3's CLI on this machine: [executable, leadingArgs, extraEnv]. */
function findT3Cli() {
  if (process.env.T3_CLI) return [process.env.T3_CLI, [], {}];

  const desktopInstalls = {
    win32: [
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "t3code", "T3 Code (Alpha).exe"),
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "t3code", "resources", "server.asar"),
    ],
    darwin: [
      "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
      "/Applications/T3 Code (Alpha).app/Contents/Resources/server.asar",
    ],
  }[process.platform];

  if (desktopInstalls && existsSync(desktopInstalls[0])) {
    const [exe, asar] = desktopInstalls;
    // The desktop app's Electron binary doubles as Node for its bundled server CLI.
    return [exe, [path.join(asar, "apps", "server", "dist", "bin.mjs")], { ELECTRON_RUN_AS_NODE: "1" }];
  }
  return ["t3", [], {}]; // headless install on PATH
}

const [exe, leadingArgs, extraEnv] = findT3Cli();
let pairing;
try {
  const { stdout } = await run(
    exe,
    [...leadingArgs, "auth", "pairing", "create", "--base-dir", t3Home, "--label", "t3-command", "--ttl", "5m", "--json"],
    { env: { ...process.env, ...extraEnv }, windowsHide: true },
  );
  pairing = JSON.parse(stdout.slice(stdout.indexOf("{")));
} catch (err) {
  console.error(`Couldn't create a pairing credential with T3's CLI (${exe}).`);
  console.error("Set T3_CLI to your `t3` executable, or create a pairing link in T3 → Settings → Connections instead.");
  console.error(String(err.stderr || err.message).split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}

const headers = { "content-type": "application/json" };
if (args.user) headers["tailscale-user-login"] = args.user;

let res;
try {
  res = await fetch(`${commandUrl}/api/envs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: args["t3-url"], credential: pairing.credential, label: args.label }),
  });
} catch (err) {
  console.error(`Couldn't reach t3-command at ${commandUrl}. Is it running? (${err.message})`);
  process.exit(1);
}
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`t3-command refused the pairing: ${body.error ?? res.status}`);
  if (res.status === 403) console.error("Pass --user <your Tailscale login>, or run t3-command with T3C_DEV_NO_AUTH=1.");
  process.exit(1);
}
console.log(`Paired "${body.label}" (${body.url}) — status: ${body.status}`);
