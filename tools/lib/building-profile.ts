// tools/lib/building-profile.ts
//
// Shared loader/validator for data/{buildingId}/building-config.json -- the
// "building profile" every tool reads (schemaVersion 2). Declares the building's
// data shape and where its inputs live (paths relative to data/{buildingId}/).
//
// Declared-but-missing input paths are WARNINGS, never errors (the file may not
// have been delivered yet). Structural problems are errors.

import * as fs from "fs";
import * as path from "path";
import { parsePointList, PointListFormat } from "./point-list";
import type { Evidence } from "./point-dictionary";

export type DataShape = "timeseries" | "bacnet";

export interface ProfileInputs {
  pointList?: string;
  tsdbObjects?: string;
  devices?: string;
  bacnetObjects?: string;
  architectureIfc?: string;
  installationIfcs?: string[];
  images?: {
    plants?: string;
    rooms?: string;
    floorplans?: string;
    plantsOverview?: string;
    roomsOverview?: string;
  };
  docs?: {
    abbreviations?: string | string[];
    functionDescriptions?: string | string[];
    zoneMatrix?: string | string[];
  };
}

export interface RegexSpec {
  pattern: string;
  flags?: string;
}

/** A device-CSV column match that makes a device a parent plant or a controller (bacnet). */
export interface DeviceRule {
  id: string;
  column: string;
  pattern: string;
  flags?: string;
  role: "parent" | "controller";
  evidence: Evidence[];
}

/** One BACnet object-name grouping rule (first match wins). Named groups: parent, point. */
export interface ObjectRule {
  id: string;
  pattern: string;
  flags?: string;
  kind?: "plant" | "zone";
  device?: string;
  parent?: string;
  parentRewrite?: { pattern: string; replace: string }[];
  skip?: boolean;
  /** objects matching, on the rule's `device`, become that controller's device points (needs `device`, `reason`) */
  toDevice?: boolean;
  reason?: string;
  evidence: Evidence[];
}

/** Copies of one object on several controllers are one point hosted by `source` (a device's devices.csv object-name). */
export interface MergeRule {
  id: string;
  pattern: string; // anchored; matched against the prefix-stripped object name
  flags?: string;
  source: string;
  evidence: Evidence[];
}

export interface ObjectNamesSection {
  stripPrefix?: { pattern: string; flags?: string; evidence: Evidence[] };
  devices: DeviceRule[];
  rules: ObjectRule[];
  merge?: MergeRule[];
}

export interface NamingSection {
  objectNames?: ObjectNamesSection; // bacnet only
  zoneId?: RegexSpec;
  separator?: string;
  pointToken?: RegexSpec;
  pointParts?: RegexSpec; // bacnet only: named groups token, number, optional rest
  plantToken?: RegexSpec; // both routes: group 1 is the plant token
  unsplittablePointNames?: string[];
  airDirectionMarker?: { pattern: string; flags?: string; supply: string; extract: string };
  /** installation-IFC system name -> plant id: group 1..n of `pattern` fill `plant`'s $1..$n (consumed by Python re) */
  ifcSystemPlant?: { pattern: string; flags?: string; plant: string; evidence: Evidence[] };
}

export type FeedsSource = "floorplanColours" | "roomSchematicPlantButton" | "installationIfc";
export const FEEDS_SOURCES: FeedsSource[] = ["floorplanColours", "roomSchematicPlantButton", "installationIfc"];

export type { PointListFormat };

export interface BuildingProfile {
  schemaVersion: 2;
  buildingId: string;
  dataShape: DataShape;
  inputs: ProfileInputs;
  naming?: NamingSection;
  pointListFormat?: PointListFormat;
  note?: string;
  feedsSources?: FeedsSource[];
  bmsScreens?: string; // path (relative to data/{b}/) of the building's screen guide
  notes?: string[]; // paths (relative to data/{b}/) of building notes
}

export function compileRegex(spec: RegexSpec): RegExp {
  return new RegExp(spec.pattern, spec.flags ?? "");
}

