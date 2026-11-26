// tools/lib/dictionary-data.ts
//
// A building's data points, listed from its raw inputs, and which dictionary entries decide each
// point (the classifier's combiner, decidingEntries). Used by validateStrict (point-dictionary.ts) and
// the review. Imports only TYPES from point-dictionary.ts so the two files do not cycle at runtime.

import * as fs from "fs";
import * as path from "path";
import { compileRegex, dataRoot, inputPath, loadProfile } from "./building-profile";
import { parsePointList } from "./point-list";
import { extractPointToken, splitPointSuffix } from "./point-id";
import { readBacnetObjects } from "./bacnet-objects";
import type { PartsDictionary } from "./point-dictionary";
import { collectContributions, pointInputsFromMapping } from "./point-parts";
import type { Contribution, PointInput } from "./point-parts";
import { classTags, combineParts, CONVENTION_ONLY, PART_TAGS } from "./tag-match";
import type { Combined } from "./tag-match";
import { unitQuantity } from "./units";

export interface DataPoint {
  pointId: string;
  description: string;
  context: "zone" | "plant" | "none";
  token: string;
  suffix: string | null;
  /** The point id without its suffix (what override keys use); defaults to pointId. */
  baseId?: string;
  /** Set for a timeseries object that has no point-list row (a meter reading read from objects.json). */
  synthesized?: boolean;
}

/** Timeseries: every point-list row (skip rules applied), pointId = plant + separator + point, each id
 * once (the first row wins), plus every objects.json object that is not already a point id. Bacnet:
 * every object row, pointId = object name. */
export function loadDataPoints(buildingId: string): DataPoint[] {
  const profile = loadProfile(buildingId);
  if (profile.dataShape === "bacnet") {
    const dir = inputPath(profile, "bacnetObjects");
    return readBacnetObjects(dir).map((o) => ({
      pointId: o.objectName,
      description: o.description,
      context: "none" as const,
      token: "",
      suffix: o.objectName,
    }));
  }

  const naming = profile.naming!;
  const sep = naming.separator!;
  const zoneRe = compileRegex(naming.zoneId!);
  const tokenRe = compileRegex(naming.pointToken!);
  const unsplittable = new Set((naming.unsplittablePointNames ?? []).map((n) => n.toUpperCase()));
  const parsed = parsePointList(fs.readFileSync(inputPath(profile, "pointList"), "utf-8"), profile.pointListFormat!);

  const out: DataPoint[] = [];
  const seen = new Set<string>();
  const plants = new Set<string>();
  for (const r of parsed.rows) if (r.plant && !zoneRe.test(r.plant)) plants.add(r.plant);
  for (const r of parsed.rows) {
    const pointId = r.plant + sep + r.point;
    if (seen.has(pointId)) continue;
    seen.add(pointId);
    const zone = zoneRe.exec(r.plant);
    const context = zone ? "zone" : "plant";
    let base: string;
    let suffix: string | null;
    // A composite plant (VA07_QM1) or a zone sub-entity (Z_101_SPI1) names the base point after the
    // plant/zone id; the Point column is then the suffix. Mirrors map-plant-points / map-zone-points.
    if (zone && r.plant !== zone[1]) {
      base = r.plant.substring(zone[1].length + sep.length);
      suffix = r.point;
    } else {
      const owner = zone ? undefined : resolveOwner(r.plant, plants, sep);
      if (owner) {
        base = r.plant.substring(owner.length + sep.length);
        suffix = r.point;
      } else {
        ({ base, suffix } = splitPointSuffix(r.point, sep, unsplittable));
      }
    }
    const baseId = suffix !== null ? pointId.slice(0, pointId.length - suffix.length - sep.length) : pointId;
    out.push({ pointId, baseId, description: r.description, context, token: extractPointToken(base, tokenRe), suffix });
  }

  if (profile.inputs.tsdbObjects) {
    const objectsPath = inputPath(profile, "tsdbObjects");
    if (!fs.existsSync(objectsPath)) throw new Error(`${buildingId}: declared tsdbObjects file not found: ${objectsPath}`);
    {
      const objects = JSON.parse(fs.readFileSync(objectsPath, "utf-8")).objects ?? [];
      const byLongest = Array.from(plants).sort((a, b) => b.length - a.length);
      for (const o of objects) {
        const name: string = o.object_name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // Meter synthesis (map-plant-points.ts): name = <plant>_<meter>_<reading>.
        let token = "";
        let suffix: string | null = null;
        const plant = byLongest.find((p) => name.startsWith(p + sep));
        if (plant) {
          const rest = name.slice(plant.length + sep.length);
          const last = rest.lastIndexOf(sep);
          if (last !== -1) {
            token = extractPointToken(rest.slice(0, last), tokenRe);
            suffix = rest.slice(last + sep.length);
          }
        }
        out.push({ pointId: name, description: "", context: zoneRe.test(name) ? "zone" : "plant", token, suffix, synthesized: true });
      }
    }
  }
  return out;
}

