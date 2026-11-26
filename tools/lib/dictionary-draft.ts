// tools/lib/dictionary-draft.ts
//
// The draft file data/{b}/point-dictionary.draft.json: the dictionary's shape plus, per entry, a
// review `status` (and optional `review` note), the document accounting, and the mode it was
// started in. write-point-dictionary-entry.ts is the only writer; promote strips the review fields
// and writes point-dictionary.json.

import * as fs from "fs";
import * as path from "path";
import { dataRoot } from "./building-profile";

export type DraftStatus = "proposed" | "confirmed" | "changed";

export interface LegendRecord {
  file: string;
  row: number;
  text: string;
  disposition: string;
  note?: string;
  status: DraftStatus;
}

export interface RemovedRecord {
  path: string;
  reason: string;
  status: DraftStatus;
}

/** A description word decided to carry no part (word discovery, one shape). */
export interface IgnoredWordRecord {
  word: string;
  reason: string;
  status: DraftStatus;
}

export interface Draft {
  /** an old-shape draft only (not supported): context or rule */
  shape?: "context" | "rule";
  mode: "full" | "gaps";
  accounting: { legend: LegendRecord[]; removed: RemovedRecord[]; ignoredWords?: IgnoredWordRecord[] };
  [section: string]: any;
}

/** Sections whose value is an array of entries. */
export const ARRAY_SECTIONS = ["suffixes", "words", "descriptionRules", "suffixRules", "equipmentIdRules"];

export function draftPath(buildingId: string): string {
  return path.join(dataRoot(), buildingId, "point-dictionary.draft.json");
}

