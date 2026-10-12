import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Updater } from "./updater.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const read = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const temporary = async (t: { after: (fn: () => Promise<unknown>) => void }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function fixture(root: string) {
  const repo = path.join(root, "origin");
  await fs.mkdir(path.join(repo, "server"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "update-fixture", version: "1.0.0", managedUpdateProtocol: 1,
    type: "module", scripts: { build: "node build.mjs" } }));
  await fs.writeFile(path.join(repo, "package-lock.json"), JSON.stringify({ name: "update-fixture", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "update-fixture", version: "1.0.0" } } }));
  await fs.writeFile(path.join(repo, "build.mjs"), "import fs from 'node:fs'; fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html', 'new release');");
  await fs.writeFile(path.join(repo, "server/index.ts"), "process.send?.({type:'t3-command-ready'}); console.log('fixture ready'); setInterval(() => {}, 1000);");
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Fixture release");
  return repo;
}

test("updates build an isolated main release, reject concurrent requests, and preserve the working checkout", async t => {
  const dir = await temporary(t);
  const repo = await fixture(dir);
  const commit = await git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "local-work.txt"), "keep this local work");
  const root = path.join(dir, "updates");
  await fs.mkdir(root);
  const previous = { directory: repo, commit: "previous" };
  await fs.writeFile(path.join(root, "activation.json"), JSON.stringify({ active: previous }));
  let activated = false;
  const updater = new Updater({ root, remote: repo, enabled: true, currentCommit: "previous", localChanges: true, activate: () => { activated = true; } });
  await updater.start("check");
  await updater.settled();
  assert.equal((await updater.status()).latestCommit, commit);
  assert.equal((await updater.start("deploy")).phase, "fetching");
  await assert.rejects(updater.start("deploy"), /already in progress/);
  const concurrent = new Updater({ root, remote: repo, enabled: true, currentCommit: "previous", localChanges: true, activate: () => {} });
  await assert.rejects(concurrent.start("deploy"), /already in progress|deployment lock/);
  await updater.settled();
  assert.equal(activated, true);
  assert.equal((await updater.status()).phase, "restarting");
  const activation = await read(path.join(root, "activation.json"));
  assert.equal(activation.active.commit, commit);
  assert.deepEqual(activation.previous, previous);
  assert.equal(await fs.readFile(path.join(activation.active.directory, "dist/index.html"), "utf8"), "new release");
  assert.equal(await fs.readFile(path.join(repo, "local-work.txt"), "utf8"), "keep this local work");
  assert.match(await git(repo, "status", "--porcelain"), /local-work.txt/);
});

test("failed builds leave the active release unchanged and release the deployment lock", async t => {
  const dir = await temporary(t);
  const repo = await fixture(dir);
  await fs.writeFile(path.join(repo, "build.mjs"), "console.error('intentional build failure'); process.exit(1);");
  await git(repo, "add", "."); await git(repo, "commit", "-m", "Broken build");
  const root = path.join(dir, "updates"); await fs.mkdir(root);
  const previous = { active: { directory: repo, commit: "previous" } };
  await fs.writeFile(path.join(root, "activation.json"), JSON.stringify(previous));
  const updater = new Updater({ root, remote: repo, enabled: true, currentCommit: "previous", localChanges: false,
    activate: () => assert.fail("A failed build must not restart the service") });
  await updater.start("deploy"); await updater.settled();
  const result = await updater.status();
  assert.equal(result.phase, "failed");
  assert.match(result.log, /intentional build failure/);
  assert.deepEqual(await read(path.join(root, "activation.json")), previous);
  await assert.rejects(fs.access(path.join(root, "lock")));
  await updater.start("check"); await updater.settled();
  assert.equal((await updater.status()).phase, "available");
});

test("an older main without managed updates cannot replace the current service", async t => {
  const dir = await temporary(t);
  const repo = await fixture(dir);
  const pkg = await read(path.join(repo, "package.json")); delete pkg.managedUpdateProtocol;
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(pkg));
  await git(repo, "add", "."); await git(repo, "commit", "-m", "Old release");
  const updater = new Updater({ root: path.join(dir, "updates"), remote: repo, enabled: true, currentCommit: null, localChanges: false,
    activate: () => assert.fail("An incompatible release must not activate") });
  await updater.start("deploy"); await updater.settled();
  assert.match((await updater.status()).message, /does not support managed updates/);
});

