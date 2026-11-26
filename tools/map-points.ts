/**
 * map-points.ts
 *
 * Dispatcher: runs the point-mapping sub-steps that fit the building's data shape
 * (from data/<buildingId>/building-config.json).
 *   timeseries -> split-pointlist-csv.ts, map-plant-points.ts, map-zone-points.ts
 *   bacnet     -> map-bacnet-points.ts
 *
 * Usage:
 *   npx ts-node tools/map-points.ts <buildingId> [--force]
 */

import { spawnSync } from "child_process";
import { loadProfile, DataShape } from "./lib/building-profile";

const buildingId = process.argv[2];
if (!buildingId || buildingId.startsWith("--")) {
  console.error("Usage: npx ts-node tools/map-points.ts <buildingId> [--force]");
  process.exit(1);
}
const force = process.argv.includes("--force");

const STEPS: Record<DataShape, string[]> = {
  timeseries: ["split-pointlist-csv.ts", "map-plant-points.ts", "map-zone-points.ts"],
  bacnet: ["map-bacnet-points.ts"],
};

let steps: string[];
try {
  steps = STEPS[loadProfile(buildingId).dataShape];
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

for (const step of steps) {
  // split-pointlist-csv.ts has no --force (it always overwrites its outputs)
  const flag = force && step !== "split-pointlist-csv.ts" ? " --force" : "";
  const cmd = `npx ts-node tools/${step} ${buildingId}${flag}`;
  console.log(`\n== ${cmd}`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
