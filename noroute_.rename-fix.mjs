import { readFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = "F:/Project/norouter";
const WIN = process.platform === "win32";
const SKIP = new Set(["install.sh", "install.ps1", "run.cmd", "install.cmd", "norouter.cmd"]);

function mv(from, to) {
  try {
    renameSync(join(root, from), join(root, to));
    console.log("mk", to);
  } catch (e) {
    console.error("skip", from, e.message);
  }
}

// bin, src, test, docs, data, .env, config.local.json, *.cmd, run.cmd
for (const f of ["bin", "src", "test", "docs", "data", ".env", "config.local.json"]) {
  if (SKIP.has(f)) continue;
  mv(f, "noroute_" + f);
}
mv("norouter.cmd", "noroute.cmd");
mv("run.cmd", "noroute_run.cmd");

// Root scratch files (zero-byte) and anything else top-level not in skip set
for (const f of readdirSync(root)) {
  if (f.startsWith("noroute")) continue;
  if (SKIP.has(f)) continue;
  mv(f, "noroute_" + f);
}
