import assert from "node:assert/strict";
import test from "node:test";
import { diskLevel, parseStorageOutput, storageCommand, storageDone, tightestVolume } from "../shared/storage.ts";

const GB = 1024 ** 3;

test("POSIX terminal output parses, ignoring the echoed command, prompts and escape codes", () => {
  const raw = [
    "\x1b]0;agent@tls-agent-02: ~/src\x07agent@tls-agent-02:~/src$ printf '%s\\n' __T3C_BEGIN__; df -Pk '/home/agent/src' 2>/dev/null; printf '%s\\n' __T3C_WT__; nice -n 19 du -sk \"$HOME\"/.t3/worktrees/*/* 2>/dev/null; printf '%s\\n' __T3C_END__",
    "\r__T3C_BEGIN__",
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/sda1        120791536 118496472   2278680      99% /",
    "/dev/sdb1         10000000   5000000   5000000      50% /mnt/big disk",
    "__T3C_WT__",
    "52428800\t/home/agent/.t3/worktrees/the-living-stone/t3code-1a2b",
    "1048576\t/home/agent/.t3/worktrees/other/t3code-9f/",
    "__T3C_END__",
    "\x1b]0;agent@tls-agent-02: ~/src\x07agent@tls-agent-02:~/src$ ",
  ].join("\r\n");
  const r = parseStorageOutput(raw, 1000, true)!;
  assert.deepEqual(r.volumes.map((v) => [v.mount, v.totalBytes, v.availableBytes]), [["/", 120791536 * 1024, 2278680 * 1024], ["/mnt/big disk", 10000000 * 1024, 5000000 * 1024]]);
  assert.deepEqual(r.worktrees!.entries, [
    { path: "/home/agent/.t3/worktrees/the-living-stone/t3code-1a2b", project: "the-living-stone", bytes: 50 * GB },
    { path: "/home/agent/.t3/worktrees/other/t3code-9f", project: "other", bytes: GB },
  ]);
  assert.equal(r.worktrees!.totalBytes, 51 * GB);
  assert.equal(tightestVolume(r.volumes)!.mount, "/");
});

test("PowerShell output parses drives and worktree folders", () => {
  const raw = ["PS C:\\Users\\w> Write-Output '__T3C_BEGIN__'; …", "__T3C_BEGIN__", `PSDRIVE C ${400 * GB} ${100 * GB}`, "__T3C_WT__", `WT ${3 * GB} C:\\Users\\w\\.t3\\worktrees\\the-living-stone\\t3code-77`, "__T3C_END__", "PS C:\\Users\\w> "].join("\r\n");
  const r = parseStorageOutput(raw, 1, true)!;
  assert.deepEqual(r.volumes, [{ mount: "C:", totalBytes: 500 * GB, usedBytes: 400 * GB, availableBytes: 100 * GB }]);
  assert.deepEqual(r.worktrees!.entries, [{ path: "C:\\Users\\w\\.t3\\worktrees\\the-living-stone\\t3code-77", project: "the-living-stone", bytes: 3 * GB }]);
});

test("the scratch folder is measured on its own, not as a worktree", () => {
  const posix = parseStorageOutput(["__T3C_BEGIN__", "__T3C_WT__", "2048\t/home/agent/.t3/worktrees/p/scratch", "4096\t/home/agent/.t3/scratch", "__T3C_END__"].join("\n"), 1, true)!;
  assert.equal(posix.worktrees!.scratchBytes, 4096 * 1024);
  assert.deepEqual(posix.worktrees!.entries.map((e) => e.project), ["p"]);
  assert.equal(posix.worktrees!.totalBytes, 2048 * 1024);
  const ps = parseStorageOutput(["__T3C_BEGIN__", "__T3C_WT__", `WT ${GB} C:\\Users\\w\\.t3\\scratch`, "__T3C_END__"].join("\r\n"), 1, true)!;
  assert.equal(ps.worktrees!.scratchBytes, GB);
  assert.equal(ps.worktrees!.entries.length, 0);
  // No scratch folder on the machine: nothing reported, rather than zero.
  assert.equal(parseStorageOutput("__T3C_BEGIN__\n__T3C_WT__\n__T3C_END__", 1, true)!.worktrees!.scratchBytes, undefined);
  assert.match(storageCommand(["/x"], true, false), /"\$HOME"\/\.t3\/scratch/);
  assert.match(storageCommand(["C:\\x"], true, true), /USERPROFILE\\\.t3\\scratch/);
});

