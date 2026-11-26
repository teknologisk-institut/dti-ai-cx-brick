// tools/lib/point-dictionary.ts
//
// Shared loader for data/{buildingId}/point-dictionary.json -- the per-building
// Danish-abbreviation decoder dictionary. HITL touchpoint 2's write-back target
// (see tools/write-point-dictionary-entry.ts for writes). A read-only INPUT the
// mappers consult at construction time, same category as the CSV/objects.json --
// never written by the mappers themselves, so "mapper fully overwrites its output
// every run" stays true and unchanged.
//
// The one dictionary shape is schemaVersion 3; loadPartsDictionary is its loader.

import * as fs from "fs";
import * as path from "path";
import { compileRegex, dataRoot } from "./building-profile";
import { quoteStatus } from "./doc-text";
import { asPartsDictionary, combinePoint, decidingEntries, loadDataPoints, loadPointInputs, mappedRawIds, V3_POINT_ENTRY } from "./dictionary-data";
import type { DataPoint } from "./dictionary-data";

/** Why an entry exists: a documentation citation, matching data rows, a human answer, or a legacy note. */
export type Evidence =
  | { kind: "doc"; file: string; location: string; quote: string }
  | { kind: "data"; rows: { pointId: string; description: string }[]; count: number }
  | { kind: "human"; answer: string; date: string }
  | { kind: "pre-existing"; source: string }
  | { kind: "carried-over"; classes: Record<string, number>; points: number; reviewed: number };

export interface MeterReadings {
  prefixes: string[];
  readings: Record<string, { category: string; meaning: string; tags?: string[]; evidence?: Evidence[] }>;
  source: string;
  evidence?: Evidence[];
}

export interface NotEquipment {
  abbreviations: string[];
  prefixes: string[];
  source: string;
  evidence?: Evidence[];
}

export interface EquipmentIdRule {
  pattern: string;
  flags?: string;
  type?: string;
  airDamper?: boolean;
  plantOnly?: boolean;
  dropIfSibling?: { pattern: string; flags?: string };
  source: string;
  evidence?: Evidence[];
}

export const ROLE_TAGS = ["Sensor", "Setpoint", "Command", "Status", "Alarm", "Parameter"];
// Copied from DIM in lib/tag-match.ts (which stays untouched).
export const QUANTITY_TAGS = ["CO2", "Humidity", "Pressure", "Flow", "Temperature", "Energy", "Power", "Illuminance"];
export const MEDIUM_TAGS = ["Air", "Water", "Hot", "Chilled", "Domestic"];

/** One-line provenance for an evidence list, e.g. "doc: file.csv row 12; data: 3 rows". Kinds in
 * array order; only the first doc is cited. */
export function renderEvidenceSource(evidence: Evidence[]): string {
  const parts: string[] = [];
  let docSeen = false;
  for (const e of evidence) {
    if (e.kind === "doc") {
      if (docSeen) continue;
      docSeen = true;
      parts.push(`doc: ${e.file} ${e.location}`);
    } else if (e.kind === "data") parts.push(`data: ${e.count} rows`);
    else if (e.kind === "human") parts.push(`human: ${e.date}`);
    else if (e.kind === "carried-over") parts.push(`carried-over: ${e.points} points`);
    else parts.push(`pre-existing: ${e.source}`);
  }
  return parts.join("; ");
}

