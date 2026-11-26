/**
 * map-plant-points.ts
 *
 * Joins pointlist-plants.csv with objects.json to produce a structured
 * plant→point→subpoint mapping with TSDB linkage and semantic labels.
 *
 * Same output structure as map-zone-points.ts but uses longest-prefix
 * matching to resolve plant IDs that contain underscores (e.g. a plant id
 * written as VE_01).
 *
 * Usage:
 *   npx ts-node tools/map-plant-points.ts <buildingId>
 *
 * Reads:
 *   data/<buildingId>/inputs/pointlist-plants.csv
 *   data/<buildingId>/inputs/objects.json
 *
 * Writes:
 *   data/<buildingId>/inputs/plant-point-mapping.json
 */

import * as fs from "fs";
import * as path from "path";
import { guardAgainstClassifiedOverwrite, carryOverReviewed } from "./lib/rerun-guard";
import { loadProfile, requireShape, inputPath, compileRegex, BuildingProfile } from "./lib/building-profile";
import { parsePointList } from "./lib/point-list";
import { extractPointToken, splitPointSuffix as splitPointSuffixShared, pointGrammar, IdParts } from "./lib/point-id";
import { loadPartsDictionary, renderMeterMeaning, PartsDictionary, PartEntry, MeterReadings } from "./lib/point-dictionary";
import { idPartsFor, pointLabel } from "./lib/point-parts";

// ---------------------------------------------------------------------------
// Point dictionary (one shape, schemaVersion 3) -- labels only; classify-all decides the class.
// ---------------------------------------------------------------------------
// Loaded from data/{buildingId}/point-dictionary.json once buildingId is known
// (see Main section below) -- see tools/lib/point-dictionary.ts.

let DICT: PartsDictionary;
let METER_READINGS: MeterReadings | null = null;

// Naming rules from the profile's naming section (set once the profile is loaded, see Main).
let ZONE_RE: RegExp;
let POINT_TOKEN_RE: RegExp;
let SEP = "";
let UNSPLITTABLE = new Set<string>();
let GRAMMAR: ReturnType<typeof pointGrammar>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPointPrefix(name: string): string {
  return extractPointToken(name, POINT_TOKEN_RE);
}

function splitPointSuffix(pointCol: string): { base: string; suffix: string | null } {
  return splitPointSuffixShared(pointCol, SEP, UNSPLITTABLE);
}

/** A point's id parts and English label (see lib/point-parts.ts pointLabel). */
function labelPoint(plantId: string, bmsPointId: string, description: string): { idParts: IdParts; label: ReturnType<typeof pointLabel> } {
  const idParts = idPartsFor(GRAMMAR, plantId, bmsPointId);
  const label = pointLabel(DICT, { id: bmsPointId, context: "plant", parts: idParts, separator: SEP, description });
  return { idParts, label };
}

/** The plant-context token entry for a token (plant table, else any), as the classifier looks it up. */
function plantTokenEntry(token: string): PartEntry | undefined {
  for (const table of [DICT.tokens.plant, DICT.tokens.any]) {
    if (table && Object.prototype.hasOwnProperty.call(table, token)) return table[token];
  }
  return undefined;
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
  source?: string; // synthesized meter points only: where the point came from
}

