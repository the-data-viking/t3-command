// Desktop releases renamed Alpha to Beta in 0.1.0. Invoke the installed app's
// bundled CLI with Electron's Node mode; pairing credentials stay in memory.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function findT3Cli(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): [string, string[], NodeJS.ProcessEnv] {
  if (env.T3_CLI) return [env.T3_CLI, [], {}];
  const names = ["T3 Code (Beta)", "T3 Code (Alpha)", "T3 Code"];
  for (const name of names) {
    const roots = platform === "darwin" ? ["/Applications", path.join(os.homedir(), "Applications")] : [];
    for (const root of roots) {
      const app = path.join(root, `${name}.app`, "Contents");
      const exe = path.join(app, "MacOS", name);
      const bundle = path.join(app, "Resources", "app.asar");
      if (exists(exe) && exists(bundle)) return [exe, [path.join(bundle, "apps", "server", "dist", "bin.mjs")], { ELECTRON_RUN_AS_NODE: "1" }];
    }
    if (platform === "win32") {
      const root = path.join(env.LOCALAPPDATA ?? "", "Programs", "t3code");
      const exe = path.join(root, `${name}.exe`);
      for (const bundle of name === "T3 Code (Alpha)" ? ["server.asar", "app.asar"] : ["app.asar", "server.asar"]) {
        const asar = path.join(root, "resources", bundle);
        if (exists(exe) && exists(asar)) return [exe, [path.join(asar, "apps", "server", "dist", "bin.mjs")], { ELECTRON_RUN_AS_NODE: "1" }];
      }
    }
  }
  return ["t3", [], {}];
}