/** The known plant id that a composite Plant value (VA07_QM1) starts with, if any. */
function resolveOwner(plant: string, plants: Set<string>, sep: string): string | undefined {
  let best: string | undefined;
  for (const p of plants) {
    if (p !== plant && plant.startsWith(p + sep) && (best === undefined || p.length > best.length)) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The one shape (schemaVersion 3): the classifier's own combining function
// ---------------------------------------------------------------------------

/** A draft or dictionary in the one shape with every section present (a draft may leave some out). */
export function asPartsDictionary(d: any): PartsDictionary {
  return {
    schemaVersion: 3,
    tokens: d?.tokens ?? {},
    suffixes: Array.isArray(d?.suffixes) ? d.suffixes : [],
    words: Array.isArray(d?.words) ? d.words : [],
    units: d?.units ?? {},
    overrides: d?.overrides ?? {},
    plantTokens: d?.plantTokens ?? {},
    plantOverrides: d?.plantOverrides ?? {},
  };
}

/** A point's contributions and their combination, as the classifier makes them. The host frame
 * (Leaving/Entering/District) lives in classify-all's routing and is left empty here. */
export function combinePoint(dict: PartsDictionary, p: PointInput): { cs: Contribution[]; combined: Combined } {
  const cs = collectContributions(dict, p);
  const combined = combineParts(cs, { hostFrame: [], isZone: p.context === "zone", unitTags: unitQuantity(p.units, dict.units).tags, objectType: p.objectType });
  return { cs, combined };
}

/** One-shape entries that decide points (what collectContributions names); plant tokens, plant
 * overrides, meter readings, notEquipment and equipmentIdRules decide no point. */
export const V3_POINT_ENTRY = /^(tokens\.[^.]+\.[^.]+|suffixes\[\d+\]|words\[\d+\]|units\..+|overrides\..+)$/;

/** The entries that decide a point: its role source, the entry deciding each part, and every entry
 * contributing a tag outside the decided parts (a union tag such as Min or Limit) that the combined
 * point keeps (not the convention-only tags combineParts drops and adds itself). Entry names as
 * collectContributions gives them (tokens.zone.TR, suffixes[0], words[2], units.°C, overrides.<id>). */
export function decidingEntries(cs: Contribution[], combined: Combined): Set<string> {
  const out = new Set<string>();
  if (combined.roleSource) out.add(combined.roleSource.entry);
  for (const d of Object.values(combined.decidedBy)) if (d) out.add(d.entry);
  const inPart = new Set(Object.values(PART_TAGS).flat());
  const kept = new Set(combined.tags);
  for (const c of cs) if (c.tags.some((t) => !inPart.has(t) && !CONVENTION_ONLY.has(t) && kept.has(t))) out.add(c.entry);
  return out;
}

/** The raw object name (`tsdb.id`) -> bmsPointId of every mapped point whose two differ, from the
 * mapping files in `dir` (default data/<b>/inputs). The BACnet mapper names points by plant/zone and
 * suffix (the raw name can carry a device prefix the mapped id drops), while the building's data
 * points keep the object name. */
export function mappedRawIds(buildingId: string, dir?: string): Map<string, string> {
  const d = dir ?? path.join(dataRoot(), buildingId, "inputs");
  const out = new Map<string, string>();
  for (const [file, key] of [["plant-point-mapping.json", "plants"], ["plant-point-mapping.json", "devices"], ["zone-point-mapping.json", "zones"]]) {
    const f = path.join(d, file);
    if (!fs.existsSync(f)) continue;
    for (const g of JSON.parse(fs.readFileSync(f, "utf-8"))[key] ?? []) {
      for (const pt of g.points ?? []) {
        const raw = pt?.tsdb?.id;
        if (typeof raw === "string" && typeof pt.bmsPointId === "string" && raw !== pt.bmsPointId) out.set(raw, pt.bmsPointId);
      }
    }
  }
  return out;
}

/** PointInputs for the building's points from the plant and zone mapping files in `dir` (default
 * data/<b>/inputs), or null when neither file is there. `withEquipment`: the image ductPath comes from
 * <dir>/equipment-inventory.json (an error when it is missing); otherwise no point has one. */
export function loadPointInputs(buildingId: string, dir?: string, withEquipment = false): PointInput[] | null {
  const d = dir ?? path.join(dataRoot(), buildingId, "inputs");
  const read = (f: string): any => (fs.existsSync(path.join(d, f)) ? JSON.parse(fs.readFileSync(path.join(d, f), "utf-8")) : undefined);
  const plants = read("plant-point-mapping.json");
  const zones = read("zone-point-mapping.json");
  if (plants === undefined && zones === undefined) return null;
  let inventory: any = {};
  if (withEquipment) {
    inventory = read("equipment-inventory.json");
    if (inventory === undefined) throw new Error(`${path.join(d, "equipment-inventory.json")}: equipment inventory not found`);
  }
  const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "ontologies", "brick-classification-index.json"), "utf-8"));
  const medium = new Set([...PART_TAGS.medium, ...PART_TAGS.waterKind]);
  return pointInputsFromMapping(loadProfile(buildingId), plants ?? {}, zones ?? {}, inventory, (cls) => [...classTags(idx, cls)].filter((t) => medium.has(t)));
}