function dictionaryPath(buildingId: string): string {
  return path.join(dataRoot(), buildingId, "point-dictionary.json");
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Checks a regex spec object. Every problem is reported (a bad flags value does not hide a bad
 * pattern). */
function checkRegex(label: string, v: Record<string, any>, errors: string[]): void {
  const pat = v.pattern;
  if (typeof pat !== "string" || pat === "") {
    errors.push(`${label}.pattern must be a non-empty string`);
    return;
  }
  let flags: string | undefined = v.flags;
  if (flags !== undefined && (typeof flags !== "string" || !/^[imsu]*$/.test(flags))) {
    errors.push(`${label}.flags may only contain i, m, s or u (got ${JSON.stringify(flags)})`);
    flags = undefined;
  }
  try {
    compileRegex({ pattern: pat, flags });
  } catch (e) {
    errors.push(`${label}.pattern does not compile: ${(e as Error).message}`);
  }
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v !== "";
}

/** Type-checks the optional `tags` and `evidence` fields of an entry. */
function checkTagsEvidence(label: string, v: Record<string, any>, errors: string[], allowCarriedOver = false): void {
  if (v.tags !== undefined && (!Array.isArray(v.tags) || v.tags.some((t: unknown) => !isNonEmptyString(t)))) {
    errors.push(`${label}.tags must be an array of non-empty strings`);
  }
  if (v.evidence === undefined) return;
  if (!Array.isArray(v.evidence)) return void errors.push(`${label}.evidence must be an array`);
  v.evidence.forEach((e: unknown, i: number) => {
    const el = `${label}.evidence[${i}]`;
    if (!isObj(e)) return void errors.push(`${el} must be an object`);
    const need = (fields: string[]): void => {
      for (const f of fields) if (!isNonEmptyString(e[f])) errors.push(`${el}.${f} must be a non-empty string`);
    };
    if (e.kind === "doc") need(["file", "location", "quote"]);
    else if (e.kind === "human") need(["answer", "date"]);
    else if (e.kind === "pre-existing") need(["source"]);
    else if (e.kind === "data") {
      if (!Number.isInteger(e.count) || e.count < 0) errors.push(`${el}.count must be a non-negative integer`);
      if (!Array.isArray(e.rows)) errors.push(`${el}.rows must be an array`);
      else
        e.rows.forEach((r: unknown, j: number) => {
          if (!isObj(r) || !isNonEmptyString(r.pointId) || typeof r.description !== "string") {
            errors.push(`${el}.rows[${j}] must have a pointId and a description`);
          }
        });
    } else if (e.kind === "carried-over" && allowCarriedOver) {
      if (!isObj(e.classes) || Object.values(e.classes).some((n) => !Number.isInteger(n) || (n as number) < 0)) {
        errors.push(`${el}.classes must be an object of class name -> non-negative integer count`);
      }
      for (const f of ["points", "reviewed"]) {
        if (!Number.isInteger(e[f]) || e[f] < 0) errors.push(`${el}.${f} must be a non-negative integer`);
      }
    } else {
      const kinds = allowCarriedOver ? "doc, data, human, pre-existing, carried-over" : "doc, data, human, pre-existing";
      errors.push(`${el}.kind must be one of ${kinds} (got ${JSON.stringify(e.kind)})`);
    }
  });
}

/** A section needs a non-empty `source` string or a non-empty `evidence` array. */
function checkSource(label: string, v: Record<string, any>, errors: string[], allowCarriedOver = false): void {
  const hasEvidence = Array.isArray(v.evidence) && v.evidence.length > 0;
  if (!hasEvidence && !isNonEmptyString(v.source)) {
    errors.push(`${label}.source is required (non-empty string), or a non-empty evidence array`);
  }
  checkTagsEvidence(label, v, errors, allowCarriedOver);
}

function checkKeys(label: string, v: Record<string, any>, allowed: string[], errors: string[]): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) errors.push(`unknown key "${label}.${k}" (allowed: ${allowed.join(", ")})`);
  }
}

/** A meter reading's meaning template: its only placeholder is {meter}. */
function checkMeterTemplate(label: string, meaning: unknown, errors: string[]): void {
  if (typeof meaning !== "string" || meaning === "") {
    errors.push(`${label}.meaning must be a non-empty string`);
    return;
  }
  for (const m of meaning.matchAll(/\{([^{}]*)\}/g)) {
    if (m[1] !== "meter") errors.push(`${label}.meaning has unknown placeholder {${m[1]}} (allowed: {meter})`);
  }
}

