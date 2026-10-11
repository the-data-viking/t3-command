// Reads the connections T3 Code desktop has saved on this machine ("linked" bases).
//
// T3 desktop keeps its connection catalog encrypted with Electron safeStorage, which is
// Chromium's os_crypt scheme. We decrypt it in memory as the same OS user, keep only what a
// linked base needs, and never write the tokens anywhere: they're re-read from the catalog
// whenever needed, so they stay encrypted at rest and follow T3 desktop's own re-pairing.
//
// Tested on Windows. macOS and Linux follow Chromium's documented key derivation but haven't
// been run against a real T3 install yet.

import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class CatalogError extends Error {}

export interface DesktopConnection {
  environmentId: string;
  connectionId: string;
  label: string;
  httpBaseUrl: string;
  token: string;
}

/** T3 desktop's Electron app name: its userData folder and keychain/keyring entries use it. */
const APP_NAME = process.env.T3C_DESKTOP_APP_NAME ?? "t3code";
const CACHE_MS = 60_000;

function t3Home(): string {
  return process.env.T3_HOME ?? path.join(os.homedir(), ".t3");
}

function electronUserData(): string {
  if (process.env.T3C_DESKTOP_USER_DATA) return process.env.T3C_DESKTOP_USER_DATA;
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP_NAME);
  }
}

// ---- Chromium os_crypt ----------------------------------------------------------------

/** Windows: AES-256-GCM with a DPAPI-protected key from "Local State". */
async function decryptWindows(blob: Buffer): Promise<string> {
  const localState = JSON.parse(await fs.readFile(path.join(electronUserData(), "Local State"), "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const wrapped = localState.os_crypt?.encrypted_key;
  if (!wrapped) throw new CatalogError("T3 desktop's encryption key is missing from Local State");
  const dpapiBlob = Buffer.from(wrapped, "base64").subarray("DPAPI".length);
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  const output = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new CatalogError("Windows refused to unlock T3 desktop's key (DPAPI)"))));
  });
  child.stdin?.end(dpapiBlob.toString("base64"));
  const key = Buffer.from(await output, "base64");

  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]).toString("utf8");
}

/** macOS/Linux: AES-128-CBC with a PBKDF2 key derived from a keychain/keyring password. */
function decryptCbc(blob: Buffer, password: string, iterations: number): string {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8");
}

async function macPassword(): Promise<string> {
  for (const service of [`${APP_NAME} Safe Storage`, "T3 Code (Alpha) Safe Storage", "T3 Code Safe Storage"]) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-w", "-s", service]);
      if (stdout.trim()) return stdout.trim();
    } catch {
      // try the next name
    }
  }
  throw new CatalogError("Couldn't read T3 desktop's key from the macOS Keychain");
}

async function linuxPassword(): Promise<string> {
  try {
    const { stdout } = await run("secret-tool", ["lookup", "application", APP_NAME]);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through
  }
  throw new CatalogError("Couldn't read T3 desktop's key from the system keyring (secret-tool lookup application t3code)");
}

async function decrypt(blob: Buffer): Promise<string> {
  const version = blob.subarray(0, 3).toString();
  if (process.platform === "win32") {
    if (version !== "v10") throw new CatalogError(`Unexpected catalog format "${version}"`);
    return decryptWindows(blob);
  }
  if (process.platform === "darwin") return decryptCbc(blob, await macPassword(), 1003);
  // Linux: v10 uses Chromium's fixed fallback password (no keyring), v11 the keyring's.
  if (version === "v10") return decryptCbc(blob, "peanuts", 1);
  return decryptCbc(blob, await linuxPassword(), 1);
}

// ---- Catalog ---------------------------------------------------------------------------

interface Catalog {
  profiles?: Array<{ _tag: string; connectionId: string; environmentId: string; label: string; httpBaseUrl?: string }>;
  credentials?: Array<{ connectionId: string; credential?: { _tag?: string; token?: string } }>;
  disabledEnvironmentIds?: string[];
}

let cache: { at: number; connections: DesktopConnection[] } | undefined;

/** Bearer (direct URL) connections saved in T3 desktop on this machine. Tokens are in memory only. */
export async function readDesktopConnections(opts: { fresh?: boolean } = {}): Promise<DesktopConnection[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.connections;

  let file: string;
  try {
    file = await fs.readFile(path.join(t3Home(), "userdata", "connection-catalog.json"), "utf8");
  } catch {
    throw new CatalogError("No T3 desktop connections found on this machine (~/.t3/userdata/connection-catalog.json)");
  }
  const stored = JSON.parse(file) as { encryptedCatalog?: string };
  if (!stored.encryptedCatalog) throw new CatalogError("T3 desktop's connection catalog is empty");

  let catalog: Catalog;
  try {
    catalog = JSON.parse(await decrypt(Buffer.from(stored.encryptedCatalog, "base64"))) as Catalog;
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError(`Couldn't decrypt T3 desktop's connection catalog: ${(err as Error).message}`);
  }

  const disabled = new Set(catalog.disabledEnvironmentIds ?? []);
  const connections: DesktopConnection[] = [];
  for (const p of catalog.profiles ?? []) {
    if (p._tag !== "BearerConnectionProfile" || !p.httpBaseUrl || disabled.has(p.environmentId)) continue;
    const token = catalog.credentials?.find((c) => c.connectionId === p.connectionId)?.credential?.token;
    if (!token) continue;
    connections.push({
      environmentId: p.environmentId,
      connectionId: p.connectionId,
      label: p.label,
      httpBaseUrl: new URL(p.httpBaseUrl).origin,
      token,
    });
  }
  cache = { at: Date.now(), connections };
  return connections;
}

export function forgetCachedCatalog(): void {
  cache = undefined;
}