test("incomplete output (command still running or failed) yields nothing rather than zeros", () => {
  assert.equal(parseStorageOutput("__T3C_BEGIN__\nFilesystem ...\n", 1, false), undefined);
  assert.equal(parseStorageOutput("printf: command not found", 1, false), undefined);
});

test("commands quote paths for their shell and only measure worktrees when asked", () => {
  const posix = storageCommand(["/home/a b/it's"], false, false);
  assert.match(posix, /df -Pk '\/home\/a b\/it'\\''s'/);
  assert.doesNotMatch(posix, /du -sk/);
  assert.match(storageCommand(["/x"], true, false), /nice -n 19 du -sk "\$HOME"\/\.t3\/worktrees\/\*\/\*/);
  const ps = storageCommand(["C:\\Users\\o'brien"], true, true);
  assert.match(ps, /'C:\\Users\\o''brien'/);
  assert.match(ps, /\.t3\\worktrees/);
});

test("low space is judged by what's left, not percentage alone", () => {
  const v = (total: number, available: number) => ({ mount: "/", totalBytes: total * GB, usedBytes: (total - available) * GB, availableBytes: available * GB });
  assert.equal(diskLevel(v(120, 2.2)), "critical");
  assert.equal(diskLevel(v(120, 12)), "high");
  assert.equal(diskLevel(v(2000, 160)), "high", "8% free is low even with room");
  assert.equal(diskLevel(v(2000, 400)), "ok");
  assert.equal(diskLevel(v(120, 86)), "ok");
});

test("Windows repaints that move the cursor instead of printing newlines still parse", () => {
  const raw = "\x1b[?25l\x1b[2J\x1b[HPS C:\\w> Write-Output '__T3C_BEGIN__'; …\x1b[3;1H__T3C_BEGIN__\x1b[4;1HPSDRIVE C 300 700\x1b[5;1H__T3C_WT__\x1b[6;1H__T3C_END__\x1b[7;1HPS C:\\w> ";
  assert.equal(storageDone(raw), true);
  assert.deepEqual(parseStorageOutput(raw, 1, false)!.volumes, [{ mount: "C:", totalBytes: 1000, usedBytes: 300, availableBytes: 700 }]);
  assert.equal(storageDone("PS> Write-Output '__T3C_END__'"), false, "the echoed command isn't the marker");
});


test("a failed read keeps the last good disk numbers, with the error attached", async () => {
  const { StorageMonitor } = await import("./storage.ts");
  const registry = { ids: () => ["e1"], get: () => ({ id: "e1" }) } as unknown as ConstructorParameters<typeof StorageMonitor>[1];
  const monitor = new StorageMonitor("/nonexistent", registry, {} as ConstructorParameters<typeof StorageMonitor>[2]);
  const record = (monitor as unknown as { record(envId: string, r: object): void }).record.bind(monitor);
  const now = Date.now();
  const good = { sampledAt: now - 60_000, volumes: [{ mount: "/", totalBytes: 100 * GB, usedBytes: 98 * GB, availableBytes: 2 * GB }] };
  record("e1", good);
  record("e1", { sampledAt: now, volumes: [], error: "Could not read disk usage" });
  const [view] = monitor.views();
  assert.equal(view.latest!.sampledAt, now - 60_000, "keeps the good sample's time so it ages into stale");
  assert.deepEqual(view.latest!.volumes, good.volumes);
  assert.equal(view.latest!.error, "Could not read disk usage");
  assert.equal(view.trend.length, 1);
});