function checkMeterReadings(label: string, mr: unknown, errors: string[], allowCarriedOver = false): void {
  if (!isObj(mr)) return void errors.push(`${label} must be an object`);
  const m = mr;
  checkKeys(label, m, ["prefixes", "readings", "source", "evidence"], errors);
  if (!Array.isArray(m.prefixes) || m.prefixes.some((x: unknown) => typeof x !== "string")) {
    errors.push(`${label}.prefixes must be an array of strings`);
  }
  if (!isObj(m.readings)) errors.push(`${label}.readings must be an object`);
  else
    for (const [k, r] of Object.entries(m.readings)) {
      const rl = `${label}.readings.${k}`;
      if (!isObj(r)) {
        errors.push(`${rl} must be an object`);
        continue;
      }
      checkKeys(rl, r, ["category", "meaning", "tags", "evidence"], errors);
      if (typeof r.category !== "string" || r.category === "") errors.push(`${rl}.category must be a non-empty string`);
      checkMeterTemplate(rl, r.meaning, errors);
      checkTagsEvidence(rl, r, errors, allowCarriedOver);
    }
  checkSource(label, m, errors, allowCarriedOver);
}

function checkNotEquipment(label: string, ne: unknown, errors: string[], allowCarriedOver = false): void {
  if (!isObj(ne)) return void errors.push(`${label} must be an object`);
  checkKeys(label, ne, ["abbreviations", "prefixes", "source", "evidence"], errors);
  for (const f of ["abbreviations", "prefixes"]) {
    if (!Array.isArray(ne[f]) || ne[f].some((x: unknown) => typeof x !== "string")) {
      errors.push(`${label}.${f} must be an array of strings`);
    }
  }
  checkSource(label, ne, errors, allowCarriedOver);
}

function checkEquipmentIdRules(rules: unknown, errors: string[], allowCarriedOver = false): void {
  if (!Array.isArray(rules)) return void errors.push("equipmentIdRules must be an array");
  rules.forEach((r: unknown, i: number) => {
    const label = `equipmentIdRules[${i}]`;
    if (!isObj(r)) return void errors.push(`${label} must be an object`);
    checkKeys(label, r, ["pattern", "flags", "type", "airDamper", "plantOnly", "dropIfSibling", "source", "evidence"], errors);
    checkRegex(label, r, errors);
    if (r.type !== undefined && (typeof r.type !== "string" || r.type === "")) errors.push(`${label}.type must be a non-empty string`);
    for (const b of ["airDamper", "plantOnly"]) {
      if (r[b] !== undefined && typeof r[b] !== "boolean") errors.push(`${label}.${b} must be a boolean`);
    }
    if (r.dropIfSibling !== undefined) {
      const dl = `${label}.dropIfSibling`;
      if (!isObj(r.dropIfSibling)) errors.push(`${dl} must be an object`);
      else {
        checkKeys(dl, r.dropIfSibling, ["pattern", "flags"], errors);
        checkRegex(dl, r.dropIfSibling, errors);
      }
    }
    checkSource(label, r, errors, allowCarriedOver);
  });
}

/** The point `source` for a deciding entry: the rendered evidence when it has any, else its own
 * `source` (possibly undefined). */
export function entrySource(e: { source?: string; evidence?: Evidence[] } | undefined): string | undefined {
  if (!e) return undefined;
  return e.evidence && e.evidence.length ? renderEvidenceSource(e.evidence) : e.source;
}

/** The `tags` key to spread onto a point: present only when the entry has a non-empty tag list. */
export function tagsField(tags: string[] | undefined): { tags?: string[] } {
  return tags && tags.length ? { tags: tags.slice() } : {};
}

/** Fills `{meter}` in a meterReadings meaning template. */
export function renderMeterMeaning(template: string, meterMeaning: string): string {
  return template.replace(/\{meter\}/g, meterMeaning);
}

// ---------------------------------------------------------------------------
// Schema version 3: the one dictionary shape
// ---------------------------------------------------------------------------

