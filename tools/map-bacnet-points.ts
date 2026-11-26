/**
 * map-bacnet-points.ts
 *
 * BACnet mapper: a generic device/object walker. The building's raw data is a per-device BACnet
 * scrape -- a device registry (profile inputs.devices) and one object CSV per device
 * (profile inputs.bacnetObjects, objects_<instance>_*.csv).
 *
 * Grouping comes only from the profile's naming.objectNames (lib/object-grammar.ts walkObjects):
 *   - a `parent` device is one plant (its cleaned object-name), unless a device-scoped rule places
 *     the object elsewhere;
 *   - a `controller` device's objects are placed by the object rules (plant or zone), merged by raw
 *     name across controllers (first instance hosts), skipped by skip rules; objects no rule places
 *     become points of the device itself (`devices`);
 *   - distinct objects that yield the same point id are kept apart (the walk gives each a unique id).
 * Meaning comes only from the building's point-dictionary.json (lib/point-parts.ts pointLabel); id
 * parts from the point part (naming.pointParts). classify-all decides the class from these.
 *
 * Usage:
 *   npx ts-node tools/map-bacnet-points.ts <buildingId> [--force]
 *
 * Writes:
 *   data/<buildingId>/inputs/plant-point-mapping.json   (plants + devices)
 *   data/<buildingId>/inputs/zone-point-mapping.json    (zones)
 */

import * as fs from "fs";
import * as path from "path";
import { guardAgainstClassifiedOverwrite, carryOverReviewed } from "./lib/rerun-guard";
import { loadProfile, requireShape, inputPath } from "./lib/building-profile";
import { loadPartsDictionary, PartsDictionary } from "./lib/point-dictionary";
import { pointGrammar, IdParts } from "./lib/point-id";
import { idPartsFor, pointLabel } from "./lib/point-parts";
import { compileGrammar, walkObjects, assertUniqueIds, pointIdFor, PlacedObject, Grammar, WalkResult } from "./lib/object-grammar";
import { readWalkDevices } from "./lib/object-grammar-check";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

interface BacnetRef {
  id: string; // object-name
  objectType: string;
  objectInstance: number;
  deviceInstance: number;
  units: string;
  stateTexts?: string[]; // state-text items, active-text, inactive-text; omitted when none
}

interface PointEntry {
  pointAbbreviation: string;
  bmsPointId: string;
  idParts: IdParts;
  semanticMeaning: string;
  danishDescription: string;
  rawDescription?: string; // the untouched object description, set where an override's danishGloss replaced it
  alarmClass: string; // always "" (a BACnet scrape carries no alarm class)
  groupingRule?: string; // the toDevice rule that made this a device point instead of joining its plant or zone
  tsdb: BacnetRef;
}

interface GroupEntry {
  groupedBy: string; // the rule or device-rule id that produced the group
  deviceInstance: number;
  deviceName: string;
  pointCount: number;
  points: PointEntry[];
}
type PlantEntry = { plantId: string } & GroupEntry;
type ZoneEntry = { zoneId: string } & GroupEntry;

interface DeviceEntry {
  deviceInstance: number;
  deviceName: string;
  pointCount: number;
  points: PointEntry[];
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

interface PointBuild {
  point: PointEntry;
  unlabelled: boolean; // no dictionary entry labels it (its label is the description)
  unmatchedSuffix?: string;
}

function buildPoint(dict: PartsDictionary, grammar: ReturnType<typeof pointGrammar>, g: Grammar, p: PlacedObject): PointBuild {
  const o = p.object;
  // id parts from the point part (a kept-apart id's disambiguator never becomes a token or suffix)
  const idParts = idPartsFor(grammar, p.parentId, pointIdFor(g.separator, p.parentId, p.pointPart));
  const override = Object.prototype.hasOwnProperty.call(dict.overrides, p.bmsPointId) ? dict.overrides[p.bmsPointId] : undefined;
  // classify-all reads danishDescription as the point's description words: an override's danishGloss
  // replaces the raw description; rawDescription keeps the original whenever it was replaced.
  const description = override?.danishGloss || o.description;
  const label = pointLabel(dict, {
    id: p.bmsPointId,
    context: p.section === "zone" ? "zone" : "plant",
    parts: idParts,
    separator: grammar.separator,
    description,
  });
  const point: PointEntry = {
    pointAbbreviation: p.pointPart,
    bmsPointId: p.bmsPointId,
    idParts,
    semanticMeaning: label.meaning,
    danishDescription: description || label.entry?.danishGloss || "",
    ...(description !== o.description ? { rawDescription: o.description } : {}),
    alarmClass: "",
    ...(p.toDevice ? { groupingRule: p.ruleId } : {}),
    tsdb: {
      id: o.objectName,
      objectType: o.objectType,
      objectInstance: o.objectInstance,
      deviceInstance: p.device.instance,
      units: o.units,
      ...(o.stateTexts.length > 0 ? { stateTexts: o.stateTexts.slice() } : {}),
    },
  };
  return { point, unlabelled: label.from === "description", ...(label.unmatchedSuffix ? { unmatchedSuffix: label.unmatchedSuffix } : {}) };
}

/** Group the placed objects of one section by parent id; the first placed object gives device and rule. */
function groupBy(placed: { p: PlacedObject; point: PointEntry }[]): Map<string, GroupEntry> {
  const groups = new Map<string, GroupEntry>();
  for (const { p, point } of placed) {
    let g = groups.get(p.parentId);
    if (!g) {
      g = { groupedBy: p.ruleId, deviceInstance: p.device.instance, deviceName: p.device.name, pointCount: 0, points: [] };
      groups.set(p.parentId, g);
    }
    g.points.push(point);
  }
  for (const g of groups.values()) {
    g.points.sort((a, b) => a.bmsPointId.localeCompare(b.bmsPointId));
    g.pointCount = g.points.length;
  }
  return groups;
}

const countBy = <T>(items: T[], key: (x: T) => string, n: (x: T) => number = () => 1): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of items) out[key(x)] = (out[key(x)] ?? 0) + n(x);
  return out;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const buildingId = process.argv[2];
