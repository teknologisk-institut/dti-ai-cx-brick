// tools/write-building-profile.ts
//
// Validate and write data/{buildingId}/building-config.json (the building profile).
//   echo '<json>' | npx ts-node tools/write-building-profile.ts <buildingId> [--force]
//   npx ts-node tools/write-building-profile.ts <buildingId> --validate
// Honours BUILDING_DATA_ROOT (default <repo>/data). Exit 1 on errors; warnings don't change the exit code.

import * as fs from "fs";
import * as path from "path";
import { checkBacnetProfileData } from "./lib/object-grammar-check";
import { validateProfile, checkProfileData, BuildingProfile, dataRoot } from "./lib/building-profile";

function fail(...msgs: string[]): never {
  for (const m of msgs) console.error(m);
  process.exit(1);
}

// Structural validation, then (only if that passed) the point-list data check.
function report(buildingId: string, raw: unknown, root: string): void {
  const v = validateProfile(raw, buildingId, root);
  const data = v.errors.length
    ? { errors: [] as string[], warnings: [] as string[], report: [] as string[] }
    : (raw as BuildingProfile).dataShape === "bacnet"
      ? checkBacnetProfileData(raw as BuildingProfile, root)
      : checkProfileData(raw as BuildingProfile, root);
  const errors = [...v.errors, ...data.errors];
  for (const w of [...v.warnings, ...data.warnings]) console.error(`warning: ${buildingId}: ${w}`);
  if (errors.length) fail(...errors.map((e) => `error: ${buildingId}: ${e}`));
  if (data.report.length) {
    console.log("data check:");
    for (const line of data.report) console.log(`  ${line}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const buildingId = args.find((a) => !a.startsWith("--"));
  const force = args.includes("--force");
  const validateOnly = args.includes("--validate");
  if (!buildingId) fail("usage: write-building-profile.ts <buildingId> [--force | --validate]  (profile JSON on stdin when writing)");

  const root = dataRoot();
  const file = path.join(root, buildingId, "building-config.json");

  if (validateOnly) {
    if (!fs.existsSync(file)) fail(`error: ${buildingId}: no profile at ${file}`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
      fail(`error: ${buildingId}: ${file} is not valid JSON: ${(e as Error).message}`);
    }
    report(buildingId, raw, root);
    console.log(`${buildingId}: profile valid`);
    return;
  }

  let text: string;
  try {
    text = fs.readFileSync(0, "utf-8");
  } catch {
    fail("error: could not read profile JSON from stdin");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(`error: stdin is not valid JSON: ${(e as Error).message}`);
  }

  report(buildingId, raw, root);

  if (fs.existsSync(file) && !force) {
    fail(`error: ${file} already exists; re-run with --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  console.log(`${buildingId}: wrote ${file}`);
}

try {
  main();
} catch (e) {
  fail(`error: ${(e as Error).message}`);
}