const TOP_KEYS = ["schemaVersion", "buildingId", "dataShape", "inputs", "naming", "pointListFormat", "note", "feedsSources", "bmsScreens", "notes"];
const NAMING_KEYS = ["objectNames", "zoneId", "separator", "pointToken", "pointParts", "plantToken", "unsplittablePointNames", "airDirectionMarker", "ifcSystemPlant"];
const TIMESERIES_ONLY_NAMING = ["zoneId", "pointToken", "unsplittablePointNames"];
const FORMAT_KEYS = ["delimiter", "columns", "nullValue", "skipRows"];
const COLUMN_KEYS = ["plant", "point", "description", "alarmClass"];
const STRING_INPUTS = ["pointList", "tsdbObjects", "devices", "bacnetObjects", "architectureIfc"];
const IMAGE_KEYS = ["plants", "rooms", "floorplans", "plantsOverview", "roomsOverview"];
const DOC_KEYS = ["abbreviations", "functionDescriptions", "zoneMatrix"];
const INPUT_KEYS = [...STRING_INPUTS, "installationIfcs", "images", "docs"];
const LEGACY_SHAPES: Record<string, DataShape> = {
  "csv-tsdb-images": "timeseries",
  "bacnet-scrape": "bacnet",
};

// The data root: BUILDING_DATA_ROOT if set, else <repo>/data (resolved from this
// file, so tools behave the same whatever folder they are run from).
export function dataRoot(): string {
  return process.env.BUILDING_DATA_ROOT ?? path.resolve(__dirname, "..", "..", "data");
}

function defaultRoot(root?: string): string {
  return root ?? dataRoot();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

// Checks one { pattern, flags? } object. Returns true when it is usable (compiles, flags ok).
function checkRegexSpec(
  label: string,
  v: unknown,
  errors: string[],
  opts: { anchored?: boolean; group?: boolean; portable?: boolean } = {}
): boolean {
  if (!isObj(v) || typeof v.pattern !== "string" || v.pattern === "") {
    errors.push(`${label} must be an object with a non-empty "pattern" string`);
    return false;
  }
  for (const k of Object.keys(v)) {
    if (k !== "pattern" && k !== "flags") errors.push(`unknown key "${label}.${k}" (allowed: pattern, flags)`);
  }
  if (v.flags !== undefined && (typeof v.flags !== "string" || !/^[imsu]*$/.test(v.flags))) {
    errors.push(`${label}.flags may only contain i, m, s or u (got ${JSON.stringify(v.flags)})`);
    return false;
  }
  const flags = (v.flags as string | undefined) ?? "";
  try {
    new RegExp(v.pattern, flags);
  } catch (e) {
    errors.push(`${label}.pattern does not compile: ${(e as Error).message}`);
    return false;
  }
  if (opts.anchored && !v.pattern.startsWith("^")) errors.push(`${label}.pattern must start with ^`);
  if (opts.portable && /\(\?<(?![=!])|\(\?P</.test(v.pattern)) {
    errors.push(`${label}.pattern must not use named groups ((?<name>...) or (?P<name>...)); use a plain capture group`);
  }
  if (opts.group && new RegExp(v.pattern + "|", flags).exec("")!.length < 2) {
    errors.push(`${label}.pattern needs at least one capture group`);
  }
  return true;
}

function checkKeys(label: string, v: Record<string, unknown>, allowed: string[], errors: string[]): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) errors.push(`unknown key "${label}.${k}" (allowed: ${allowed.join(", ")})`);
  }
}

function checkEvidence(label: string, v: unknown, errors: string[]): void {
  if (!Array.isArray(v) || v.length === 0 || !v.every((e) => isObj(e) && typeof e.kind === "string")) {
    errors.push(`${label}.evidence must be a non-empty array of objects with a "kind"`);
  }
}