export type Ctx = "zone" | "plant" | "any";

export interface PartEntry {
  meaning: string;
  tags: string[];
  danishGloss?: string;
  evidence: Evidence[];
  equipmentType?: string;
  status?: string;
  review?: any;
}
export interface SuffixEntry extends PartEntry {
  pattern: string;
  flags?: string;
  context?: Ctx;
}
export interface WordEntry extends PartEntry {
  phrase: string;
  context?: Ctx;
  appliesTo?: Array<"description" | "stateText" | "plantName" | "equipment" | "roomName" | "storeyName" | "useGroup" | "spaceCategory">;
  /** roomName/storeyName words: the REC class the word names (exactly one of recClass or exclude). */
  recClass?: string;
  /** useGroup words: the REC classes a use-group name stands for. */
  recClasses?: string[];
  /** storeyName/spaceCategory words: names that are not a room/level (excluded). */
  exclude?: true;
}
export interface PartsDictionary {
  schemaVersion: 3;
  tokens: Partial<Record<Ctx, Record<string, PartEntry>>>;
  suffixes: SuffixEntry[];
  words: WordEntry[];
  units: Record<string, PartEntry>;
  overrides: Record<string, PartEntry>;
  plantTokens: Record<string, PartEntry>;
  plantOverrides: Record<string, PartEntry>;
  meterReadings?: MeterReadings;
  notEquipment?: NotEquipment;
  equipmentIdRules?: EquipmentIdRule[];
}

const CTXS: Ctx[] = ["zone", "plant", "any"];
const APPLIES_TO = ["description", "stateText", "plantName", "equipment"];
/** Word targets that act on spatial names (rooms, storeys, use groups, space categories), never on point descriptions. */
export const SPATIAL_APPLIES_TO = ["roomName", "storeyName", "useGroup", "spaceCategory"];
const V3_KEYS = ["schemaVersion", "tokens", "suffixes", "words", "units", "overrides", "plantTokens", "plantOverrides", "meterReadings", "notEquipment", "equipmentIdRules", "accounting"];
const PART_KEYS = ["meaning", "tags", "danishGloss", "evidence", "equipmentType", "status", "review"];

