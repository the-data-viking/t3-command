import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface Config {
  /** Always 127.0.0.1: the only way in from other devices is `tailscale serve`. */
  host: string;
  port: number;
  dataDir: string;
  /** Lower-cased Tailscale login names allowed to use the UI. */
  allowedUsers: Set<string>;
  /** Skip the Tailscale identity check. Local experimenting only. */
  devNoAuth: boolean;
  /** Extra origins accepted on state-changing requests and WebSocket upgrades. */
  allowedOrigins: Set<string>;
  staticDir: string;
  hermesCommand: string;
  hermesArgs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    host: "127.0.0.1",
    port: Number(env.T3C_PORT ?? 4773),
    dataDir: path.resolve(expandHome(env.T3C_DATA_DIR ?? "~/.t3-command")),
    allowedUsers: new Set(list(env.T3C_ALLOWED_USERS).map((u) => u.toLowerCase())),
    devNoAuth: env.T3C_DEV_NO_AUTH === "1",
    allowedOrigins: new Set(list(env.T3C_ALLOWED_ORIGINS)),
    staticDir: path.resolve(here, "../dist"),
    hermesCommand: env.T3C_HERMES_COMMAND || "hermes",
    hermesArgs: JSON.parse(env.T3C_HERMES_ARGS ?? '["acp"]') as string[],
  };
  if (!Array.isArray(config.hermesArgs) || !config.hermesArgs.every((arg) => typeof arg === "string")) {
    throw new Error("T3C_HERMES_ARGS must be a JSON array of strings");
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error(`T3C_PORT must be a port number, got ${env.T3C_PORT}`);
  }
  if (!config.devNoAuth && config.allowedUsers.size === 0) {
    throw new Error(
      "Set T3C_ALLOWED_USERS to the Tailscale login(s) allowed to use t3-command " +
        "(or T3C_DEV_NO_AUTH=1 for local experimenting only).",
    );
  }
  return config;
}