function validateObjectNames(v: unknown, errors: string[]): void {
  const L = "naming.objectNames";
  if (!isObj(v)) {
    errors.push(`${L} must be an object`);
    return;
  }
  checkKeys(L, v, ["stripPrefix", "devices", "rules", "merge"], errors);
  if (v.stripPrefix !== undefined) {
    const sp = v.stripPrefix;
    if (!isObj(sp)) errors.push(`${L}.stripPrefix must be an object`);
    else {
      checkKeys(`${L}.stripPrefix`, sp, ["pattern", "flags", "evidence"], errors);
      checkRegexSpec(`${L}.stripPrefix`, { pattern: sp.pattern, flags: sp.flags }, errors, { anchored: true });
      checkEvidence(`${L}.stripPrefix`, sp.evidence, errors);
    }
  }

  const deviceIds = new Set<string>();
  if (!Array.isArray(v.devices) || v.devices.length === 0) {
    errors.push(`${L}.devices must be a non-empty array`);
  } else {
    v.devices.forEach((d: unknown, i: number) => {
      const dl = `${L}.devices[${i}]`;
      if (!isObj(d)) {
        errors.push(`${dl} must be an object`);
        return;
      }
      checkKeys(dl, d, ["id", "column", "pattern", "flags", "role", "evidence"], errors);
      if (typeof d.id !== "string" || d.id === "") errors.push(`${dl}.id must be a non-empty string`);
      else if (deviceIds.has(d.id)) errors.push(`duplicate device id "${d.id}" in ${L}.devices`);
      else deviceIds.add(d.id);
      if (typeof d.column !== "string" || d.column === "") errors.push(`${dl}.column must be a non-empty string`);
      if (d.role !== "parent" && d.role !== "controller") errors.push(`${dl}.role must be "parent" or "controller"`);
      checkRegexSpec(dl, { pattern: d.pattern, flags: d.flags }, errors);
      checkEvidence(dl, d.evidence, errors);
    });
  }

  const ruleIds = new Set<string>();
  if (v.merge !== undefined) {
    if (!Array.isArray(v.merge)) errors.push(`${L}.merge must be an array`);
    else {
      v.merge.forEach((m: unknown, i: number) => {
        const ml = `${L}.merge[${i}]`;
        if (!isObj(m)) {
          errors.push(`${ml} must be an object`);
          return;
        }
        checkKeys(ml, m, ["id", "pattern", "flags", "source", "evidence"], errors);
        if (typeof m.id !== "string" || m.id === "") errors.push(`${ml}.id must be a non-empty string`);
        else if (ruleIds.has(m.id)) errors.push(`duplicate rule id "${m.id}" in ${L}.merge`);
        else ruleIds.add(m.id);
        checkRegexSpec(ml, { pattern: m.pattern, flags: m.flags }, errors, { anchored: true });
        if (typeof m.source !== "string" || m.source === "") errors.push(`${ml}.source must be a non-empty string`);
        checkEvidence(ml, m.evidence, errors);
      });
    }
  }
  if (!Array.isArray(v.rules) || v.rules.length === 0) {
    errors.push(`${L}.rules must be a non-empty array`);
    return;
  }
  v.rules.forEach((r: unknown, i: number) => {
    const rl = `${L}.rules[${i}]`;
    if (!isObj(r)) {
      errors.push(`${rl} must be an object`);
      return;
    }
    checkKeys(rl, r, ["id", "pattern", "flags", "kind", "device", "parent", "parentRewrite", "skip", "toDevice", "reason", "evidence"], errors);
    if (typeof r.id !== "string" || r.id === "") errors.push(`${rl}.id must be a non-empty string`);
    else if (ruleIds.has(r.id)) errors.push(`duplicate rule id "${r.id}" in ${L}.rules`);
    else ruleIds.add(r.id);
    const ok = checkRegexSpec(rl, { pattern: r.pattern, flags: r.flags }, errors, { anchored: true });
    checkEvidence(rl, r.evidence, errors);
    if (r.skip === true) {
      if (typeof r.reason !== "string" || r.reason === "") errors.push(`${rl} is a skip rule and requires reason`);
      return;
    }
    if (r.skip !== undefined && r.skip !== false) errors.push(`${rl}.skip must be true or omitted`);
    if (r.toDevice !== undefined && r.toDevice !== true && r.toDevice !== false) errors.push(`${rl}.toDevice must be true or omitted`);
    if (r.toDevice === true) {
      if (typeof r.device !== "string" || r.device === "") errors.push(`${rl} is a toDevice rule and requires device`);
      else if (!deviceIds.has(r.device)) errors.push(`${rl}.device names unknown device rule "${r.device}"`);
      if (typeof r.reason !== "string" || r.reason === "") errors.push(`${rl} is a toDevice rule and requires reason`);
      for (const k of ["kind", "parent", "parentRewrite"]) {
        if (r[k] !== undefined) errors.push(`${rl}.${k} is not allowed on a toDevice rule`);
      }
      return;
    }
    if (r.kind !== "plant" && r.kind !== "zone") errors.push(`${rl} requires kind "plant" or "zone"`);
    if (typeof r.device === "string" && !deviceIds.has(r.device)) errors.push(`${rl}.device names unknown device rule "${r.device}"`);
    else if (r.device !== undefined && typeof r.device !== "string") errors.push(`${rl}.device must be a string`);
    if (ok && typeof r.pattern === "string") {
      if (!r.pattern.includes("(?<point>")) errors.push(`${rl}.pattern needs a named group (?<point>`);
      const lit = r.parent;
      if (lit !== undefined && (typeof lit !== "string" || lit === "")) errors.push(`${rl}.parent must be a non-empty string`);
      else if (lit === undefined && !r.pattern.includes("(?<parent>")) {
        errors.push(`${rl}.pattern needs a named group (?<parent> or a literal "parent"`);
      }
    }
    if (r.parentRewrite !== undefined) {
      if (!Array.isArray(r.parentRewrite)) errors.push(`${rl}.parentRewrite must be an array`);
      else {
        r.parentRewrite.forEach((p: unknown, j: number) => {
          const pl = `${rl}.parentRewrite[${j}]`;
          if (!isObj(p) || typeof p.replace !== "string") {
            errors.push(`${pl} must be an object with a "replace" string`);
            return;
          }
          checkKeys(pl, p, ["pattern", "replace"], errors);
          checkRegexSpec(pl, { pattern: p.pattern }, errors);
        });
      }
    }
  });
}