/** A part entry: meaning, tags and a non-empty evidence array (kinds as today plus carried-over). */
function checkPartEntry(label: string, e: unknown, extraKeys: string[], errors: string[]): e is Record<string, any> {
  if (!isObj(e)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  checkKeys(label, e, [...PART_KEYS, ...extraKeys], errors);
  if (!isNonEmptyString(e.meaning)) errors.push(`${label}.meaning must be a non-empty string`);
  if (!Array.isArray(e.tags)) errors.push(`${label}.tags must be an array`);
  if (!Array.isArray(e.evidence) || e.evidence.length === 0) errors.push(`${label}.evidence must be a non-empty array`);
  checkTagsEvidence(label, e, errors, true);
  return true;
}

function checkPartTable(label: string, t: unknown, errors: string[]): void {
  if (!isObj(t)) return void errors.push(`${label} must be an object`);
  for (const [k, e] of Object.entries(t)) checkPartEntry(`${label}.${k}`, e, [], errors);
}

/** Spatial word rules: appliesTo is all spatial or all point-side; recClass / recClasses / exclude only where they belong. */
function checkSpatialWord(label: string, r: Record<string, any>, errors: string[]): void {
  const applies: unknown[] = Array.isArray(r.appliesTo) ? r.appliesTo : [];
  const spatial = applies.filter((a) => SPATIAL_APPLIES_TO.includes(a as string));
  if (spatial.length > 0 && spatial.length !== applies.length) {
    errors.push(`${label}.appliesTo must not mix ${SPATIAL_APPLIES_TO.join("/")} with ${APPLIES_TO.join("/")}`);
  }
  const has = (a: string): boolean => applies.includes(a);
  if (r.recClass !== undefined) {
    if (!has("roomName") && !has("storeyName")) errors.push(`${label}.recClass is only allowed with appliesTo roomName or storeyName`);
    if (typeof r.recClass !== "string" || !r.recClass.startsWith("rec:")) errors.push(`${label}.recClass must be a string starting with "rec:"`);
  }
  if (r.recClasses !== undefined) {
    if (!has("useGroup")) errors.push(`${label}.recClasses is only allowed with appliesTo useGroup`);
    if (!Array.isArray(r.recClasses) || r.recClasses.length === 0 || !r.recClasses.every((c: unknown) => typeof c === "string" && c.startsWith("rec:"))) {
      errors.push(`${label}.recClasses must be a non-empty array of strings starting with "rec:"`);
    }
  }
  if (r.exclude !== undefined) {
    if (r.exclude !== true) errors.push(`${label}.exclude must be true when present`);
    if (!has("storeyName") && !has("spaceCategory")) errors.push(`${label}.exclude is only allowed with appliesTo storeyName or spaceCategory`);
    if (r.recClass !== undefined) errors.push(`${label}.exclude and recClass cannot both be set`);
  }
  if ((has("roomName") || has("storeyName")) && r.recClass === undefined && r.exclude === undefined) {
    errors.push(`${label} (roomName/storeyName) needs exactly one of recClass or exclude`);
  }
}

/** Structural check of a version-3 dictionary (no Brick index needed). Errors name their path. */
export function validatePartsDictionary(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(raw)) return ["dictionary must be an object"];
  if (raw.schemaVersion !== 3) errors.push(`schemaVersion must be 3 (got ${JSON.stringify(raw.schemaVersion)})`);
  checkKeys("dictionary", raw, V3_KEYS, errors);

  if (!isObj(raw.tokens)) errors.push("tokens must be an object");
  else
    for (const [c, t] of Object.entries(raw.tokens)) {
      if (!CTXS.includes(c as Ctx)) errors.push(`tokens.${c}: context must be one of ${CTXS.join(", ")}`);
      else checkPartTable(`tokens.${c}`, t, errors);
    }
  for (const k of ["units", "overrides", "plantTokens", "plantOverrides"]) checkPartTable(k, raw[k], errors);

  if (!Array.isArray(raw.suffixes)) errors.push("suffixes must be an array");
  else
    raw.suffixes.forEach((r: unknown, i: number) => {
      const label = `suffixes[${i}]`;
      if (!checkPartEntry(label, r, ["pattern", "flags", "context"], errors)) return;
      checkRegex(label, r, errors);
      if (r.context !== undefined && !CTXS.includes(r.context)) errors.push(`${label}.context must be one of ${CTXS.join(", ")}`);
    });

  if (!Array.isArray(raw.words)) errors.push("words must be an array");
  else
    raw.words.forEach((r: unknown, i: number) => {
      const label = `words[${i}]`;
      if (!checkPartEntry(label, r, ["phrase", "context", "appliesTo", "recClass", "recClasses", "exclude"], errors)) return;
      if (!isNonEmptyString(r.phrase)) errors.push(`${label}.phrase must be a non-empty string`);
      else if (!/^[\p{L}\p{N} .\-/']+$/u.test(r.phrase)) {
        errors.push(`${label}.phrase must be plain text (only letters, digits, spaces and . - / ' are allowed; no regular expressions)`);
      }
      if (r.context !== undefined && !CTXS.includes(r.context)) errors.push(`${label}.context must be one of ${CTXS.join(", ")}`);
      if (r.appliesTo !== undefined) {
        if (!Array.isArray(r.appliesTo)) errors.push(`${label}.appliesTo must be an array`);
        else
          r.appliesTo.forEach((a: unknown, j: number) => {
            if (!APPLIES_TO.includes(a as string) && !SPATIAL_APPLIES_TO.includes(a as string)) {
              errors.push(`${label}.appliesTo[${j}] must be one of ${[...APPLIES_TO, ...SPATIAL_APPLIES_TO].join(", ")} (got ${JSON.stringify(a)})`);
            }
          });
      }
      checkSpatialWord(label, r, errors);
    });

  if (raw.meterReadings !== undefined) checkMeterReadings("meterReadings", raw.meterReadings, errors, true);
  if (raw.notEquipment !== undefined) checkNotEquipment("notEquipment", raw.notEquipment, errors, true);
  if (raw.equipmentIdRules !== undefined) checkEquipmentIdRules(raw.equipmentIdRules, errors, true);
  if (raw.accounting !== undefined) checkIgnoredWords(raw.accounting, errors);
  return errors;
}

/** A dictionary's `accounting` holds only the confirmed ignored-word records `{ word, reason }` that
 * promotion keeps (the draft's other accounting is stripped): word = one lower-case word of letters, as
 * `account ignored-word` stores it; reason non-empty; no word twice. */
function checkIgnoredWords(a: unknown, errors: string[]): void {
  if (!isObj(a)) return void errors.push("accounting must be an object");
  checkKeys("accounting", a, ["ignoredWords"], errors);
  if (a.ignoredWords === undefined) return;
  if (!Array.isArray(a.ignoredWords)) return void errors.push("accounting.ignoredWords must be an array");
  const seen = new Set<string>();
  a.ignoredWords.forEach((r: unknown, i: number) => {
    const label = `accounting.ignoredWords[${i}]`;
    if (!isObj(r)) return void errors.push(`${label} must be an object`);
    checkKeys(label, r, ["word", "reason"], errors);
    if (typeof r.word !== "string" || !/^\p{L}+$/u.test(r.word) || r.word !== r.word.toLowerCase()) {
      errors.push(`${label}.word must be one lower-case word of letters (got ${JSON.stringify(r.word)})`);
    } else if (seen.has(r.word)) errors.push(`${label}.word "${r.word}" is recorded twice`);
    else seen.add(r.word);
    if (typeof r.reason !== "string" || r.reason.trim() === "") errors.push(`${label}.reason must be a non-empty string`);
  });
}

/** data/<building>/point-dictionary.json as a version-3 dictionary. One-line error when it is missing,
 * not schemaVersion 3, or invalid. */
export function loadPartsDictionary(buildingId: string): PartsDictionary {
  const p = dictionaryPath(buildingId);
  if (!fs.existsSync(p)) throw new Error(`${p}: point dictionary not found (expected schemaVersion 3)`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!isObj(raw) || raw.schemaVersion !== 3) throw new Error(`${p}: not a version-3 point dictionary (expected schemaVersion 3)`);
  const errors = validatePartsDictionary(raw);
  if (errors.length) throw new Error(`${p}: invalid point dictionary: ${errors.join("; ")}`);
  return raw as unknown as PartsDictionary;
}

// ---------------------------------------------------------------------------
// Write-time strict validation (every dictionary write and promotion runs this)
// ---------------------------------------------------------------------------

let brickTagSet: Set<string> | null = null;

/** Every tag of every class in the Brick classification index (loaded once per process). */
function brickTags(): Set<string> {
  if (brickTagSet) return brickTagSet;
  const idx = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "ontologies", "brick-classification-index.json"), "utf-8"));
  const set = new Set<string>();
  for (const c of Object.values<any>(idx.classes ?? {})) for (const t of c.tags ?? []) set.add(t);
  return (brickTagSet = set);
}

