/**
 * split-pointlist-csv.ts
 *
 * Splits a BMS point-list CSV into two files:
 *   - plants CSV: rows where the Plant column does NOT match the profile's naming.zoneId
 *   - zones CSV:  rows where the Plant column matches naming.zoneId
 *
 * Both output files keep the original header row and semicolon delimiter.
 *
 * Usage:
 *   npx ts-node tools/split-pointlist-csv.ts <buildingId>
 *
 * Reads:  the profile's inputs.pointList (data/<buildingId>/building-config.json)
 * Writes: data/<buildingId>/inputs/pointlist-plants.csv
 *         data/<buildingId>/inputs/pointlist-zones.csv
 */

import * as fs from "fs";
import * as path from "path";
import { loadProfile, requireShape, inputPath, compileRegex, BuildingProfile } from "./lib/building-profile";
import { parsePointList, PointListFormat } from "./lib/point-list";

const buildingId = process.argv[2];
if (!buildingId) {
  console.error("Usage: npx ts-node tools/split-pointlist-csv.ts <buildingId>");
  process.exit(1);
}

const inputDir = path.join("data", buildingId, "inputs");

// The source CSV is the profile's declared pointList (no directory scan).
let sourcePath: string;
let profile: BuildingProfile;
try {
  profile = loadProfile(buildingId);
  requireShape(profile, "timeseries", "split-pointlist-csv.ts");
  sourcePath = inputPath(profile, "pointList");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (!fs.existsSync(sourcePath)) {
  console.error(`Missing: ${sourcePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(sourcePath, "utf-8");

// Handle BOM if present
const hasBom = raw.charCodeAt(0) === 0xfeff;

const fmt = profile.pointListFormat as PointListFormat;
const zoneRe = compileRegex(profile.naming!.zoneId!);

// Every record is classified, skip rules included: skipped rows (e.g. system "Points" rows)
// are not zone rows, so they stay in the plants CSV exactly as before. The skip counts are
// printed from a second parse with the real skipRows.
const all = parsePointList(raw, { ...fmt, skipRows: [] });
if (all.malformed) {
  console.error(`${buildingId}: ${sourcePath}: ${all.malformed}`);
  process.exit(1);
}
if (all.missingColumns.length) {
  console.error(
    `${buildingId}: pointListFormat column(s) not found in the header of ${sourcePath}: ${all.missingColumns.join(", ")} (header: ${all.header})`
  );
  process.exit(1);
}
const skipped = parsePointList(raw, fmt).skipped;
const header = all.header;
const dataLines = all.rows;

const plantRows: string[] = [];
const zoneRows: string[] = [];

for (const row of dataLines) {
  if (zoneRe.test(row.plant)) {
    zoneRows.push(row.line);
  } else {
    plantRows.push(row.line);
  }
}

const plantsOut = path.join(inputDir, "pointlist-plants.csv");
const zonesOut = path.join(inputDir, "pointlist-zones.csv");

const bom = hasBom ? "\uFEFF" : "";
fs.writeFileSync(plantsOut, bom + [header, ...plantRows].join("\n"), "utf-8");
fs.writeFileSync(zonesOut, bom + [header, ...zoneRows].join("\n"), "utf-8");

console.log(`Input:  ${sourcePath} (${dataLines.length} data rows)`);
console.log(`Plants: ${plantsOut} (${plantRows.length} rows)`);
console.log(`Zones:  ${zonesOut} (${zoneRows.length} rows)`);
for (const [key, n] of Object.entries(skipped)) {
  console.log(`Skipped by ${key}: ${n} (kept in the plants CSV as system rows; the mappers skip them)`);
}
