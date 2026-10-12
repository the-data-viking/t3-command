// Stable service entry point. Builds happen in separate releases; this launcher switches
// only after activation, and restores the previous release if startup fails.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const install = path.resolve(process.env.T3C_INSTALL_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const expandHome = p => p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
const dataDir = path.resolve(expandHome(process.env.T3C_DATA_DIR ?? "~/.t3-command"));
const root = path.resolve(expandHome(process.env.T3C_UPDATE_ROOT ?? path.join(dataDir, "updates")));
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const realRoot = await fs.realpath(root);
const activationFile = path.join(root, "activation.json");
const statusFile = path.join(root, "status.json");
const read = async file => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const write = async (file, value) => {
  await fs.writeFile(`${file}.launcher`, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(`${file}.launcher`, file);
};
const git = async (...args) => {
  try { return (await exec("git", ["-C", install, ...args], { timeout: 10_000 })).stdout.trim(); }
  catch { return null; }
};
const remote = process.env.T3C_UPDATE_REMOTE ?? await git("remote", "get-url", "origin");
const initial = { directory: install, commit: await git("rev-parse", "HEAD"), localChanges: !!await git("status", "--porcelain") };
if (!await read(activationFile)) await write(activationFile, { active: initial });
let stopping = false;
let child;
let stopTimer;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
    stopTimer = setTimeout(() => { child?.kill("SIGKILL"); }, 5000);
  });
}

async function resolveRelease(release) {
  const directory = await fs.realpath(release.directory);
  const releaseRoot = path.join(realRoot, "releases") + path.sep;
  if (directory !== await fs.realpath(install) && !directory.startsWith(releaseRoot)) throw new Error("Invalid release directory");
  await fs.access(path.join(directory, "server", "index.ts"));
  return directory;
}

async function startupResult(ok, active, message) {
  const status = await read(statusFile);
  if (status && ["checking", "fetching", "installing", "building", "restarting"].includes(status.phase)) {
    const success = ok && status.phase === "restarting" && status.targetCommit === active.commit;
    await write(statusFile, { ...status, currentCommit: active.commit, localChanges: !!active.localChanges,
      phase: success ? "succeeded" : "failed", updatedAt: new Date().toISOString(),
      message: success ? "Updated from main. The new release is running." : message ?? "The update was interrupted; the previous release is still running." });
  }
  await fs.rm(path.join(root, "lock"), { force: true });
  if (ok) {
    const activation = await read(activationFile);
    const keep = new Set([activation.active.directory, activation.previous?.directory].filter(Boolean));
    const releases = path.join(root, "releases");
    const entries = await fs.readdir(releases, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const directory = path.join(releases, entry.name);
      if (entry.isDirectory() && /^[a-f0-9]{40,64}-staging-/.test(entry.name) && !keep.has(directory)) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
}

while (!stopping) {
  const activation = await read(activationFile);
  const active = activation.active;
  let directory;
  try { directory = await resolveRelease(active); }
  catch (error) {
    if (!activation.previous) throw error;
    await write(activationFile, { active: activation.previous });
    await startupResult(false, activation.previous, "New release could not be loaded. Restored the previous release.");
    continue;
  }
  let ready = false;
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(directory, "server", "index.ts")], {
    cwd: directory, stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...process.env, T3C_DATA_DIR: dataDir, T3C_UPDATE_ROOT: root,
      ...(remote ? { T3C_UPDATE_REMOTE: remote } : {}), T3C_MANAGED_UPDATES: "1",
      T3C_RUNNING_COMMIT: active.commit ?? "", T3C_LOCAL_CHANGES: active.localChanges ? "1" : "0" },
  });
  let readyTask = Promise.resolve();
  const startupTimer = setTimeout(() => { console.error("Release startup timed out"); child.kill("SIGKILL"); }, 60_000);
  child.on("message", message => {
    if (message?.type !== "t3-command-ready" || ready) return;
    ready = true;
    clearTimeout(startupTimer);
    readyTask = startupResult(true, active).catch(error => { console.error(error); child.kill("SIGKILL"); });
  });
  await new Promise(resolve => {
    child.once("error", error => { console.error(error); resolve(); });
    child.once("exit", resolve);
  });
  clearTimeout(startupTimer);
  await readyTask;
  if (stopping) break;
  if (!ready && activation.previous) {
    await write(activationFile, { active: activation.previous });
    await startupResult(false, activation.previous, "New release failed to start. Restored the previous release.");
    continue;
  }
  // A successful update changes the activation file before the old server exits.
  const next = await read(activationFile);
  if (next.active.directory !== active.directory) continue;
  if (!ready) await startupResult(false, active, "Server failed to start.");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 3000 - (Date.now() - startedAt))));
}
clearTimeout(stopTimer);