/** Every dictionary entry that carries evidence, with its path. The meterReadings section itself is
 * listed only for the entries inside it (its `readings`). */
function strictEntries(raw: Record<string, any>): Array<{ path: string; entry: Record<string, any> }> {
  const out: Array<{ path: string; entry: Record<string, any> }> = [];
  const table = (p: string, t: unknown): void => {
    if (isObj(t)) for (const [k, e] of Object.entries(t)) if (isObj(e)) out.push({ path: `${p}.${k}`, entry: e });
  };
  const list = (p: string, l: unknown): void => {
    if (Array.isArray(l)) l.forEach((e, i) => isObj(e) && out.push({ path: `${p}[${i}]`, entry: e }));
  };
  if (isObj(raw.tokens)) for (const [c, t] of Object.entries(raw.tokens)) table(`tokens.${c}`, t);
  for (const k of ["units", "overrides", "plantTokens", "plantOverrides"]) table(k, raw[k]);
  list("suffixes", raw.suffixes);
  list("words", raw.words);
  if (isObj(raw.meterReadings)) table("meterReadings.readings", raw.meterReadings.readings);
  if (isObj(raw.notEquipment)) out.push({ path: "notEquipment", entry: raw.notEquipment });
  list("equipmentIdRules", raw.equipmentIdRules);
  return out;
}