function validateIfcSystemPlant(v: unknown, errors: string[]): void {
  const L = "naming.ifcSystemPlant";
  if (!isObj(v)) {
    errors.push(`${L} must be an object`);
    return;
  }
  checkKeys(L, v, ["pattern", "flags", "plant", "evidence"], errors);
  const ok = checkRegexSpec(L, { pattern: v.pattern, flags: v.flags }, errors, { group: true, portable: true });
  if (typeof v.plant !== "string" || v.plant === "") {
    errors.push(`${L}.plant must be a non-empty string`);
  } else if (ok) {
    const groups = new RegExp((v.pattern as string) + "|", (v.flags as string | undefined) ?? "").exec("")!.length - 1;
    for (const m of v.plant.matchAll(/\$(\d+)/g)) {
      const n = Number(m[1]);
      if (n < 1 || n > groups) errors.push(`${L}.plant uses ${m[0]} but the pattern has ${groups} capture group(s)`);
    }
  }
  checkEvidence(L, v.evidence, errors);
}

function validateNaming(v: unknown, shape: unknown, errors: string[]): void {
  if (v === undefined) {
    if (shape === "timeseries") errors.push('dataShape "timeseries" requires naming');
    if (shape === "bacnet") {
      errors.push('dataShape "bacnet" requires naming.separator');
      errors.push('dataShape "bacnet" requires naming.objectNames');
    }
    return;
  }
  if (!isObj(v)) {
    errors.push("naming must be an object");
    return;
  }
  for (const k of Object.keys(v)) {
    if (!NAMING_KEYS.includes(k)) errors.push(`unknown key "naming.${k}" (allowed: ${NAMING_KEYS.join(", ")})`);
    else if (shape === "bacnet" && TIMESERIES_ONLY_NAMING.includes(k)) {
      errors.push(`naming.${k} is not read for bacnet buildings`);
    } else if (shape === "timeseries" && (k === "pointParts" || k === "objectNames")) {
      errors.push(`naming.${k} is not read for timeseries buildings`);
    }
  }
  if (shape === "timeseries") {
    for (const k of ["zoneId", "separator", "pointToken"]) {
      if (v[k] === undefined) errors.push(`dataShape "timeseries" requires naming.${k}`);
    }
  }
  if (shape === "bacnet") {
    if (v.separator === undefined) errors.push('dataShape "bacnet" requires naming.separator');
    if (v.objectNames === undefined) errors.push('dataShape "bacnet" requires naming.objectNames');
  }
  if (v.objectNames !== undefined && shape !== "timeseries") validateObjectNames(v.objectNames, errors);
  if (v.zoneId !== undefined) checkRegexSpec("naming.zoneId", v.zoneId, errors, { anchored: true, group: true, portable: true });
  if (v.pointToken !== undefined) checkRegexSpec("naming.pointToken", v.pointToken, errors, { anchored: true, group: true });
  if (v.pointParts !== undefined && checkRegexSpec("naming.pointParts", v.pointParts, errors, { anchored: true })) {
    const pat = (v.pointParts as RegexSpec).pattern;
    for (const g of ["token", "number"]) {
      if (!pat.includes(`(?<${g}>`)) errors.push(`naming.pointParts.pattern needs a named group "${g}"`);
    }
  }
  if (v.plantToken !== undefined) checkRegexSpec("naming.plantToken", v.plantToken, errors, { group: true });
  if (v.separator !== undefined && (typeof v.separator !== "string" || v.separator === "")) {
    errors.push("naming.separator must be a non-empty string");
  }
  if (v.unsplittablePointNames !== undefined && !isStringArray(v.unsplittablePointNames)) {
    errors.push("naming.unsplittablePointNames must be an array of strings");
  }
  if (v.ifcSystemPlant !== undefined) validateIfcSystemPlant(v.ifcSystemPlant, errors);
  const m = v.airDirectionMarker;
  if (m !== undefined) {
    if (!isObj(m)) {
      errors.push("naming.airDirectionMarker must be an object");
    } else {
      for (const k of Object.keys(m)) {
        if (!["pattern", "flags", "supply", "extract"].includes(k)) {
          errors.push(`unknown key "naming.airDirectionMarker.${k}" (allowed: pattern, flags, supply, extract)`);
        }
      }
      checkRegexSpec("naming.airDirectionMarker", { pattern: m.pattern, flags: m.flags }, errors, { group: true });
      const okStr = (s: unknown) => typeof s === "string" && s !== "";
      if (!okStr(m.supply)) errors.push("naming.airDirectionMarker.supply must be a non-empty string");
      if (!okStr(m.extract)) errors.push("naming.airDirectionMarker.extract must be a non-empty string");
      if (okStr(m.supply) && m.supply === m.extract) {
        errors.push("naming.airDirectionMarker.supply and extract must differ");
      }
    }
  }
}

