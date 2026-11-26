/**
 * map-zone-points.ts
 *
 * Joins pointlist-zones.csv with objects.json to produce a structured
 * zone→point→subpoint mapping with TSDB linkage and semantic labels.
 *
 * Usage:
 *   npx ts-node tools/map-zone-points.ts <buildingId>
 *
 * Reads:
 *   data/<buildingId>/inputs/pointlist-zones.csv
 *   data/<buildingId>/inputs/objects.json
 *
 * Writes:
 *   data/<buildingId>/inputs/zone-point-mapping.json
 */

import * as fs from "fs";
import * as path from "path";
import { guardAgainstClassifiedOverwrite, carryOverReviewed } from "./lib/rerun-guard";
import { loadProfile, requireShape, inputPath, compileRegex, BuildingProfile } from "./lib/building-profile";
import { parsePointList } from "./lib/point-list";
import { splitPointSuffix as splitPointSuffixShared, pointGrammar, IdParts } from "./lib/point-id";
import { loadPartsDictionary, PartsDictionary } from "./lib/point-dictionary";
import { idPartsFor, pointLabel } from "./lib/point-parts";

// ---------------------------------------------------------------------------
// Point dictionary (one shape, schemaVersion 3) -- labels only; classify-all decides the class.
// ---------------------------------------------------------------------------
// Loaded from data/{buildingId}/point-dictionary.json once buildingId is known
// (see Main section below) -- see tools/lib/point-dictionary.ts.

let DICT: PartsDictionary;

// Naming rules from the profile's naming section (set once the profile is loaded, see Main).
let ZONE_RE: RegExp;
let SEP = "";
let UNSPLITTABLE = new Set<string>();
let GRAMMAR: ReturnType<typeof pointGrammar>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the zone ID (naming.zoneId, group 1) from a Plant column value. */
function extractZoneId(plant: string): string {
  const m = ZONE_RE.exec(plant);
  if (m && !plant.startsWith(m[1])) {
    console.error(
      `${buildingId}: naming.zoneId capture group 1 must be the start of the Plant value (pattern ${profile.naming!.zoneId!.pattern}, Plant "${plant}", group 1 "${m[1]}")`
    );
    process.exit(1);
  }
  return m ? m[1] : plant;
}

/**
 * Split a Point column value into base point and suffix.
 * "TR1"      → { base: "TR1", suffix: null }
 * "TR1_SP"   → { base: "TR1", suffix: "SP" }
 * "SPI1_POS" → { base: "SPI1", suffix: "POS" }
 */
function splitPointSuffix(pointCol: string): { base: string; suffix: string | null } {
  return splitPointSuffixShared(pointCol, SEP, UNSPLITTABLE);
}