/** The checks a dictionary (schemaVersion 3) must pass when written or promoted: validatePartsDictionary,
 * plus per entry: evidence present; doc quotes found in the document; data rows real, with the right
 * description and (point entries) decided by this entry; human answers non-empty; tags are Brick tags,
 * at most one role tag. `requireTags` (drafts only): an entry with a meaning also carries a `tags`
 * array (an empty one is allowed). Errors name the entry path. `stats.v3RowsSkipped`: data rows of point
 * entries whose point the mapping files do not hold (or there are none), so "decided by this entry" was
 * not checked for them. */
export function validateStrict(dict: any, buildingId: string, opts: { requireTags?: boolean; stats?: { v3RowsSkipped: number }; inputsDir?: string; withEquipment?: boolean } = {}): string[] {
  const errors = validatePartsDictionary(dict);
  if (!isObj(dict)) return errors;

  // Point id -> the entries deciding it (decidingEntries), from the mapping files. null when there are
  // no mapping files or the structure is invalid (a bad pattern cannot be combined).
  const structuralOk = errors.length === 0;
  let deciders: Map<string, Set<string>> | null | undefined;
  const v3Deciders = (): Map<string, Set<string>> | null => {
    if (deciders !== undefined) return deciders;
    const inputs = structuralOk ? loadPointInputs(buildingId, opts.inputsDir, opts.withEquipment) : null;
    if (inputs === null) return (deciders = null);
    const parts = asPartsDictionary(dict);
    deciders = new Map();
    for (const input of inputs) {
      const { cs, combined } = combinePoint(parts, input);
      deciders.set(input.id, decidingEntries(cs, combined));
    }
    // a data row names the raw object name; the mapper may have renamed the point (BACnet)
    for (const [raw, id] of mappedRawIds(buildingId, opts.inputsDir)) if (!deciders.has(raw) && deciders.has(id)) deciders.set(raw, deciders.get(id)!);
    return deciders;
  };
  if (opts.stats) opts.stats.v3RowsSkipped = 0;
  const byId = new Map<string, DataPoint[]>();
  for (const p of loadDataPoints(buildingId)) byId.set(p.pointId, [...(byId.get(p.pointId) ?? []), p]);
  const tags = brickTags();
  // spatial word entries cite IFC spaces/storeys, not BMS points: read inputs/ifc-spatial.json once
  let ifc: { spaces: any[]; storeys: any[] } | null | undefined;
  const ifcSpatial = () => {
    if (ifc !== undefined) return ifc;
    const f = path.join(opts.inputsDir ?? path.join(dataRoot(), buildingId, "inputs"), "ifc-spatial.json");
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf-8"));
      return (ifc = { spaces: Array.isArray(j.spaces) ? j.spaces : [], storeys: Array.isArray(j.storeys) ? j.storeys : [] });
    } catch {
      return (ifc = null);
    }
  };

  for (const { path: p, entry } of strictEntries(dict)) {
    const spatialKind: string | undefined = Array.isArray(entry.appliesTo) ? entry.appliesTo.find((a: unknown) => SPATIAL_APPLIES_TO.includes(a as string)) : undefined;
    let ifcMissingReported = false;
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) errors.push(`${p}: missing evidence`);
    else
      entry.evidence.forEach((e: any, i: number) => {
        const ep = `${p}.evidence[${i}]`;
        if (!isObj(e)) return;
        if (e.kind === "doc" && typeof e.file === "string" && typeof e.quote === "string") {
          const status = quoteStatus(buildingId, e.file, e.quote);
          if (status !== "found") errors.push(`${ep}: doc quote status is "${status}" (file ${e.file})`);
        } else if (e.kind === "carried-over") {
          if (!isObj(e.classes) || Object.keys(e.classes).length === 0) errors.push(`${ep}: carried-over classes is empty`);
          if (!(typeof e.points === "number" && e.points > 0)) errors.push(`${ep}: carried-over points must be greater than 0`);
        } else if (e.kind === "human") {
          if (typeof e.answer !== "string" || e.answer.trim() === "") errors.push(`${ep}: human answer is empty`);
        } else if (e.kind === "data" && Array.isArray(e.rows)) {
          const rows = e.rows.filter(isObj);
          if (rows.length === 0) errors.push(`${ep}: data evidence has no rows`);
          if (rows.length > 0 && rows.every((r: any) => r.description === "")) errors.push(`${ep}: data descriptions are all empty`);
          rows.forEach((r: any, j: number) => {
            const rp = `${ep}.rows[${j}]`;
            if (spatialKind) {
              if (spatialKind === "useGroup") return;
              const s = ifcSpatial();
              if (!s) {
                if (!ifcMissingReported) errors.push(`${p}: spatial evidence needs inputs/ifc-spatial.json`);
                ifcMissingReported = true;
                return;
              }
              if (spatialKind === "storeyName") {
                const st = s.storeys.find((x: any) => x && x.name === r.pointId);
                if (!st) errors.push(`${rp}: "${r.pointId}" is not an IFC space/storey of the building`);
                else if (r.description !== st.name && r.description !== "") errors.push(`${rp}: name differs from the IFC for "${r.pointId}"`);
              } else {
                const field = spatialKind === "roomName" ? "name" : "category";
                const sps = s.spaces.filter((x: any) => x && x.number === r.pointId);
                if (sps.length === 0) errors.push(`${rp}: "${r.pointId}" is not an IFC space/storey of the building`);
                else if (!sps.some((x: any) => x[field] === r.description)) errors.push(`${rp}: name differs from the IFC for "${r.pointId}"`);
              }
              return;
            }
            const candidates = byId.get(r.pointId);
            if (!candidates) return void errors.push(`${rp}: point "${r.pointId}" is not in the building's data`);
            const point = candidates.find((c) => c.description === r.description);
            if (!point) return void errors.push(`${rp}: description differs from the data for "${r.pointId}"`);
            // the classifier's combiner decides; only point entries, and only with the mapping files
            if (!V3_POINT_ENTRY.test(p)) return;
            const by = v3Deciders()?.get(r.pointId);
            if (by === undefined) {
              if (opts.stats) opts.stats.v3RowsSkipped++;
              return;
            }
            if (!by.has(p)) errors.push(`${rp}: "${r.pointId}" is not decided by this entry (decided by: ${[...by].join(", ") || "no entry"})`);
          });
        }
      });

    if (opts.requireTags && typeof entry.meaning === "string" && !Array.isArray(entry.tags)) errors.push(`${p}: missing tags (a draft entry with a meaning needs a tags array)`);
    if (Array.isArray(entry.tags)) {
      for (const t of entry.tags) if (typeof t === "string" && !tags.has(t)) errors.push(`${p}: tag "${t}" is not a Brick tag`);
      const roles = entry.tags.filter((t: unknown) => typeof t === "string" && ROLE_TAGS.includes(t));
      if (roles.length > 1) errors.push(`${p}: more than one role tag (${roles.join(", ")})`);
    }
  }
  return errors;
}