function validatePointListFormat(v: unknown, shape: unknown, errors: string[]): void {
  if (v === undefined) {
    if (shape === "timeseries") errors.push('dataShape "timeseries" requires pointListFormat');
    return;
  }
  if (shape === "bacnet") {
    errors.push("pointListFormat is not read for bacnet buildings");
    return;
  }
  if (!isObj(v)) {
    errors.push("pointListFormat must be an object");
    return;
  }
  for (const k of Object.keys(v)) {
    if (!FORMAT_KEYS.includes(k)) errors.push(`unknown key "pointListFormat.${k}" (allowed: ${FORMAT_KEYS.join(", ")})`);
  }
  if (typeof v.delimiter !== "string" || v.delimiter.length !== 1) {
    errors.push("pointListFormat.delimiter must be exactly one character");
  }
  const declaredCols: string[] = [];
  if (!isObj(v.columns)) {
    errors.push("pointListFormat.columns must be an object");
  } else {
    for (const k of Object.keys(v.columns)) {
      if (!COLUMN_KEYS.includes(k)) {
        errors.push(`unknown key "pointListFormat.columns.${k}" (allowed: ${COLUMN_KEYS.join(", ")})`);
      } else if (typeof v.columns[k] !== "string" || v.columns[k] === "") {
        errors.push(`pointListFormat.columns.${k} must be a non-empty header name`);
      } else declaredCols.push(k);
    }
    for (const k of ["plant", "point"]) {
      if (v.columns[k] === undefined) errors.push(`pointListFormat.columns.${k} is required`);
    }
  }
  if (v.nullValue !== undefined && typeof v.nullValue !== "string") {
    errors.push("pointListFormat.nullValue must be a string");
  }
  if (v.skipRows !== undefined) {
    if (!Array.isArray(v.skipRows)) {
      errors.push("pointListFormat.skipRows must be an array of { column, equals }");
    } else {
      v.skipRows.forEach((s, i) => {
        if (!isObj(s)) {
          errors.push(`pointListFormat.skipRows[${i}] must be an object`);
          return;
        }
        for (const k of Object.keys(s)) {
          if (k !== "column" && k !== "equals") errors.push(`unknown key "pointListFormat.skipRows[${i}].${k}" (allowed: column, equals)`);
        }
        if (typeof s.column !== "string" || !declaredCols.includes(s.column)) {
          errors.push(`pointListFormat.skipRows[${i}].column must be a declared column (one of: ${declaredCols.join(", ")})`);
        }
        if (typeof s.equals !== "string") errors.push(`pointListFormat.skipRows[${i}].equals must be a string`);
      });
    }
  }
}