export function readDraft(buildingId: string): Draft {
  const p = draftPath(buildingId);
  if (!fs.existsSync(p)) throw new Error(`no draft for ${buildingId}: ${p} (run init first)`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function writeDraft(buildingId: string, d: Draft): void {
  fs.writeFileSync(draftPath(buildingId), JSON.stringify(d, null, 2) + "\n", "utf-8");
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "zone.tokens.TR" / "zone.suffixes[0]" -> ["zone","tokens","TR"] / ["zone","suffixes",0]. */
function segments(p: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const m of p.matchAll(/([^.\[\]]+)|\[(\d+)\]/g)) out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return out;
}

/** The value at a path, or undefined. */
export function getAt(d: any, p: string): any {
  let v = d;
  for (const s of segments(p)) {
    if (v === null || typeof v !== "object") return undefined;
    if (typeof s === "number" ? !Array.isArray(v) : Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, s)) return undefined;
    v = v[s as any];
  }
  return v;
}

/** Writes `entry` at `path`, creating missing parents, and returns the path actually written.
 * - path ending in an index (suffixes[2]): replaces that rule (the index may equal the length: append);
 * - path ending in an array section (suffixes) with insertIndex: inserts at that index;
 * - path ending in an array section without insertIndex: appends;
 * - any other path: sets that key. */
export function setAt(d: any, p: string, entry: any, insertIndex?: number): string {
  const segs = segments(p);
  if (segs.length === 0) throw new Error("empty path");
  const last = segs[segs.length - 1];
  const indexed = typeof last === "number";
  const key = (indexed ? segs[segs.length - 2] : last) as string;
  const containerSegs = segs.slice(0, indexed ? -2 : -1) as string[];
  if (typeof key !== "string" || containerSegs.some((s) => typeof s !== "string")) throw new Error(`unsupported path ${p}`);
  let parent: any = d;
  for (const s of containerSegs) {
    if (parent[s] === undefined) parent[s] = {};
    parent = parent[s];
    if (!isObj(parent)) throw new Error(`${p}: "${s}" is not an object`);
  }
  const base = [...containerSegs, key].join(".");
  if (indexed || ARRAY_SECTIONS.includes(key)) {
    if (parent[key] === undefined) parent[key] = [];
    const arr = parent[key];
    if (!Array.isArray(arr)) throw new Error(`${base} is not an array`);
    if (indexed) {
      if (insertIndex !== undefined) throw new Error("--insert takes a path without an index (e.g. zone.suffixes)");
      if ((last as number) > arr.length) throw new Error(`${base}[${last}] is out of range (the array has ${arr.length} entries)`);
      arr[last as number] = entry;
      return `${base}[${last}]`;
    }
    const at = insertIndex ?? arr.length;
    if (!Number.isInteger(at) || at < 0 || at > arr.length) throw new Error(`--insert ${insertIndex} is out of range for ${base} (0..${arr.length})`);
    arr.splice(at, 0, entry);
    return `${base}[${at}]`;
  }
  if (insertIndex !== undefined) throw new Error(`--insert only applies to an array section (${ARRAY_SECTIONS.join(", ")})`);
  parent[key] = entry;
  return base;
}

/** Every dictionary entry that carries a review status, with its path: token/override/rule entries,
 * the meterReadings section and its readings, and notEquipment. The one shape (schemaVersion 3):
 * tokens.<ctx>.<tok>, suffixes[i], words[i], units.<u>, overrides.<id>, plantTokens.<t>,
 * plantOverrides.<id>, meterReadings (and .readings.<k>), notEquipment, equipmentIdRules[i]. */
export function draftEntries(d: any): Array<{ path: string; entry: Record<string, any> }> {
  const out: Array<{ path: string; entry: Record<string, any> }> = [];
  const table = (p: string, t: unknown): void => {
    if (isObj(t)) for (const [k, e] of Object.entries(t)) if (isObj(e)) out.push({ path: `${p}.${k}`, entry: e });
  };
  const list = (p: string, l: unknown): void => {
    if (Array.isArray(l)) l.forEach((e, i) => isObj(e) && out.push({ path: `${p}[${i}]`, entry: e }));
  };
  if (d?.schemaVersion === 3) {
    if (isObj(d.tokens)) for (const [c, t] of Object.entries(d.tokens)) table(`tokens.${c}`, t);
    list("suffixes", d.suffixes);
    list("words", d.words);
    for (const k of ["units", "overrides", "plantTokens", "plantOverrides"]) table(k, d[k]);
    if (isObj(d.meterReadings)) {
      out.push({ path: "meterReadings", entry: d.meterReadings });
      table("meterReadings.readings", d.meterReadings.readings);
    }
    if (isObj(d.notEquipment)) out.push({ path: "notEquipment", entry: d.notEquipment });
    list("equipmentIdRules", d.equipmentIdRules);
    return out;
  }
  for (const ctx of ["zone", "plant"]) {
    const c = d?.[ctx];
    if (!isObj(c)) continue;
    table(`${ctx}.tokens`, c.tokens);
    table(`${ctx}.overrides`, c.overrides);
    list(`${ctx}.suffixes`, c.suffixes);
    if (isObj(c.meterReadings)) {
      out.push({ path: `${ctx}.meterReadings`, entry: c.meterReadings });
      table(`${ctx}.meterReadings.readings`, c.meterReadings.readings);
    }
    if (isObj(c.notEquipment)) out.push({ path: `${ctx}.notEquipment`, entry: c.notEquipment });
  }
  table("overrides", d?.overrides);
  list("descriptionRules", d?.descriptionRules);
  list("suffixRules", d?.suffixRules);
  list("equipmentIdRules", d?.equipmentIdRules);
  return out;
}

/** Paths still open: entries (a missing status counts as proposed) and accounting records with
 * status "proposed". */
export function openItems(d: Draft): string[] {
  const open: string[] = [];
  for (const { path: p, entry } of draftEntries(d)) {
    if (entry.status === undefined || entry.status === "proposed") open.push(p);
  }
  (d.accounting?.legend ?? []).forEach((r, i) => r.status === "proposed" && open.push(`accounting.legend[${i}]`));
  (d.accounting?.removed ?? []).forEach((r, i) => r.status === "proposed" && open.push(`accounting.removed[${i}]`));
  (d.accounting?.ignoredWords ?? []).forEach((r, i) => r.status === "proposed" && open.push(`accounting.ignoredWords[${i}]`));
  return open;
}

/** The plain dictionary: a copy without status/review/shape/mode and with only `accounting.ignoredWords`
 * (as { word, reason }, omitted when there are none) of the accounting; an entry's remaining
 * `source` becomes pre-existing evidence when it has none, and is dropped. Does not modify its input.
 * The one shape keeps its schemaVersion 3 (draftEntries reaches every entry of it, including the
 * meterReadings readings and notEquipment). */
export function stripDraft(d: any): any {
  const c = JSON.parse(JSON.stringify(d));
  for (const { entry } of draftEntries(c)) {
    delete entry.status;
    delete entry.review;
    if (entry.source !== undefined) {
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        if (typeof entry.source === "string" && entry.source !== "") entry.evidence = [{ kind: "pre-existing", source: entry.source }];
      }
      delete entry.source;
    }
  }
  delete c.shape;
  delete c.mode;
  // the confirmed ignored-word records stay in the dictionary as { word, reason } (init seeds the next
  // draft from them); the rest of the draft's accounting is draft-only
  const ignored = (c.accounting?.ignoredWords ?? []).map((r: any) => ({ word: r.word, reason: r.reason }));
  delete c.accounting;
  if (ignored.length > 0) c.accounting = { ignoredWords: ignored };
  return c;
}