test("a worker becoming busy during the build prevents activation", async t => {
  const dir = await temporary(t);
  const repo = await fixture(dir);
  const root = path.join(dir, "updates"); await fs.mkdir(root);
  const previous = { active: { directory: repo, commit: "previous" } };
  await fs.writeFile(path.join(root, "activation.json"), JSON.stringify(previous));
  const updater = new Updater({ root, remote: repo, enabled: true, currentCommit: "previous", localChanges: false,
    beforeActivate: async () => { throw new Error("Local worker is running"); },
    activate: () => assert.fail("A busy worker must not be interrupted") });
  await updater.start("deploy"); await updater.settled();
  assert.equal((await updater.status()).phase, "failed");
  assert.match((await updater.status()).message, /Local worker is running/);
  assert.deepEqual(await read(path.join(root, "activation.json")), previous);
});

async function waitFor(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for launcher state");
}

test("managed launcher restores the previous release when the new server exits before readiness", async t => {
  const dir = await temporary(t);
  const install = await fixture(dir);
  const root = path.join(dir, "updates");
  const broken = path.join(root, "releases", "broken");
  await fs.mkdir(path.join(broken, "server"), { recursive: true });
  await fs.writeFile(path.join(broken, "server/index.ts"), "process.exit(1);");
  await fs.writeFile(path.join(root, "activation.json"), JSON.stringify({ active: { directory: broken, commit: "bad" }, previous: { directory: install, commit: "good" } }));
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ phase: "restarting", targetCommit: "bad" }));
  const launcher = spawn(process.execPath, ["tools/managed-launcher.mjs"], {
    env: { ...process.env, T3C_INSTALL_DIR: install, T3C_DATA_DIR: dir, T3C_UPDATE_ROOT: root }, stdio: "pipe",
  });
  t.after(async () => { launcher.kill("SIGTERM"); if (launcher.exitCode === null) await once(launcher, "exit"); });
  await waitFor(async () => (await read(path.join(root, "status.json"))).phase === "failed");
  const status = await read(path.join(root, "status.json"));
  assert.match(status.message, /failed to start.*Restored the previous release/);
  assert.equal((await read(path.join(root, "activation.json"))).active.commit, "good");
});

test("managed launcher confirms successful startup and the new server reads its finalized status", async t => {
  const dir = await temporary(t);
  const install = await fixture(dir);
  const root = path.join(dir, "updates");
  const release = path.join(root, "releases", "ready");
  await fs.mkdir(path.join(root, "releases"), { recursive: true });
  await fs.cp(install, release, { recursive: true });
  await fs.writeFile(path.join(root, "activation.json"), JSON.stringify({ active: { directory: release, commit: "new" }, previous: { directory: install, commit: "old" } }));
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ phase: "restarting", targetCommit: "new" }));
  // Simulate a server that loaded status before the launcher received its ready signal.
  const updater = new Updater({ root, remote: install, enabled: true, currentCommit: "new", localChanges: false, activate: () => {} });
  await updater.load();
  const launcher = spawn(process.execPath, ["tools/managed-launcher.mjs"], {
    env: { ...process.env, T3C_INSTALL_DIR: install, T3C_DATA_DIR: dir, T3C_UPDATE_ROOT: root }, stdio: "pipe",
  });
  t.after(async () => { launcher.kill("SIGTERM"); if (launcher.exitCode === null) await once(launcher, "exit"); });
  await waitFor(async () => (await read(path.join(root, "status.json"))).phase === "succeeded");
  assert.equal((await updater.status()).phase, "succeeded");
  assert.equal((await updater.status()).currentCommit, "new");
  assert.equal((await read(path.join(root, "activation.json"))).active.directory, release);
});

test("update APIs require authentication, block cross-origin writes, and refuse browser command overrides", async t => {
  const dir = await temporary(t);
  const reservation = http.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, T3C_DATA_DIR: dir, T3C_PORT: String(port),
    T3C_DEV_NO_AUTH: "0", T3C_ALLOWED_USERS: "test@example.com", T3C_MANAGED_UPDATES: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, "exit"); });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/me`)).status === 403; } catch { return false; } });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "Tailscale-User-Login": "test@example.com", "content-type": "application/json" };
  assert.equal((await fetch(`${base}/api/update`)).status, 403);
  assert.equal((await fetch(`${base}/api/update`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/update`, { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/update`, { method: "POST", headers, body: JSON.stringify({ command: "touch bad" }) })).status, 400);
  assert.equal((await fetch(`${base}/api/update`, { method: "POST", headers, body: "{}" })).status, 409);
  const status = await (await fetch(`${base}/api/update`, { headers })).json() as { enabled: boolean };
  assert.equal(status.enabled, false);
});
