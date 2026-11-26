// tools/lib/zone-rooms.ts
// data/{b}/zone-rooms.json: a building's confirmed zone-to-room knowledge (the id rule, the second sources'
// rows, the check flags, the human decisions). Shape, validation, the rule, the name tolerance and the two
// fixed check flags (counts >= 80%, independent) live here; the matcher and the write tool both use this.

import * as fs from "fs";
import * as path from "path";
import { dataRoot } from "./building-profile";
import type { Evidence } from "./point-dictionary";

export interface Template { pattern: string; flags?: string; room: string; note: string; evidence: Evidence[] }
export interface Confirmation { by: string; date: string; note?: string }
export interface Rule { kind: "idTemplates"; templates: Template[]; confirmed?: Confirmation }
export type SourceKind = "zoneMatrix" | "roomsOverview" | "schematicHeaders" | "feeds";
export interface SourceRow { zoneId: string; roomNumber?: string; level?: number; name?: string; useGroup?: string; cite: string }
export interface Source { id: string; kind: SourceKind; file: string; columns?: Record<string, string>; rows: SourceRow[] }
export type CheckKind = "number" | "floor" | "name" | "useGroup" | "feeds";
export interface CheckSetting {
  kind: CheckKind;
  source: string;
  counts: boolean;
  independent: boolean;
  agreement?: { pass: number; fail: number };
  override?: { counts?: boolean; independent?: boolean; reason: string; by: string; date: string };
}
export type CheckResult = { result: "pass" | "fail" | "unknown"; detail?: string };
export interface Decision {
  action: "accept" | "room" | "create" | "unlinked";
  roomId?: string;
  room?: { id: string; name: string; level: number; cite: string[] };
  reason: string;
  by: string;
  date: string;
  carriedOver?: string;
  answered: { proposedRoom: string | null; checks: Record<string, "pass" | "fail" | "unknown"> };
}
export interface ZoneRooms {
  schemaVersion: 1;
  rule: Rule;
  sources: Source[];
  checks: CheckSetting[];
  decisions: Record<string, Decision>;
}

const SOURCE_KINDS = ["zoneMatrix", "roomsOverview", "schematicHeaders", "feeds"];
const CHECK_KINDS = ["number", "floor", "name", "useGroup", "feeds"];
const ACTIONS = ["accept", "room", "create", "unlinked"];

// ---------------------------------------------------------------------------
// Paths / loading
// ---------------------------------------------------------------------------

export function zoneRoomsPath(buildingId: string): string {
  return path.join(dataRoot(), buildingId, "zone-rooms.json");
}