export function validateProfile(
  raw: unknown,
  folderName: string,
  dataRoot?: string
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = defaultRoot(dataRoot);

  if (!isObj(raw)) {
    errors.push("profile must be a JSON object");
    return { errors, warnings };
  }

  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) errors.push(`unknown top-level key "${k}" (allowed: ${TOP_KEYS.join(", ")})`);
  }

  if (raw.schemaVersion !== 2) {
    errors.push(
      `schemaVersion must be 2 (got ${JSON.stringify(raw.schemaVersion)}); v2 adds the "naming" and "pointListFormat" sections — redo the inventory step (see point-mapping skill)`
    );
  }

  if (typeof raw.buildingId !== "string" || !raw.buildingId) {
    errors.push("buildingId must be a non-empty string");
  } else if (raw.buildingId !== folderName) {
    errors.push(`buildingId "${raw.buildingId}" does not match folder name "${folderName}"`);
  }

  const shape = raw.dataShape;
  if (shape !== "timeseries" && shape !== "bacnet") {
    const legacy = typeof shape === "string" ? LEGACY_SHAPES[shape] : undefined;
    if (legacy) {
      errors.push(`dataShape "${shape}" is a legacy value; use "${legacy}"`);
    } else {
      errors.push(`dataShape must be "timeseries" or "bacnet" (got ${JSON.stringify(shape)})`);
    }
  }

  const declared: Array<[string, string]> = []; // [label, relative path]
  let inputs: Record<string, unknown> = {};
  if (raw.inputs === undefined) {
    // reported below via shape-required checks
  } else if (!isObj(raw.inputs)) {
    errors.push("inputs must be an object");
  } else {
    inputs = raw.inputs;
    for (const k of Object.keys(inputs)) {
      if (!INPUT_KEYS.includes(k)) errors.push(`unknown key "inputs.${k}" (allowed: ${INPUT_KEYS.join(", ")})`);
    }
    for (const k of STRING_INPUTS) {
      if (inputs[k] === undefined) continue;
      if (typeof inputs[k] !== "string") errors.push(`inputs.${k} must be a string`);
      else declared.push([`inputs.${k}`, inputs[k] as string]);
    }
    if (inputs.installationIfcs !== undefined) {
      if (!isStringArray(inputs.installationIfcs)) errors.push("inputs.installationIfcs must be an array of strings");
      else inputs.installationIfcs.forEach((p, i) => declared.push([`inputs.installationIfcs[${i}]`, p]));
    }
    if (inputs.images !== undefined) {
      if (!isObj(inputs.images)) errors.push("inputs.images must be an object");
      else {
        for (const k of Object.keys(inputs.images)) {
          const v = inputs.images[k];
          if (!IMAGE_KEYS.includes(k)) errors.push(`unknown key "inputs.images.${k}" (allowed: ${IMAGE_KEYS.join(", ")})`);
          else if (typeof v !== "string") errors.push(`inputs.images.${k} must be a string`);
          else declared.push([`inputs.images.${k}`, v]);
        }
      }
    }
    if (inputs.docs !== undefined) {
      if (!isObj(inputs.docs)) errors.push("inputs.docs must be an object");
      else {
        for (const k of Object.keys(inputs.docs)) {
          const v = inputs.docs[k];
          if (!DOC_KEYS.includes(k)) errors.push(`unknown key "inputs.docs.${k}" (allowed: ${DOC_KEYS.join(", ")})`);
          else if (typeof v === "string") declared.push([`inputs.docs.${k}`, v]);
          else if (isStringArray(v)) v.forEach((p, i) => declared.push([`inputs.docs.${k}[${i}]`, p]));
          else errors.push(`inputs.docs.${k} must be a string or an array of strings`);
        }
      }
    }
  }

  if (raw.note !== undefined && typeof raw.note !== "string") errors.push("note must be a string");

  if (raw.feedsSources !== undefined) {
    const fs_ = raw.feedsSources;
    if (!Array.isArray(fs_)) errors.push("feedsSources must be an array");
    else if (fs_.length === 0) errors.push("feedsSources must not be empty; omit it when the building has no feeds source");
    else {
      const images = isObj(inputs.images) ? inputs.images : {};
      const naming = isObj(raw.naming) ? raw.naming : {};
      const seen = new Set<unknown>();
      fs_.forEach((s, i) => {
        if (!FEEDS_SOURCES.includes(s as FeedsSource)) {
          errors.push(`feedsSources[${i}] must be one of: ${FEEDS_SOURCES.join(", ")} (got ${JSON.stringify(s)})`);
          return;
        }
        if (seen.has(s)) errors.push(`feedsSources[${i}] is a duplicate of "${s}"`);
        seen.add(s);
        if (s === "floorplanColours" && images.floorplans === undefined) {
          errors.push(`feedsSources[${i}] "floorplanColours" needs inputs.images.floorplans`);
        }
        if (s === "roomSchematicPlantButton" && images.rooms === undefined) {
          errors.push(`feedsSources[${i}] "roomSchematicPlantButton" needs inputs.images.rooms`);
        }
        if (s === "installationIfc") {
          if (!Array.isArray(inputs.installationIfcs) || inputs.installationIfcs.length === 0) {
            errors.push(`feedsSources[${i}] "installationIfc" needs a non-empty inputs.installationIfcs`);
          }
          if (naming.ifcSystemPlant === undefined) {
            errors.push(`feedsSources[${i}] "installationIfc" needs naming.ifcSystemPlant`);
          }
        }
      });
    }
  }

  if (raw.bmsScreens !== undefined) {
    if (typeof raw.bmsScreens !== "string") errors.push("bmsScreens must be a string");
    else declared.push(["bmsScreens", raw.bmsScreens]);
  } else if (isObj(inputs.images) && Object.keys(inputs.images).length > 0) {
    warnings.push("inputs.images is declared but bmsScreens is not: the image skills need the building's screen guide");
  }
  if (raw.notes !== undefined) {
    if (!Array.isArray(raw.notes)) errors.push("notes must be an array of strings");
    else
      raw.notes.forEach((p, i) => {
        if (typeof p !== "string") errors.push(`notes[${i}] must be a string`);
        else declared.push([`notes[${i}]`, p]);
      });
  }
  if (
    Array.isArray(inputs.installationIfcs) &&
    inputs.installationIfcs.length > 0 &&
    !(isObj(raw.naming) && raw.naming.ifcSystemPlant !== undefined)
  ) {
    warnings.push("inputs.installationIfcs is declared but naming.ifcSystemPlant is not: the IFC's systems map to no plant");
  }

  const required: Record<string, string[]> = {
    timeseries: ["pointList", "tsdbObjects"],
    bacnet: ["devices", "bacnetObjects"],
  };
  if (shape === "timeseries" || shape === "bacnet") {
    for (const k of required[shape]) {
      if (typeof inputs[k] !== "string") errors.push(`dataShape "${shape}" requires inputs.${k}`);
    }
  }

  validateNaming(raw.naming, shape, errors);
  validatePointListFormat(raw.pointListFormat, shape, errors);

  for (const [label, rel] of declared) {
    if (rel.trim() === "") {
      errors.push(`${label} must be a non-empty path`);
      continue;
    }
    const full = path.join(root, folderName, rel);
    if (!fs.existsSync(full)) warnings.push(`${label}: declared path does not exist: ${full}`);
  }

  return { errors, warnings };
}