interface PlantEntry {
  plantId: string;
  pointCount: number;
  points: PointEntry[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const buildingId = process.argv[2];
if (!buildingId) {
  console.error("Usage: npx ts-node tools/map-plant-points.ts <buildingId> [--force]");
  process.exit(1);
}
const force = process.argv.includes("--force");

let objectsPath: string;
let profile: BuildingProfile;
try {
  profile = loadProfile(buildingId);
  requireShape(profile, "timeseries", "map-plant-points.ts");
  objectsPath = inputPath(profile, "tsdbObjects");
  DICT = loadPartsDictionary(buildingId);
  GRAMMAR = pointGrammar(profile);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

METER_READINGS = DICT.meterReadings ?? null;

const naming = profile.naming!;
ZONE_RE = compileRegex(naming.zoneId!);
POINT_TOKEN_RE = compileRegex(naming.pointToken!);
SEP = naming.separator!;
UNSPLITTABLE = new Set((naming.unsplittablePointNames ?? []).map((n) => n.toUpperCase()));

const inputDir = path.join("data", buildingId, "inputs");
const csvPath = path.join(inputDir, "pointlist-plants.csv");
const outputPath = path.join(inputDir, "plant-point-mapping.json");

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
const allTsdbPlantNames = new Set<string>();

for (const obj of objectsRaw.objects) {
  const name: string = obj.object_name;
  tsdbLookup.set(name, {
    id: obj.object_name,
    objectType: obj.object_type,
    objectInstance: obj.object_instance,
    units: obj.units,
  });
  if (!ZONE_RE.test(name)) {
    allTsdbPlantNames.add(name);
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
// Rows skipped by pointListFormat.skipRows (system rows) are counted, not mapped.
let systemRowCount = 0;
for (const [key, n] of Object.entries(parsed.skipped)) {
  systemRowCount += n;
  console.log(`  Skipped by ${key}: ${n}`);
}

// --- Build plant ID registry from unique Plant column values ---
// Collect all Plant values (skipped system rows are already excluded by the parser)
const rawPlantIds = new Set<string>();
for (const rec of csvData) {
  if (rec.plant) rawPlantIds.add(rec.plant);
}

// Sort by length descending for longest-prefix matching
const knownPlantIds = Array.from(rawPlantIds).sort((a, b) => b.length - a.length);

/**
 * Resolve a Plant column value to its true plant ID.
 * If the value is a composite like "VA07_QM1" where "VA07" is also a known
 * plant, returns { plantId: "VA07", extra: "QM1" }.
 * Otherwise returns { plantId: plant, extra: null }.
 */
function resolvePlantId(plant: string): { plantId: string; extra: string | null } {
  for (const pid of knownPlantIds) {
    if (pid !== plant && plant.startsWith(pid + SEP)) {
      return { plantId: pid, extra: plant.substring(pid.length + SEP.length) };
    }
  }
  return { plantId: plant, extra: null };
}

// --- Group CSV rows by plant, then by base point ---

interface CsvRow {
  plant: string;
  pointCol: string;
  description: string;
  alarmClass: string;
  fullBmsId: string;
}

const plantMap = new Map<string, Map<string, { baseRow: CsvRow | null; subRows: CsvRow[] }>>();

const matchedTsdbNames = new Set<string>();

for (const rec of csvData) {
  const plant = rec.plant;
  const pointCol = rec.point;
  const description = rec.description;
  const alarmClass = rec.alarmClass;

  const fullBmsId = plant + SEP + pointCol;
  const { plantId, extra } = resolvePlantId(plant);

  let basePointName: string;
  let isSubpoint = false;

  if (extra) {
    // Composite: Plant="VA07_QM1" → plantId="VA07", extra="QM1" is base point,
    // Point column is a subpoint of QM1
    basePointName = extra;
    isSubpoint = true;
  } else {
    // Normal: Plant is the full plant ID, Point column has the point info
    const { base, suffix } = splitPointSuffix(pointCol);
    basePointName = base;
    isSubpoint = suffix !== null;
  }

  const row: CsvRow = { plant, pointCol, description, alarmClass, fullBmsId };

  if (!plantMap.has(plantId)) plantMap.set(plantId, new Map());
  const pointMap = plantMap.get(plantId)!;
  if (!pointMap.has(basePointName)) pointMap.set(basePointName, { baseRow: null, subRows: [] });
  const entry = pointMap.get(basePointName)!;

  if (isSubpoint) {
    entry.subRows.push(row);
  } else {
    if (entry.baseRow !== null) {
      // Duplicate base row (same point, different alarm priority) — merge, don't push as subpoint
      // Keep the row with higher alarm priority (lower Priority number)
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
const plants: PlantEntry[] = [];

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

const sortedPlantIds = Array.from(plantMap.keys()).sort();

for (const plantId of sortedPlantIds) {
  const pointMap = plantMap.get(plantId)!;
  const points: PointEntry[] = [];

  const sortedPointNames = Array.from(pointMap.keys()).sort();

  for (const baseName of sortedPointNames) {
    const { baseRow, subRows } = pointMap.get(baseName)!;
    const baseBmsId = plantId + SEP + baseName;

    const baseTsdb = tsdbLookup.get(baseBmsId) || null;
    if (baseTsdb) matchedTsdbNames.add(baseBmsId);
    else if (baseRow) unmatchedCsvPoints.push(baseBmsId);

    // Base point — flat, self-contained. A base point without its own row (only sub-rows) takes the
    // gloss of the entry that labels it.
    const baseLabelled = labelPoint(plantId, baseBmsId, baseRow ? baseRow.description : "");
    points.push({
      pointAbbreviation: baseName,
      bmsPointId: baseBmsId,
      idParts: baseLabelled.idParts,
      semanticMeaning: baseLabelled.label.meaning,
      danishDescription: (baseRow ? baseRow.description : "") || baseLabelled.label.entry?.danishGloss || "",
      alarmClass: baseRow ? baseRow.alarmClass : "",
      tsdb: baseTsdb,
    });
    countUnresolved(baseLabelled);

    // Subpoints flattened into top-level points: each its own id parts and a self-contained label
    // (the suffix entry's meaning with the base token's meaning as {base}).
    for (const sub of subRows) {
      const subTsdb = tsdbLookup.get(sub.fullBmsId) || null;
      if (subTsdb) matchedTsdbNames.add(sub.fullBmsId);
      else unmatchedCsvPoints.push(sub.fullBmsId);

      let suffix: string;
      if (sub.plant !== plantId) {
        suffix = sub.pointCol;
      } else {
        const parts = splitPointSuffix(sub.pointCol);
        suffix = parts.suffix || sub.pointCol;
      }

      const subLabelled = labelPoint(plantId, sub.fullBmsId, sub.description);
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

  plants.push({
    plantId,
    pointCount: points.length,
    points,
  });
}

// --- Unmatched TSDB objects (plant objects in objects.json not found in CSV) ---
const unmatchedTsdbObjects: string[] = [];
for (const name of allTsdbPlantNames) {
  if (!matchedTsdbNames.has(name)) {
    unmatchedTsdbObjects.push(name);
  }
}
unmatchedTsdbObjects.sort();

// --- Synthesize points for TSDB-only meter sub-readings on already-existing plants
// (2026-08-25) --- A meter's
// individual sub-readings (energy/water meters' supply-temperature/return-temperature/flow/power
// channels) often have no CSV row of their own -- meters aren't always individually alarmed --
// even though the
// meter itself is real, physically captured equipment and the readings are live BACnet
// objects.
// Deliberately narrow, matching this project's evidence-first discipline (no guessing):
//   - only fires when the plant already has other CSV-backed points (never invents a new
//     plant from a single bare meter reading -- e.g. a power reading whose plant doesn't
//     exist in the CSV at all is deliberately left unmatched for a human decision)
//   - only fires when the meter's own prefix (a meterReadings prefix) is already a confirmed
//     dictionary entry -- an unrecognized meter type is left unmatched, not guessed
//   - danishDescription stays "" (honestly absent), never fabricated
// Explicit meter-prefix allowlist, not "any dictionary-known prefix" -- a blanket dictionary
// check is too permissive here: a fire-damper token is also a confirmed dictionary entry, and
// its own diagnostic sub-taps match the same suffix shape (a bare one-letter suffix)
// by coincidence, but were explicitly scoped OUT as low-confidence (unclear what that suffix adds
// beyond the damper's own already-captured status) -- caught by testing before landing this.
//
// Deliberately NOT routed through the suffix rules (which is what the CSV-backed
// sibling suffixes use): their meter-reading rule just
// echoes the base meaning ("Heat Meter") for all four, relying entirely on the CSV row's own
// description for specificity (confirmed: a CSV-backed return-temperature reading's high-confidence
// Leaving_District_Hot_Water_Temperature_Sensor comes from its description text,
// not from category/semanticMeaning at all) -- exactly the signal a
// TSDB-only reading doesn't have. Decoded directly here instead, using the project's own
// already-confirmed TSDB suffix semantics (2026-08-22: the supply- and
// return-temperature transmitter suffixes) so the matcher's
// text-derived quantity/direction signals (waterDirectionTag) have something to
// read -- verified against the actual classifier output before landing, not assumed.
// The meter prefixes and the suffix -> meaning table come from the dictionary's meterReadings
// section; without it nothing is synthesized. The class comes from classify-all (id parts).
const SYNTH_METER_PREFIXES = new Set(METER_READINGS ? METER_READINGS.prefixes : []);
const plantsByLongestId = plants.slice().sort((a, b) => b.plantId.length - a.plantId.length);
const stillUnmatchedTsdb: string[] = [];
for (const name of unmatchedTsdbObjects) {
  const plant = plantsByLongestId.find((p) => name.startsWith(p.plantId + SEP));
  if (!plant) { stillUnmatchedTsdb.push(name); continue; }
  const rest = name.slice(plant.plantId.length + SEP.length);
  const lastUnderscore = rest.lastIndexOf(SEP);
  if (lastUnderscore === -1) { stillUnmatchedTsdb.push(name); continue; }
  const meterId = rest.slice(0, lastUnderscore);
  const suffix = rest.slice(lastUnderscore + SEP.length);
  const meterPrefix = extractPointPrefix(meterId);
  const reading =
    METER_READINGS && Object.prototype.hasOwnProperty.call(METER_READINGS.readings, suffix)
      ? METER_READINGS.readings[suffix]
      : undefined;
  const meterSemantics = reading && SYNTH_METER_PREFIXES.has(meterPrefix) ? plantTokenEntry(meterPrefix) : undefined;
  if (!reading || !meterSemantics) { stillUnmatchedTsdb.push(name); continue; }

  // Base meter point (e.g. "VA07_QM1") -- add once per meter if this plant doesn't
  // already have one from a CSV-backed sibling suffix.
  const baseBmsId = `${plant.plantId}${SEP}${meterId}`;
  if (!plant.points.some((p) => p.bmsPointId === baseBmsId)) {
    plant.points.push({
      pointAbbreviation: meterId,
      bmsPointId: baseBmsId,
      idParts: idPartsFor(GRAMMAR, plant.plantId, baseBmsId),
      semanticMeaning: meterSemantics.meaning,
      danishDescription: meterSemantics.danishGloss || "",
      alarmClass: "",
      tsdb: null,
      source: "synthesized (2026-08-25): meter device with no CSV base row, only TSDB sub-readings",
    });
  }

  plant.points.push({
    pointAbbreviation: suffix,
    bmsPointId: name,
    idParts: idPartsFor(GRAMMAR, plant.plantId, name),
    semanticMeaning: renderMeterMeaning(reading.meaning, meterSemantics.meaning),
    danishDescription: "",
    alarmClass: "",
    tsdb: tsdbLookup.get(name) || null,
    source: "synthesized (2026-08-25) from objects.json (TSDB) -- no CSV pointlist row for this reading",
  });
  plant.pointCount = plant.points.length;
  matchedTsdbNames.add(name);
}
unmatchedTsdbObjects.length = 0;
unmatchedTsdbObjects.push(...stillUnmatchedTsdb);

// --- Summary ---
const totalPoints = plants.reduce((s, p) => s + p.pointCount, 0);
const totalMatched = matchedTsdbNames.size;

const output = {
  buildingId,
  generatedAt: new Date().toISOString(),
  summary: {
    totalPlants: plants.length,
    totalPoints,
    matchedToTsdb: totalMatched,
    unmatchedCsvPoints: unmatchedCsvPoints.length,
    unmatchedTsdbObjects: unmatchedTsdbObjects.length,
    systemRows: systemRowCount,
    unresolvedTokens: unresolvedByToken,
    unresolvedSuffixes,
  },
  plants,
  unmatched: {
    csvPointsNotInTsdb: unmatchedCsvPoints,
    tsdbObjectsNotInCsv: unmatchedTsdbObjects,
  },
};

guardAgainstClassifiedOverwrite(outputPath, force);
// --force: reviewed points and plants keep their human-reviewed class; reviewed plants the remap no
// longer produces are carried over whole (rerun-guard.ts)
carryOverReviewed(outputPath, plants.flatMap((p) => p.points), plants, { summary: output.summary });
output.summary.totalPlants = plants.length;
output.summary.totalPoints = plants.reduce((s, p) => s + p.points.length, 0);
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`Plant-point mapping generated: ${outputPath}`);
console.log(`  Plants:             ${plants.length}`);
console.log(`  Total points:       ${output.summary.totalPoints}`);
console.log(`  System alarm rows:  ${systemRowCount} (excluded)`);
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