if (!buildingId) {
  console.error("Usage: npx ts-node tools/map-bacnet-points.ts <buildingId> [--force]");
  process.exit(1);
}
const force = process.argv.includes("--force");

let dict: PartsDictionary;
let grammar: ReturnType<typeof pointGrammar>;
let g: Grammar;
let devicesPath: string;
let objectsDir: string;
try {
  const profile = loadProfile(buildingId);
  requireShape(profile, "bacnet", "map-bacnet-points.ts");
  devicesPath = inputPath(profile, "devices");
  objectsDir = inputPath(profile, "bacnetObjects");
  dict = loadPartsDictionary(buildingId);
  grammar = pointGrammar(profile);
  g = compileGrammar(profile);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

if (!fs.existsSync(devicesPath)) {
  console.error(`Missing: ${devicesPath}`);
  process.exit(1);
}
if (!fs.existsSync(objectsDir)) {
  console.error(`Missing objects directory: ${objectsDir}`);
  process.exit(1);
}

const inputDir = path.join("data", buildingId, "inputs");
const outputPath = path.join(inputDir, "plant-point-mapping.json");
const zoneOutputPath = path.join(inputDir, "zone-point-mapping.json");

const read = readWalkDevices(devicesPath, objectsDir);
if (read.errors.length > 0) {
  for (const e of read.errors) console.error(e);
  console.error(`${read.errors.length} object-file error(s) (every object file needs its devices.csv row); nothing written`);
  process.exit(1);
}

const walk: WalkResult = walkObjects(g, read.devices);
if (walk.deviceErrors.length > 0) {
  for (const e of walk.deviceErrors) console.error(e);
  console.error(`${walk.deviceErrors.length} device error(s) (no naming.objectNames.devices rule, or parent devices giving one plant id); nothing written`);
  process.exit(1);
}

for (const w of walk.warnings) console.warn(`  ! ${w}`);
const built = walk.placed.map((p) => ({ p, ...buildPoint(dict, grammar, g, p) }));

const plantGroups = groupBy(built.filter((b) => b.p.section === "plant"));
const zoneGroups = groupBy(built.filter((b) => b.p.section === "zone"));
const plants: PlantEntry[] = [...plantGroups].map(([plantId, grp]) => ({ plantId, ...grp })).sort((a, b) => a.plantId.localeCompare(b.plantId));
const zones: ZoneEntry[] = [...zoneGroups].map(([zoneId, grp]) => ({ zoneId, ...grp })).sort((a, b) => a.zoneId.localeCompare(b.zoneId));

const deviceMap = new Map<number, DeviceEntry>();
for (const { p, point } of built.filter((b) => b.p.section === "device")) {
  let d = deviceMap.get(p.device.instance);
  if (!d) {
    d = { deviceInstance: p.device.instance, deviceName: p.device.name, pointCount: 0, points: [] };
    deviceMap.set(p.device.instance, d);
  }
  d.points.push(point);
}
const devices = [...deviceMap.values()].sort((a, b) => a.deviceInstance - b.deviceInstance);
for (const d of devices) {
  d.points.sort((a, b) => a.bmsPointId.localeCompare(b.bmsPointId));
  d.pointCount = d.points.length;
}

// Unresolved (HITL touchpoint 2, Stage 2 input): points no dictionary entry labels, by id token; and
// points whose id suffix no suffix entry matches, by suffix -- across plants, zones and devices.
const unresolvedTokens = countBy(built.filter((b) => b.unlabelled), (b) => b.point.idParts.token);
const unresolvedSuffixes = countBy(built.filter((b) => b.unmatchedSuffix !== undefined), (b) => b.unmatchedSuffix!);

const plantPoints = plants.flatMap((p) => p.points);
const zonePoints = zones.flatMap((z) => z.points);
const devicePoints = devices.flatMap((d) => d.points);

const summary: Record<string, unknown> & { totalPlants: number; totalPoints: number; zones: number; zonePoints: number } = {
  totalPlants: plants.length,
  totalPoints: plantPoints.length,
  zones: zones.length,
  zonePoints: zonePoints.length,
  devicePoints: devicePoints.length,
  byRule: countBy(walk.placed, (p) => p.ruleId),
  skipped: countBy(walk.skipped, (s) => s.ruleId),
  merged: countBy(walk.merged, (m) => m.ruleId, (m) => m.instances.length - 1),
  toDevice: countBy(walk.placed.filter((p) => p.toDevice), (p) => p.ruleId),
  duplicates: walk.duplicates.length,
  duplicatesKeptApart: walk.keptApart.flatMap((k) => k.objects.slice(1).map((o) => o.bmsPointId)),
  unresolvedTokens,
  unresolvedSuffixes,
};

const output = {
  buildingId,
  generatedAt: new Date().toISOString(),
  source: "bacnet-scrape",
  summary,
  plants,
  devices,
};

const zoneSummary = {
  totalZones: zones.length,
  totalPoints: zonePoints.length,
  unlabelled: built.filter((b) => b.p.section === "zone" && b.unlabelled).length,
};
const zoneOutput = {
  buildingId,
  generatedAt: new Date().toISOString(),
  source: "bacnet-scrape",
  summary: zoneSummary,
  zones,
};

guardAgainstClassifiedOverwrite(outputPath, force);
guardAgainstClassifiedOverwrite(zoneOutputPath, force);
// --force: reviewed points and plants keep their human-reviewed class; reviewed plants and zones the
// remap no longer produces are carried over whole (rerun-guard.ts)
carryOverReviewed(outputPath, [...plantPoints, ...devicePoints], plants, { summary });
carryOverReviewed(zoneOutputPath, zonePoints, [], { zones, summary: zoneSummary });
// every id once across plants (incl. carried-over ones), zones and devices -- checked after the carry-over, before writing
try {
  assertUniqueIds([...plants.flatMap((p) => p.points), ...zones.flatMap((z) => z.points), ...devicePoints].map((pt) => pt.bmsPointId));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
summary.totalPlants = plants.length;
summary.totalPoints = plants.reduce((s, p) => s + p.points.length, 0);
summary.zones = zoneSummary.totalZones = zones.length;
summary.zonePoints = zoneSummary.totalPoints = zones.reduce((s, z) => s + z.points.length, 0);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
fs.writeFileSync(zoneOutputPath, JSON.stringify(zoneOutput, null, 2), "utf-8");

const fmt = (r: Record<string, number>) => (Object.keys(r).length === 0 ? "none" : Object.entries(r).map(([k, n]) => `${k}=${n}`).join(", "));
const reasons = new Map(walk.skipped.map((s) => [s.ruleId, s.reason]));
console.log(`Plant mapping: ${outputPath}`);
console.log(`Zone mapping:  ${zoneOutputPath}`);
console.log(`  Devices walked:       ${walk.devices.length}  ${fmt(countBy(walk.devices, (d) => d.ruleId ?? ""))}`);
console.log(`  Plants:               ${summary.totalPlants} (${summary.totalPoints} points)`);
console.log(`  Zones:                ${summary.zones} (${summary.zonePoints} points)`);
console.log(`  Device points:        ${devicePoints.length} on ${devices.length} device(s)`);
console.log(`  By rule:              ${fmt(summary.byRule as Record<string, number>)}`);
console.log(`  Skipped:              ${Object.entries(summary.skipped as Record<string, number>).map(([k, n]) => `${k}=${n} (${reasons.get(k)})`).join(", ") || "none"}`);
console.log(`  Merged copies:        ${fmt(summary.merged as Record<string, number>)}`);
console.log(`  To device (rules):    ${fmt(summary.toDevice as Record<string, number>)}`);
console.log(`  Duplicates not merged: ${walk.duplicates.length}${walk.duplicates.filter((d) => d.differ).length > 0 ? ` (${walk.duplicates.filter((d) => d.differ).length} with differing values)` : ""}`);
console.log(`  Duplicates kept apart: ${walk.keptApart.length}`);
for (const k of walk.keptApart) console.log(`    ${k.sharedId}: ${k.objects.map((o) => `${o.objectName}@${o.instance} -> ${o.bmsPointId}`).join(" | ")}`);
console.log(`  Unresolved tokens:    ${fmt(unresolvedTokens)}`);
console.log(`  Unresolved suffixes:  ${fmt(unresolvedSuffixes)}`);