// Write-time data check (never called by loadProfile): parses the declared point list with the
// profile's pointListFormat and counts zone/plant rows with naming.zoneId. Assumes the profile
// already passed validateProfile. A missing point-list file is skipped (validateProfile warns).
export function checkProfileData(
  profile: BuildingProfile,
  dataRootDir?: string
): { errors: string[]; warnings: string[]; report: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report: string[] = [];
  const fmt = profile.pointListFormat;
  const zone = profile.naming?.zoneId;
  if (profile.dataShape !== "timeseries" || !fmt || !zone || !profile.inputs.pointList) {
    return { errors, warnings, report };
  }
  if (typeof fmt.delimiter !== "string" || fmt.delimiter.length !== 1) {
    errors.push("pointListFormat.delimiter must be exactly one character");
    return { errors, warnings, report };
  }
  const file = inputPath(profile, "pointList", dataRootDir);
  if (!fs.existsSync(file)) {
    report.push(`point list not found, data check skipped: ${file}`);
    return { errors, warnings, report };
  }
  const text = fs.readFileSync(file, "utf-8");
  const parsed = parsePointList(text, fmt);
  if (parsed.malformed) errors.push(`${file}: ${parsed.malformed}`);
  for (const col of parsed.missingColumns) {
    errors.push(`pointListFormat: column "${col}" not found in the header of ${file} (header: ${parsed.header})`);
  }
  if (errors.length) return { errors, warnings, report };

  const zoneRe = compileRegex(zone);
  for (const r of parsed.rows) {
    const m = zoneRe.exec(r.plant);
    if (m && !r.plant.startsWith(m[1])) {
      errors.push(
        `naming.zoneId capture group 1 must be the start of the Plant value (Plant "${r.plant}", group 1 "${m[1]}")`
      );
      break;
    }
  }
  if (errors.length) return { errors, warnings, report };
  const zoneRows = parsed.rows.filter((r) => zoneRe.test(r.plant)).length;
  const plantRows = parsed.rows.length - zoneRows;

  // Null cells, over the rows that were not skipped. The skipped rows are removed from the
  // unskipped parse in order, so the survivors line up by index.
  let nullCells = 0;
  if (fmt.nullValue !== undefined) {
    const raw = parsePointList(text, { ...fmt, nullValue: undefined, skipRows: undefined });
    let j = 0;
    for (const r of raw.rows) {
      if (j >= parsed.rows.length || r.line !== parsed.rows[j].line) continue; // skipped row
      j++;
      for (const c of [r.plant, r.point, r.description, r.alarmClass]) if (c === fmt.nullValue) nullCells++;
    }
  }

  report.push(`point list: ${file}`);
  report.push(`data rows: ${parsed.rows.length}`);
  for (const [key, n] of Object.entries(parsed.skipped)) report.push(`skipped by ${key}: ${n}`);
  report.push(`zone rows: ${zoneRows}`);
  report.push(`plant rows: ${plantRows}`);
  report.push(`null cells: ${nullCells}`);

  if (zoneRows === 0) warnings.push(`naming.zoneId matches no zone rows in ${file}`);
  else if (plantRows === 0) warnings.push(`naming.zoneId matches every row in ${file} (0 plant rows)`);
  return { errors, warnings, report };
}