export function loadZoneRooms(buildingId: string): ZoneRooms | null {
  const p = zoneRoomsPath(buildingId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")) as ZoneRooms;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

/** Error messages with their paths; [] when the file is valid. `ifcRoomNumbers`: a created room may not reuse one. */
export function validateZoneRooms(raw: unknown, ifcRoomNumbers?: Set<string>): string[] {
  const errors: string[] = [];
  if (!isObj(raw)) return ["zone-rooms: not a JSON object"];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion: must be 1");

  const rule = raw.rule;
  if (!isObj(rule)) errors.push("rule: missing");
  else {
    if (rule.kind !== "idTemplates") errors.push('rule.kind: must be "idTemplates"');
    if (!Array.isArray(rule.templates)) errors.push("rule.templates: must be an array");
    else
      rule.templates.forEach((t: any, i: number) => {
        const at = `rule.templates[${i}]`;
        if (!isObj(t)) return void errors.push(`${at}: must be an object`);
        if (typeof t.pattern !== "string") errors.push(`${at}.pattern: missing`);
        else {
          try {
            new RegExp(t.pattern, typeof t.flags === "string" ? t.flags : undefined);
          } catch (e) {
            errors.push(`${at}.pattern: does not compile (${(e as Error).message})`);
          }
        }
        if (t.flags !== undefined && typeof t.flags !== "string") errors.push(`${at}.flags: must be a string`);
        if (!nonEmpty(t.room)) errors.push(`${at}.room: must be a non-empty string`);
        if (!nonEmpty(t.note)) errors.push(`${at}.note: missing`);
        if (!Array.isArray(t.evidence)) errors.push(`${at}.evidence: must be an array`);
      });
  }

  const sourceIds = new Set<string>();
  if (!Array.isArray(raw.sources)) errors.push("sources: must be an array");
  else
    raw.sources.forEach((s: any, i: number) => {
      const at = `sources[${i}]`;
      if (!isObj(s)) return void errors.push(`${at}: must be an object`);
      if (!nonEmpty(s.id)) errors.push(`${at}.id: missing`);
      else if (sourceIds.has(s.id)) errors.push(`${at}.id: duplicate "${s.id}"`);
      else sourceIds.add(s.id);
      if (!SOURCE_KINDS.includes(s.kind)) errors.push(`${at}.kind: must be one of ${SOURCE_KINDS.join(", ")}`);
      if (typeof s.file !== "string") errors.push(`${at}.file: missing`);
      if (!Array.isArray(s.rows)) errors.push(`${at}.rows: must be an array`);
      else
        s.rows.forEach((r: any, j: number) => {
          const rat = `${at}.rows[${j}]`;
          if (!isObj(r)) return void errors.push(`${rat}: must be an object`);
          if (!nonEmpty(r.zoneId)) errors.push(`${rat}.zoneId: missing`);
          if (!nonEmpty(r.cite)) errors.push(`${rat}.cite: missing`);
          if (r.level !== undefined && !Number.isInteger(r.level)) errors.push(`${rat}.level: must be an integer`);
        });
    });

  if (!Array.isArray(raw.checks)) errors.push("checks: must be an array");
  else
    raw.checks.forEach((c: any, i: number) => {
      const at = `checks[${i}]`;
      if (!isObj(c)) return void errors.push(`${at}: must be an object`);
      if (!CHECK_KINDS.includes(c.kind)) errors.push(`${at}.kind: must be one of ${CHECK_KINDS.join(", ")}`);
      if (typeof c.source !== "string" || !sourceIds.has(c.source)) errors.push(`${at}.source: "${c.source}" is not a source id`);
      if (typeof c.counts !== "boolean") errors.push(`${at}.counts: must be a boolean`);
      if (typeof c.independent !== "boolean") errors.push(`${at}.independent: must be a boolean`);
      if (c.override !== undefined) {
        const o = c.override;
        if (!isObj(o) || !nonEmpty(o.reason) || !nonEmpty(o.by) || !nonEmpty(o.date)) errors.push(`${at}.override: needs reason, by and date`);
      }
    });

  if (!isObj(raw.decisions)) errors.push("decisions: must be an object");
  else
    for (const [zone, d] of Object.entries<any>(raw.decisions)) {
      const at = `decisions.${zone}`;
      if (!isObj(d)) {
        errors.push(`${at}: must be an object`);
        continue;
      }
      if (!ACTIONS.includes(d.action)) errors.push(`${at}.action: must be one of ${ACTIONS.join(", ")}`);
      for (const k of ["reason", "by", "date"]) if (!nonEmpty(d[k])) errors.push(`${at}.${k}: missing`);
      if (!isObj(d.answered) || !("proposedRoom" in d.answered) || !isObj(d.answered.checks)) errors.push(`${at}.answered: needs proposedRoom and checks`);
      if (d.action === "room" && !nonEmpty(d.roomId)) errors.push(`${at}.roomId: required for action room`);
      if (d.action === "create") {
        const r = d.room;
        if (!isObj(r)) errors.push(`${at}.room: required for action create`);
        else {
          if (!nonEmpty(r.id)) errors.push(`${at}.room.id: missing`);
          else if (ifcRoomNumbers?.has(r.id)) errors.push(`${at}.room.id: "${r.id}" is an IFC room number (a created room must not reuse one)`);
          if (!nonEmpty(r.name)) errors.push(`${at}.room.name: missing`);
          if (!Number.isInteger(r.level)) errors.push(`${at}.room.level: must be an integer`);
          if (!Array.isArray(r.cite) || r.cite.length < 1) errors.push(`${at}.room.cite: needs at least one citation`);
        }
        if (d.roomId !== undefined) errors.push(`${at}.roomId: not allowed for action create`);
      }
      if (d.action === "unlinked" && (d.roomId !== undefined || d.room !== undefined)) errors.push(`${at}: unlinked takes no roomId or room`);
    }
  return errors;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** The first template that matches the whole zone id and whose room is one of `roomNumbers`. */
export function proposeRoom(zoneId: string, rule: Rule, roomNumbers: Set<string>): { roomId: string | null; template: number | null } {
  for (let i = 0; i < rule.templates.length; i++) {
    const t = rule.templates[i];
    const re = new RegExp(t.pattern, t.flags);
    const m = re.exec(zoneId);
    // the template must span the whole zone id (an unanchored pattern would leave the rest of the id in the room)
    if (!m || m[0] !== zoneId) continue;
    re.lastIndex = 0;
    const room = zoneId.replace(re, t.room);
    if (roomNumbers.has(room)) return { roomId: room, template: i };
  }
  return { roomId: null, template: null };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Equal, one contains the other, or edit distance <= 2, after lower-casing and dropping non-letters/digits. */
export function namesAgree(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (x === "" || y === "") return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return editDistance(x, y) <= 2;
}

export function checkKey(c: { kind: CheckKind; source: string }): string {
  return `${c.kind}:${c.source}`;
}

/** counts: pass/(pass+fail) >= 0.8. independent: name/useGroup/feeds always; number/floor only when no
 * considered row's value occurs verbatim in its zone id (rows without the value are ignored). */
export function computeFlags(kind: CheckKind, rows: SourceRow[], results: CheckResult[]): { counts: boolean; independent: boolean; agreement: { pass: number; fail: number } } {
  const pass = results.filter((r) => r.result === "pass").length;
  const fail = results.filter((r) => r.result === "fail").length;
  const counts = pass + fail > 0 && pass * 5 >= 4 * (pass + fail); // pass/(pass+fail) >= 80%, integer math
  let independent = true;
  if (kind === "number" || kind === "floor") {
    let considered = 0;
    let occurs = 0;
    for (const r of rows) {
      const v = kind === "number" ? r.roomNumber : r.level;
      if (v === undefined || v === null) continue;
      considered++;
      if (r.zoneId.includes(String(v))) occurs++;
    }
    independent = considered > 0 && occurs === 0;
  }
  return { counts, independent, agreement: { pass, fail } };
}

export function effectiveFlags(c: CheckSetting): { counts: boolean; independent: boolean } {
  return { counts: c.override?.counts ?? c.counts, independent: c.override?.independent ?? c.independent };
}
