import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { UpdatePhase, UpdateStatus } from "../shared/api.ts";

export interface UpdaterOptions {
  root: string;
  remote?: string;
  enabled: boolean;
  currentCommit: string | null;
  localChanges: boolean;
  activate: () => void;
  beforeActivate?: () => Promise<void>;
}

const BUSY: UpdatePhase[] = ["checking", "fetching", "installing", "building", "restarting"];
const LOG_LIMIT = 16_000;

export class UpdateConflict extends Error {}

/** Fixed commands and origin/main only; the browser never supplies a path, ref, or command. */
export class Updater {
  private options: UpdaterOptions;
  private state: UpdateStatus;
  private busy = false;
  private logWrites: Promise<void> = Promise.resolve();
  private task: Promise<void> = Promise.resolve();

  constructor(options: UpdaterOptions) {
    this.options = options;
    const enabled = options.enabled && !!options.remote;
    this.state = {
      enabled, reason: enabled ? undefined : "Start the service with tools/managed-launcher.mjs to enable updates from main.",
      phase: "idle", currentCommit: options.currentCommit, localChanges: options.localChanges,
      latestCommit: null, targetCommit: null, message: "Check main for updates.", log: "", updatedAt: new Date().toISOString(),
    };
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.options.root, "status.json"), "utf8")) as UpdateStatus;
      this.state = { ...saved, enabled: this.state.enabled, reason: this.state.reason,
        currentCommit: this.options.currentCommit, localChanges: this.options.localChanges };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async status(): Promise<UpdateStatus> {
    // The launcher records startup success/rollback after the server has loaded.
    if (!this.busy) await this.load();
    return { ...this.state };
  }
  async settled(): Promise<void> { await this.task; }

  async start(action: "check" | "deploy"): Promise<UpdateStatus> {
    if (!this.busy) await this.load();
    if (!this.state.enabled) throw new UpdateConflict(this.state.reason);
    if (this.busy || BUSY.includes(this.state.phase)) throw new UpdateConflict("An update is already in progress.");
    this.busy = true;
    try {
      await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
      const lock = await fs.open(path.join(this.options.root, "lock"), "wx", 0o600);
      await lock.writeFile(String(process.pid));
      await lock.close();
    } catch (error) {
      this.busy = false;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UpdateConflict("Another updater holds the deployment lock.");
      throw error;
    }
    this.state.log = "";
    this.state.targetCommit = null;
    try {
      await this.phase(action === "check" ? "checking" : "fetching", action === "check" ? "Checking origin/main…" : "Fetching origin/main…");
    } catch (error) {
      this.busy = false;
      await fs.rm(path.join(this.options.root, "lock"), { force: true });
      throw error;
    }
    this.task = this.run(action).catch((error: unknown) => {
      this.state.phase = "failed";
      this.state.message = (error as Error).message;
      this.busy = false;
      console.error("Could not persist updater state", error);
    });
    return this.status();
  }

  private async save(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const text = JSON.stringify(this.state);
    this.logWrites = this.logWrites.then(async () => {
      const file = path.join(this.options.root, "status.json");
      await fs.writeFile(`${file}.pending`, text, { mode: 0o600 });
      await fs.rename(`${file}.pending`, file);
    });
    await this.logWrites;
  }

  private async phase(phase: UpdatePhase, message: string): Promise<void> {
    this.state.phase = phase;
    this.state.message = message;
    await this.save();
  }

  private command(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
        shell: process.platform === "win32" && command === "npm.cmd" });
      let output = "";
      let timedOut = false;
      const append = (data: Buffer) => {
        const text = data.toString().replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
        output = (output + text).slice(-LOG_LIMIT);
        this.state.log = (this.state.log + text).slice(-LOG_LIMIT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else child.kill("SIGKILL");
      }, 10 * 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve(output.trim());
        else reject(new Error(timedOut ? `${command} timed out.` : `${command} failed (exit ${code ?? "unknown"}). See the build log.`));
      });
    });
  }

  private async run(action: "check" | "deploy"): Promise<void> {
    let staging: string | undefined;
    let activated = false;
    try {
      if (action === "check") {
        const refs = await this.command("git", ["ls-remote", "--exit-code", "--", this.options.remote!, "refs/heads/main"]);
        const commit = refs.split(/\s+/)[0];
        if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("main did not resolve to a commit.");
        this.state.latestCommit = commit;
        await this.phase("available", commit === this.state.currentCommit ? "Already on main. You can redeploy the same commit." : "main is ready to deploy.");
        return;
      }
      staging = await fs.mkdtemp(path.join(this.options.root, "staging-"));
      const checkout = path.join(staging, "release");
      await this.command("git", ["clone", "--depth", "1", "--single-branch", "--branch", "main", "--", this.options.remote!, checkout]);
      const commit = await this.command("git", ["rev-parse", "HEAD"], checkout);
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid release commit.");
      this.state.latestCommit = commit;
      this.state.targetCommit = commit;
      const pkg = JSON.parse(await fs.readFile(path.join(checkout, "package.json"), "utf8")) as { managedUpdateProtocol?: number };
      if (pkg.managedUpdateProtocol !== 1) throw new Error("main does not support managed updates yet. Merge the web-update change before deploying main.");
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      await this.phase("installing", "Installing release dependencies…");
      await this.command(npm, ["ci", "--include=dev", "--no-audit", "--no-fund"], checkout);
      await this.phase("building", "Building the new release…");
      await this.command(npm, ["run", "build"], checkout);
      await fs.access(path.join(checkout, "dist", "index.html"));
      await fs.access(path.join(checkout, "server", "index.ts"));
      await this.options.beforeActivate?.();
      const releases = path.join(this.options.root, "releases");
      await fs.mkdir(releases, { recursive: true, mode: 0o700 });
      const directory = path.join(releases, `${commit}-${path.basename(staging)}`);
      await fs.rename(checkout, directory);
      let previous: unknown;
      try { previous = (JSON.parse(await fs.readFile(path.join(this.options.root, "activation.json"), "utf8")) as { active: unknown }).active; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const activation = path.join(this.options.root, "activation.json");
      await fs.writeFile(`${activation}.pending`, JSON.stringify({ active: { directory, commit }, previous }), { mode: 0o600 });
      await this.phase("restarting", "Starting the new release. Reconnecting…");
      await fs.rename(`${activation}.pending`, activation);
      activated = true;
      this.options.activate();
    } catch (error) {
      await this.phase("failed", (error as Error).message);
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
      if (!activated) {
        this.busy = false;
        await fs.rm(path.join(this.options.root, "lock"), { force: true });
      }
    }
  }
}