export function loadProfile(buildingId: string, dataRoot?: string): BuildingProfile {
  const root = defaultRoot(dataRoot);
  const file = path.join(root, buildingId, "building-config.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `${buildingId}: no building profile — run the inventory step (see point-mapping skill). Looked for ${path.resolve(file)}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    throw new Error(`${buildingId}: ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const { errors, warnings } = validateProfile(raw, buildingId, root);
  if (errors.length) {
    throw new Error(`${buildingId}: invalid building profile (${file}):\n  - ${errors.join("\n  - ")}`);
  }
  for (const w of warnings) console.warn(`[building-profile] warning: ${buildingId}: ${w}`);
  return raw as BuildingProfile;
}

export function requireShape(profile: BuildingProfile, shape: DataShape, toolName: string): void {
  if (profile.dataShape !== shape) {
    throw new Error(`${toolName} handles ${shape} buildings; ${profile.buildingId} is ${profile.dataShape}`);
  }
}

export function inputPath(
  profile: BuildingProfile,
  key: "pointList" | "tsdbObjects" | "devices" | "bacnetObjects",
  dataRoot?: string
): string {
  const rel = profile.inputs[key];
  if (!rel) throw new Error(`${profile.buildingId}: profile declares no inputs.${key}`);
  return path.join(defaultRoot(dataRoot), profile.buildingId, rel);
}
