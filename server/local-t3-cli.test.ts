import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findT3Cli } from "./local-t3-cli.ts";

test("local pairing prefers Beta's bundled CLI and keeps Alpha and headless support", () => {
  const beta = "/Applications/T3 Code (Beta).app/Contents";
  const alpha = "/Applications/T3 Code (Alpha).app/Contents";
  const installed = (root: string) => (p: string) => p.startsWith(root);
  assert.deepEqual(findT3Cli("darwin", {}, installed(beta)), [path.join(beta, "MacOS", "T3 Code (Beta)"), [path.join(beta, "Resources/app.asar/apps/server/dist/bin.mjs")], { ELECTRON_RUN_AS_NODE: "1" }]);
  assert.equal(findT3Cli("darwin", {}, installed(alpha))[0], path.join(alpha, "MacOS", "T3 Code (Alpha)"));
  assert.deepEqual(findT3Cli("linux", {}, () => false), ["t3", [], {}]);
  assert.deepEqual(findT3Cli("darwin", { T3_CLI: "/custom/t3" }, () => true), ["/custom/t3", [], {}]);
});

test("Windows Beta pairing locates app.asar; older server.asar installs remain supported", () => {
  for (const [name, bundle] of [["T3 Code (Beta)", "app.asar"], ["T3 Code (Alpha)", "server.asar"]]) {
    const root = path.join("AppData", "Programs", "t3code");
    const files = [path.join(root, `${name}.exe`), path.join(root, "resources", bundle)];
    const [exe, args] = findT3Cli("win32", { LOCALAPPDATA: "AppData" }, (p) => files.includes(p) || p === path.join(root, "resources", "app.asar"));
    assert.equal(exe, files[0]);
    assert.equal(args[0], path.join(files[1], "apps/server/dist/bin.mjs"));
  }
});
