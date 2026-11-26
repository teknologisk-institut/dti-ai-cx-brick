// tools/lib/rerun-guard.ts
//
// Shared, building-agnostic safeguard for generator tools that fully overwrite a
// source data file classify-all.ts later enriches in place (plant-point-mapping.json,
// zone-point-mapping.json). These generators rebuild their output from raw inputs on
// every run and never read back their own prior output, so a rerun on an
// already-classified building silently drops brickClass/confidence/brickNote/
// classificationAlternatives with no warning.
//
// Call immediately before writing a fully-regenerated output file. Used by:
//   - tools/map-plant-points.ts
//   - tools/map-zone-points.ts
//   - tools/map-bacnet-points.ts
// (build-spatial-hierarchy.py carries the Python port of this same check.)

import * as fs from "fs";

const CLASSIFIED_MARKER = '"brickClass"';

// Aborts (unless force) when outputPath already contains classify-all.ts's output.
// No-ops when outputPath doesn't exist yet, or exists but was never classified —
// both are safe to overwrite.
export function guardAgainstClassifiedOverwrite(outputPath: string, force: boolean): void {
  if (!fs.existsSync(outputPath)) return;
  const existing = fs.readFileSync(outputPath, "utf-8");
  if (!existing.includes(CLASSIFIED_MARKER)) return;

  if (force) {
    console.warn(
      `WARNING: ${outputPath} already contains brickClass data from classify-all.ts. ` +
        `--force passed, overwriting anyway. Re-run classify-all.ts for this building ` +
        `immediately after this completes, or that classification data is gone. ` +
        `Points and plants with reviewedManually: true keep their reviewed brickClass/confidence/` +
        `reviewNote (carried over by bmsPointId / plantId); everything else is recomputed.`
    );
    return;
  }

  console.error(
    `Refusing to overwrite ${outputPath}: it already contains brickClass/confidence data ` +
      `written by classify-all.ts. Regenerating it now would silently erase that ` +
      `classification with no other record of it.\n` +
      `Re-run classify-all.ts for this building right after this tool once you proceed, ` +
      `and pass --force to confirm.`
  );
  process.exit(1);
}

// brickNote: the human note assign-brick.ts (HITL touchpoint 3) writes.
const REVIEWED_FIELDS = ["brickClass", "confidence", "reviewedManually", "reviewNote", "brickNote"];

function copyReviewed(from: any, to: any): void {
  for (const f of REVIEWED_FIELDS) if (from[f] !== undefined) to[f] = from[f];
}

// Copies the human-reviewed fields (brickClass, confidence, reviewedManually, reviewNote, brickNote) of
// every reviewedManually point of the old file at oldPath (plants, zones and BACnet devices) onto the new point with the same bmsPointId,
// and of every reviewedManually plant onto the new plant with the same plantId. Everything else is left
// to be recomputed. Prints both counts, and a warning per old reviewed point with no new match (its review
// is not carried); returns the number of points carried. No old file -> 0.
// Whole groups: an old plant (in `plants`) or zone (in `extra.zones`, when passed) that is reviewed
// (reviewedManually itself, or any reviewedManually point) and whose id the new mapping no longer has is
// copied over unchanged with all its points, pushed onto that array, printed ("carried over whole: <ids>")
// and listed in extra.summary.carriedOverWhole. Its points whose bmsPointId the new mapping already has
// are left out (one warning each). The caller recomputes its summary totals afterwards.
export function carryOverReviewed(oldPath: string, points: any[], plants: any[] = [], extra: { zones?: any[]; summary?: any } = {}): number {
  if (!fs.existsSync(oldPath)) return 0;
  const old = JSON.parse(fs.readFileSync(oldPath, "utf-8"));
  // devices: the BACnet mapping's device points (objects no rule places on a controller)
  const groups: any[] = [...(old.plants ?? []), ...(old.zones ?? []), ...(old.devices ?? [])];
  const oldPoints = new Map<string, any>();
  for (const g of groups) for (const p of g.points ?? []) if (p.reviewedManually === true) oldPoints.set(p.bmsPointId, p);
  const oldPlants = new Map<string, any>();
  for (const p of old.plants ?? []) if (p.reviewedManually === true) oldPlants.set(p.plantId, p);

  let pointCount = 0;
  for (const p of points) {
    const o = oldPoints.get(p.bmsPointId);
    if (!o) continue;
    copyReviewed(o, p);
    pointCount++;
  }
  let plantCount = 0;
  for (const p of plants) {
    const o = oldPlants.get(p.plantId);
    if (!o) continue;
    copyReviewed(o, p);
    plantCount++;
  }

  const reviewed = (g: any) => g.reviewedManually === true || (g.points ?? []).some((p: any) => p.reviewedManually === true);
  const whole: any[] = [];
  // A carried group's point whose bmsPointId the new mapping already has (the point moved) is left out. The new
  // mapping's ids are `points` (all of this file's new points, e.g. a BACnet file's device points too) and the groups'.
  const carryWhole = (oldGroups: any[] | undefined, newGroups: any[], key: string) => {
    const have = new Set(newGroups.map((g) => g[key]));
    const newIds = new Set([...points.map((p) => p.bmsPointId), ...newGroups.flatMap((g) => (g.points ?? []).map((p: any) => p.bmsPointId))]);
    for (const g of oldGroups ?? []) {
      if (have.has(g[key]) || !reviewed(g)) continue;
      if (Array.isArray(g.points)) {
        for (const p of g.points) if (newIds.has(p.bmsPointId)) { console.warn(`  WARNING: point ${p.bmsPointId} of carried-over ${g[key]} is already in the new mapping; not duplicated`); }
        g.points = g.points.filter((p: any) => !newIds.has(p.bmsPointId));
        if ("pointCount" in g) g.pointCount = g.points.length;
      }
      newGroups.push(g); whole.push(g);
    }
  };
  carryWhole(old.plants, plants, "plantId");
  if (extra.zones) carryWhole(old.zones, extra.zones, "zoneId");
  const wholeIds = whole.map((g) => g.plantId ?? g.zoneId);
  const wholePoints = new Set(whole.flatMap((g) => (g.points ?? []).map((p: any) => p.bmsPointId)));

  console.log(`  Carried over from ${oldPath}: ${pointCount} reviewed point(s), ${plantCount} reviewed plant(s)`);
  if (whole.length > 0) {
    console.log(`  Not in the new mapping, carried over whole: ${wholeIds.join(", ")} (${whole.length} group(s), ${wholePoints.size} point(s))`);
    if (extra.summary) extra.summary.carriedOverWhole = wholeIds;
  }

  const newPoints = new Set(points.map((p) => p.bmsPointId));
  const newPlants = new Set(plants.map((p) => p.plantId));
  const lostPoints = [...oldPoints.keys()].filter((id) => !newPoints.has(id) && !wholePoints.has(id));
  const lostPlants = [...oldPlants.keys()].filter((id) => !newPlants.has(id));
  for (const id of lostPoints) console.warn(`  WARNING: reviewed point ${id} is not in the new mapping; its review is not carried over`);
  for (const id of lostPlants) console.warn(`  WARNING: reviewed plant ${id} is not in the new mapping; its review is not carried over`);
  if (lostPoints.length + lostPlants.length > 0) {
    console.warn(`  WARNING: ${lostPoints.length} reviewed point(s) and ${lostPlants.length} reviewed plant(s) not carried over (no matching id)`);
  }
  return pointCount;
}