/** A point's id parts and English label (see lib/point-parts.ts pointLabel). */
function labelPoint(zoneId: string, bmsPointId: string, description: string): { idParts: IdParts; label: ReturnType<typeof pointLabel> } {
  const idParts = idPartsFor(GRAMMAR, zoneId, bmsPointId);
  const label = pointLabel(DICT, { id: bmsPointId, context: "zone", parts: idParts, separator: SEP, description });
  return { idParts, label };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TsdbEntry {
  id: string;
  objectType: string;
  objectInstance: number;
  units: string;
}

interface PointEntry {
  pointAbbreviation: string;
  bmsPointId: string;
  idParts: IdParts;
  semanticMeaning: string;
  danishDescription: string;
  alarmClass: string;
  tsdb: TsdbEntry | null;
}

interface ZoneEntry {
  zoneId: string;
  pointCount: number;
  points: PointEntry[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const buildingId = process.argv[2];
if (!buildingId) {
  console.error("Usage: npx ts-node tools/map-zone-points.ts <buildingId> [--force]");
  process.exit(1);
}
const force = process.argv.includes("--force");

let objectsPath: string;
let profile: BuildingProfile;
try {
  profile = loadProfile(buildingId);
  requireShape(profile, "timeseries", "map-zone-points.ts");
  objectsPath = inputPath(profile, "tsdbObjects");
  DICT = loadPartsDictionary(buildingId);
  GRAMMAR = pointGrammar(profile);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const naming = profile.naming!;
ZONE_RE = compileRegex(naming.zoneId!);
SEP = naming.separator!;
UNSPLITTABLE = new Set((naming.unsplittablePointNames ?? []).map((n) => n.toUpperCase()));

const inputDir = path.join("data", buildingId, "inputs");
const csvPath = path.join(inputDir, "pointlist-zones.csv");
const outputPath = path.join(inputDir, "zone-point-mapping.json");

if (!fs.existsSync(csvPath)) {
  console.error(`Missing: ${csvPath}`);
  console.error("Run split-pointlist-csv.ts first if needed.");
  process.exit(1);
}
if (!fs.existsSync(objectsPath)) {
  console.error(`Missing: ${objectsPath}`);
  process.exit(1);
}

// --- Load objects.json into a lookup by object_name ---
const objectsRaw = JSON.parse(fs.readFileSync(objectsPath, "utf-8"));
const tsdbLookup = new Map<string, TsdbEntry>();
const allTsdbZoneNames = new Set<string>();

for (const obj of objectsRaw.objects) {
  const name: string = obj.object_name;
  tsdbLookup.set(name, {
    id: obj.object_name,
    objectType: obj.object_type,
    objectInstance: obj.object_instance,
    units: obj.units,
  });
  if (ZONE_RE.test(name)) {
    allTsdbZoneNames.add(name);
  }
}

// --- Parse CSV ---
const rawCsv = fs.readFileSync(csvPath, "utf-8");
const parsed = parsePointList(rawCsv, profile.pointListFormat!);
if (parsed.malformed) {
  console.error(`${buildingId}: ${csvPath}: ${parsed.malformed}`);
  process.exit(1);
}
if (parsed.missingColumns.length) {
  console.error(
    `${buildingId}: pointListFormat column(s) not found in the header of ${csvPath}: ${parsed.missingColumns.join(", ")} (header: ${parsed.header})`
  );
  process.exit(1);
}
const csvData = parsed.rows;
for (const [key, n] of Object.entries(parsed.skipped)) {
  console.log(`  Skipped by ${key}: ${n}`);
}

// Track which TSDB names we matched
const matchedTsdbNames = new Set<string>();

// Intermediate: group rows by zone, then by base point
interface CsvRow {
  plant: string;
  pointCol: string;
  description: string;
  alarmClass: string;
  fullBmsId: string;
}

const zoneMap = new Map<string, Map<string, { baseRow: CsvRow | null; subRows: CsvRow[] }>>();

for (const rec of csvData) {
  const plant = rec.plant;
  const pointCol = rec.point;
  const description = rec.description;
  const alarmClass = rec.alarmClass;

  const zoneId = extractZoneId(plant);
  const fullBmsId = plant + SEP + pointCol;

  // Determine the base point and whether this is a subpoint
  let basePointName: string;
  let isSubpoint = false;
  let suffixPart: string | null = null;

  if (plant !== zoneId) {
    // Type 2 row: Plant = {zoneId}_DM1, Point = POS
    // The "point" is the part of Plant after the zone ID
    const afterZone = plant.substring(zoneId.length + SEP.length); // e.g. "SPI1"
    basePointName = afterZone;
    isSubpoint = true;
    suffixPart = pointCol; // e.g. "POS"
  } else {
    // Type 1 row: Plant = {zoneId}, Point = TR1 or TR1_SP
    const { base, suffix } = splitPointSuffix(pointCol);
    basePointName = base;
    isSubpoint = suffix !== null;
    suffixPart = suffix;
  }

  const row: CsvRow = { plant, pointCol, description, alarmClass, fullBmsId };

  if (!zoneMap.has(zoneId)) zoneMap.set(zoneId, new Map());
  const pointMap = zoneMap.get(zoneId)!;
  if (!pointMap.has(basePointName)) pointMap.set(basePointName, { baseRow: null, subRows: [] });
  const entry = pointMap.get(basePointName)!;

  if (isSubpoint) {
    entry.subRows.push(row);
  } else {
    if (entry.baseRow !== null) {
      // Duplicate base row (same point, different alarm priority) — merge, don't push as subpoint
      const existPri = parseInt(entry.baseRow.alarmClass.replace(/\D/g, '') || '99', 10);
      const newPri = parseInt(alarmClass.replace(/\D/g, '') || '99', 10);
      if (newPri < existPri) entry.baseRow = row;
    } else {
      entry.baseRow = row;
    }
  }
}

// --- Build output ---
const unmatchedCsvPoints: string[] = [];
const zones: ZoneEntry[] = [];

// --- Unresolved breakdown (HITL touchpoint 2, Stage 2 input): points no dictionary entry labels
// (their label is the description), by id token; points whose id suffix no suffix entry matches, by
// suffix ---
const unresolvedByToken: Record<string, number> = {};
const unresolvedSuffixes: Record<string, number> = {};
const countUnresolved = (l: { idParts: IdParts; label: ReturnType<typeof pointLabel> }): void => {
  if (l.label.from === "description") unresolvedByToken[l.idParts.token] = (unresolvedByToken[l.idParts.token] || 0) + 1;
  const s = l.label.unmatchedSuffix;
  if (s) unresolvedSuffixes[s] = (unresolvedSuffixes[s] || 0) + 1;
};

const sortedZoneIds = Array.from(zoneMap.keys()).sort();

for (const zoneId of sortedZoneIds) {
  const pointMap = zoneMap.get(zoneId)!;
  const points: PointEntry[] = [];

  const sortedPointNames = Array.from(pointMap.keys()).sort();

  for (const baseName of sortedPointNames) {
    const { baseRow, subRows } = pointMap.get(baseName)!;

    // Build the base BMS point ID (zone + base point)
    const baseBmsId = zoneId + SEP + baseName;

    // Look up base point in TSDB
    const baseTsdb = tsdbLookup.get(baseBmsId) || null;
    if (baseTsdb) matchedTsdbNames.add(baseBmsId);
    else if (baseRow) unmatchedCsvPoints.push(baseBmsId);

    // Base point — flat, self-contained. A base point without its own row (only sub-rows) takes the
    // gloss of the entry that labels it.
    const baseLabelled = labelPoint(zoneId, baseBmsId, baseRow ? baseRow.description : "");
    const baseDescription = (baseRow ? baseRow.description : "") || baseLabelled.label.entry?.danishGloss || "";
    points.push({
      pointAbbreviation: baseName,
      bmsPointId: baseBmsId,
      idParts: baseLabelled.idParts,
      semanticMeaning: baseLabelled.label.meaning,
      danishDescription: baseDescription,
      alarmClass: baseRow ? baseRow.alarmClass : "",
      tsdb: baseTsdb,
    });
    countUnresolved(baseLabelled);

    // Subpoints flattened to top-level points: each its own id parts and label (the suffix entry's
    // meaning with the base token's meaning as {base}).
    for (const sub of subRows) {
      const subTsdb = tsdbLookup.get(sub.fullBmsId) || null;
      if (subTsdb) matchedTsdbNames.add(sub.fullBmsId);
      else unmatchedCsvPoints.push(sub.fullBmsId);

      let suffix: string;
      if (sub.plant !== zoneId) {
        suffix = sub.pointCol;
      } else {
        const parts = splitPointSuffix(sub.pointCol);
        suffix = parts.suffix || sub.pointCol;
      }

      const subLabelled = labelPoint(zoneId, sub.fullBmsId, sub.description);
      points.push({
        pointAbbreviation: suffix,
        bmsPointId: sub.fullBmsId,
        idParts: subLabelled.idParts,
        semanticMeaning: subLabelled.label.meaning, // self-contained: base context + suffix
        danishDescription: sub.description,
        alarmClass: sub.alarmClass,
        tsdb: subTsdb,
      });
      countUnresolved(subLabelled);
    }
  }

  zones.push({
    zoneId,
    pointCount: points.length,
    points,
  });
}

// --- Unmatched TSDB objects (zone objects in objects.json not found in CSV) ---
const unmatchedTsdbObjects: string[] = [];
for (const name of allTsdbZoneNames) {
  if (!matchedTsdbNames.has(name)) {
    unmatchedTsdbObjects.push(name);
  }
}
unmatchedTsdbObjects.sort();

// --- Summary ---
const totalPoints = zones.reduce((s, z) => s + z.pointCount, 0);
const totalMatched = matchedTsdbNames.size;

const output = {
  buildingId,
  generatedAt: new Date().toISOString(),
  summary: {
    totalZones: zones.length,
    totalPoints,
    matchedToTsdb: totalMatched,
    unmatchedCsvPoints: unmatchedCsvPoints.length,
    unmatchedTsdbObjects: unmatchedTsdbObjects.length,
    unresolvedTokens: unresolvedByToken,
    unresolvedSuffixes,
  },
  zones,
  unmatched: {
    csvPointsNotInTsdb: unmatchedCsvPoints,
    tsdbObjectsNotInCsv: unmatchedTsdbObjects,
  },
};

guardAgainstClassifiedOverwrite(outputPath, force);
// --force: reviewed points keep their human-reviewed class; zones with reviewed points the remap no
// longer produces are carried over whole (rerun-guard.ts)
carryOverReviewed(outputPath, zones.flatMap((z) => z.points), [], { zones, summary: output.summary });
output.summary.totalZones = zones.length;
output.summary.totalPoints = zones.reduce((s, z) => s + z.points.length, 0);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`Zone-point mapping generated: ${outputPath}`);
console.log(`  Zones:              ${zones.length}`);
console.log(`  Total points:       ${output.summary.totalPoints}`);
console.log(`  Matched to TSDB:    ${totalMatched}`);
console.log(`  CSV → no TSDB:      ${unmatchedCsvPoints.length}`);
console.log(`  TSDB → no CSV:      ${unmatchedTsdbObjects.length}`);

const unresolvedTokenCount = Object.keys(unresolvedByToken).length;
if (unresolvedTokenCount > 0) {
  console.log(`  Unresolved tokens:  ${unresolvedTokenCount} unique (${Object.values(unresolvedByToken).reduce((a, b) => a + b, 0)} points) -- see summary.unresolvedTokens`);
}
const unresolvedSuffixCount = Object.keys(unresolvedSuffixes).length;
if (unresolvedSuffixCount > 0) {
  console.log(`  Unresolved suffixes: ${unresolvedSuffixCount} unique (${Object.values(unresolvedSuffixes).reduce((a, b) => a + b, 0)} points) -- see summary.unresolvedSuffixes`);
}
