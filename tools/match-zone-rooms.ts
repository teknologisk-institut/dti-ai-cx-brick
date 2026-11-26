// tools/match-zone-rooms.ts
// The zone-to-room step: reads the IFC extract (inputs/ifc-spatial.json), the zone list
// (inputs/zone-point-mapping.json zones[].zoneId), the building's confirmed zone-rooms.json and its
// dictionary; applies space/storey exclusions and storey numbering (lib/room-class.ts), the rule, the
// checks against the second sources and the human decisions; writes the zone-centred
// inputs/spatial-hierarchy.json.
//
// Usage: npx ts-node tools/match-zone-rooms.ts <b> [--review] [--force]
//   --review  print the review (contradictions first) and write nothing
//   --force   overwrite a spatial-hierarchy.json that already holds classify-all output

import * as fs from "fs";
import * as path from "path";
import { dataRoot } from "./lib/building-profile";
import { loadPartsDictionary } from "./lib/point-dictionary";
import type { PartsDictionary } from "./lib/point-dictionary";
import { guardAgainstClassifiedOverwrite } from "./lib/rerun-guard";
import { checkRecClasses, classWithin, isExcluded, levelId, numberStoreys, roomClass, storeyClass, useGroupClasses } from "./lib/room-class";
import type { BrickIndex } from "./lib/room-class";
import { checkKey, computeFlags, effectiveFlags, loadZoneRooms, namesAgree, proposeRoom, validateZoneRooms } from "./lib/zone-rooms";
import type { CheckResult, CheckSetting, Decision, Source, ZoneRooms } from "./lib/zone-rooms";

export interface IfcSpatial {
  meta: { generatedBy: string; architectureIfc: string; installationIfcs: string[] };
  building: { name: string; longName: string; guid: string };
  storeys: Array<{ guid: string; name: string; elevation_mm: number | null }>;
  spaces: Array<{ number: string | null; name: string | null; storeyGuid: string | null; category: string | null }>;
  roomPlants?: Record<string, string[]>;
}
export type ZoneStatus = "matched" | "created" | "unlinked";
export interface RoomOut { id: string; name: string | null; floorId: string | null; source: "ifc" | "documents" }
export interface FloorOut { id: string; name: string; elevation_mm: number | null; levelNumber: number; levelType: string }
export interface ZoneOut {
  id: string;
  status: ZoneStatus;
  roomIds: string[];
  floorId: string | null;
  name: string | null;
  useGroup: string | null;
  evidence: { template: number | null; checks: Record<string, string>; decision?: string };
}
export interface SpatialOut {
  meta: {
    generatedBy: "match-zone-rooms.ts";
    generatedAt: string;
    zoneRooms: string | null;
    totalFloors: number;
    totalRooms: number;
    totalZones: number;
    zonesByStatus: Record<ZoneStatus, number>;
    roomsBySource: { ifc: number; documents: number };
  };
  building: { name: string; longName: string };
  floors: FloorOut[];
  rooms: RoomOut[];
  zones: ZoneOut[];
}
export interface ZoneItem { zoneId: string; proposedRoom: string | null; checks: Record<string, string> }
export interface Review {
  ruleSummary: { hits: number; misses: string[] };
  checkSummary: Array<CheckSetting & { computed: { counts: boolean; independent: boolean; agreement: { pass: number; fail: number } } }>;
  disagreements: ZoneItem[];
  noRoom: ZoneItem[];
  ruleOnly: string[];
  notInZoneList: Array<{ zoneId: string; source: string }>;
  stale: Array<{ zoneId: string; why: string }>;
  uncoveredNames: { room: string[]; storey: string[]; useGroup: string[] };
  issues: string[];
}
export interface Feeds { plantFeedsZone: Array<{ plantId: string; zoneIds: string[] }> }

const NO_RULE = "no confirmed zone-room rule";

type Rec = { name: string | null; floorId: string | null; levelNumber: number | null };
interface Ctx { records: Map<string, Rec[]>; dict: PartsDictionary; index: BrickIndex; feeds: Feeds | null; roomPlants: Record<string, string[]> }

const pass = (): CheckResult => ({ result: "pass" });
const unknown = (detail: string): CheckResult => ({ result: "unknown", detail });
const fail = (detail: string): CheckResult => ({ result: "fail", detail });
const show = (r: CheckResult): string => (r.result === "pass" ? "pass" : `${r.result}: ${r.detail ?? ""}`);
const distinct = (xs: string[]): string[] => [...new Set(xs)].sort();

/** One check for one zone and its proposed room. */
function runCheck(c: CheckSetting, src: Source, zoneId: string, roomId: string, ctx: Ctx): CheckResult {
  const recs = ctx.records.get(roomId) ?? [];
  const row = src.rows.find((r) => r.zoneId === zoneId);
  switch (c.kind) {
    case "number":
      if (!row?.roomNumber) return unknown(`no room number in ${src.id}`);
      return row.roomNumber === roomId ? pass() : fail(`${src.id} '${row.roomNumber}' vs proposed '${roomId}'`);
    case "floor": {
      if (row?.level == null) return unknown(`no level in ${src.id}`);
      const levels = recs.map((r) => r.levelNumber).filter((n): n is number => n != null);
      if (levels.length === 0) return unknown("the room has no storey level");
      return levels.includes(row.level) ? pass() : fail(`${src.id} level ${row.level} vs IFC level ${distinct(levels.map(String)).join("/")}`);
    }
    case "name": {
      if (!row?.name) return unknown(`no name in ${src.id}`);
      const names = recs.map((r) => r.name).filter((n): n is string => !!n && n.trim() !== "");
      if (names.length === 0) return unknown("the IFC room has no name");
      return names.some((n) => namesAgree(n, row.name as string)) ? pass() : fail(`IFC '${distinct(names).join("' / '")}' vs ${src.id} '${row.name}'`);
    }
    case "useGroup": {
      if (!row?.useGroup) return unknown(`no use group in ${src.id}`);
      const ug = useGroupClasses(row.useGroup, ctx.dict);
      if (!ug) return unknown(`no use-group word for '${row.useGroup}'`);
      const classes = recs.map((r) => roomClass(r.name, ctx.dict).recClass).filter((cls) => cls !== "rec:Room");
      if (classes.length === 0) return unknown("the room class is only rec:Room");
      return classes.some((cls) => classWithin(cls, ug.classes, ctx.index))
        ? pass()
        : fail(`room class ${distinct(classes).join("/")} not in use group '${row.useGroup}' (${ug.classes.join(", ")})`);
    }
    case "feeds": {
      if (!ctx.feeds) return unknown("no feeds data (building-connections.json)");
      const zonePlants = ctx.feeds.plantFeedsZone.filter((f) => (f.zoneIds ?? []).includes(zoneId)).map((f) => f.plantId);
      const roomPlants = ctx.roomPlants[roomId] ?? [];
      if (zonePlants.length === 0) return unknown("no plant feeds the zone");
      if (roomPlants.length === 0) return unknown("no terminal of a known plant in the room");
      return zonePlants.some((p) => roomPlants.includes(p)) ? pass() : fail(`zone fed by ${distinct(zonePlants).join("/")} vs room served by ${distinct(roomPlants).join("/")}`);
    }
  }
}

/** Why a decision no longer answers the current proposal and check results; null when it still does. */
function staleWhy(d: Decision, proposed: string | null, results: Record<string, CheckResult>): string | null {
  if ((d.answered.proposedRoom ?? null) !== proposed) return `proposal changed: answered ${d.answered.proposedRoom ?? "none"}, now ${proposed ?? "none"}`;
  const keys = distinct([...Object.keys(results), ...Object.keys(d.answered.checks)]);
  const diffs = keys.filter((k) => results[k]?.result !== d.answered.checks[k]);
  if (diffs.length) return `check results changed: ${diffs.map((k) => `${k} ${d.answered.checks[k] ?? "-"} -> ${results[k]?.result ?? "-"}`).join(", ")}`;
  return null;
}

function decisionText(d: Decision): string {
  const what = d.action === "room" ? `room ${d.roomId}` : d.action === "create" ? `create ${d.room?.id}` : d.action;
  return `${what} (${d.by}, ${d.date}${d.carriedOver ? `, carried over: ${d.carriedOver}` : ""}): ${d.reason}`;
}

export function buildSpatial(input: {
  ifc: IfcSpatial;
  zoneIds: string[];
  zr: ZoneRooms | null;
  dict: PartsDictionary;
  index: BrickIndex;
  feeds: Feeds | null;
}): { spatial: SpatialOut; review: Review } {
  const { ifc, zoneIds, zr, dict, index, feeds } = input;
  const issues: string[] = [...checkRecClasses(dict, index)];

  // --- floors and rooms ---
  const numbered = numberStoreys(ifc.storeys, dict);
  issues.push(...numbered.issues);
  const floorByGuid = new Map(numbered.floors.map((f) => [f.guid, f]));
  const excludedStoreys = new Set(ifc.storeys.filter((s) => isExcluded("storeyName", s.name, dict)).map((s) => s.guid));
  const floors: FloorOut[] = numbered.floors.map((f) => ({ id: f.id, name: f.name, elevation_mm: f.elevation_mm, levelNumber: f.levelNumber, levelType: f.levelType }));
  const floorIds = new Set(floors.map((f) => f.id));

  const rooms: RoomOut[] = [];
  const records = new Map<string, Rec[]>();
  for (const s of ifc.spaces) {
    if (!s.number) {
      issues.push(`IFC space without a number (name '${s.name ?? ""}') skipped`);
      continue;
    }
    if (isExcluded("spaceCategory", s.category, dict)) continue;
    const floor = s.storeyGuid ? floorByGuid.get(s.storeyGuid) : undefined;
    if (!floor) issues.push(`space ${s.number} (${s.name ?? ""}): storey ${s.storeyGuid && excludedStoreys.has(s.storeyGuid) ? "excluded" : "not found"}; floorId null`);
    rooms.push({ id: s.number, name: s.name, floorId: floor?.id ?? null, source: "ifc" });
    const list = records.get(s.number) ?? [];
    list.push({ name: s.name, floorId: floor?.id ?? null, levelNumber: floor?.levelNumber ?? null });
    records.set(s.number, list);
  }
  const roomNumbers = new Set(records.keys());

  // --- zones ---
  const sources = zr?.sources ?? [];
  const first = <K extends "name" | "useGroup" | "level">(zoneId: string, key: K) => {
    for (const s of sources) {
      const v = s.rows.find((r) => r.zoneId === zoneId && r[key] != null && r[key] !== "")?.[key];
      if (v != null) return v;
    }
    return null;
  };
  const checks: Array<{ setting: CheckSetting; src: Source }> = [];
  for (const c of zr?.checks ?? []) {
    const src = sources.find((s) => s.id === c.source);
    if (!src) issues.push(`check ${checkKey(c)}: no source "${c.source}"; skipped`);
    else if (c.kind === "feeds" && src.kind !== "feeds") issues.push(`check ${checkKey(c)}: source "${src.id}" is not a feeds source; skipped`);
    else checks.push({ setting: c, src });
  }
  if (!zr) issues.push(`warning: no zone-rooms.json: ${NO_RULE}; every zone is unlinked`);

  const ctx: Ctx = { records, dict, index, feeds, roomPlants: ifc.roomPlants ?? {} };
  const resultsByCheck = new Map<string, CheckResult[]>();
  const zoneSet = new Set(zoneIds);
  const review: Review = {
    ruleSummary: { hits: 0, misses: [] }, checkSummary: [], disagreements: [], noRoom: [], ruleOnly: [],
    notInZoneList: [], stale: [], uncoveredNames: { room: [], storey: [], useGroup: [] }, issues,
  };
  const createdRooms: RoomOut[] = [];
  const zones: ZoneOut[] = [];

  for (const zoneId of zoneIds) {
    const level = first(zoneId, "level") as number | null;
    const sourceFloor = level != null && floorIds.has(levelId(level)) ? levelId(level) : null;
    const zone: ZoneOut = {
      id: zoneId, status: "unlinked", roomIds: [], floorId: sourceFloor,
      name: first(zoneId, "name") as string | null, useGroup: first(zoneId, "useGroup") as string | null,
      evidence: { template: null, checks: {} },
    };
    zones.push(zone);
    if (!zr) {
      zone.evidence.decision = `unlinked: ${NO_RULE}`;
      continue;
    }

    const { roomId: proposed, template } = proposeRoom(zoneId, zr.rule, roomNumbers);
    zone.evidence.template = template;
    const results: Record<string, CheckResult> = {};
    if (proposed) {
      review.ruleSummary.hits++;
      for (const { setting, src } of checks) {
        const r = runCheck(setting, src, zoneId, proposed, ctx);
        const key = checkKey(setting);
        results[key] = r;
        zone.evidence.checks[key] = show(r);
        resultsByCheck.set(key, [...(resultsByCheck.get(key) ?? []), r]);
      }
    } else review.ruleSummary.misses.push(zoneId);
    const item: ZoneItem = { zoneId, proposedRoom: proposed, checks: zone.evidence.checks };
    // the room's storey; when that is excluded or missing, the level a source row gives (as for unlinked zones)
    const roomFloor = (id: string) => records.get(id)?.[0]?.floorId ?? sourceFloor;

    const decision: Decision | undefined = zr.decisions[zoneId];
    const why = !decision
      ? null
      : decision.action === "create" && decision.room && roomNumbers.has(decision.room.id)
        ? `created room ${decision.room.id} now exists in the IFC`
        : staleWhy(decision, proposed, results);
    if (why) {
      // never decided silently: the zone stays unlinked until the human answers again
      review.stale.push({ zoneId, why });
      zone.evidence.decision = `stale: ${why} — re-ask`;
      continue;
    }
    if (decision) {
      zone.evidence.decision = decisionText(decision);
      if (decision.action === "create" && decision.room) {
        const fid = levelId(decision.room.level);
        if (!floorIds.has(fid)) issues.push(`created room ${decision.room.id} (zone ${zoneId}): no floor ${fid}; floorId null`);
        const floorId = floorIds.has(fid) ? fid : null;
        if (!createdRooms.some((r) => r.id === decision.room!.id)) createdRooms.push({ id: decision.room.id, name: decision.room.name, floorId, source: "documents" });
        Object.assign(zone, { status: "created", roomIds: [decision.room.id], floorId });
      } else if (decision.action === "accept" || decision.action === "room") {
        const target = decision.action === "accept" ? proposed : decision.roomId ?? null;
        if (target && roomNumbers.has(target)) Object.assign(zone, { status: "matched", roomIds: [target], floorId: roomFloor(target) });
        else issues.push(`decision ${decision.action} for zone ${zoneId}: room ${target ?? "(none)"} is not an IFC room; zone left unlinked`);
      }
      continue;
    }

    const failed = checks.filter(({ setting }) => results[checkKey(setting)]?.result === "fail");
    if (!proposed) {
      review.noRoom.push(item);
      zone.evidence.decision = "open: no room — see --review";
    } else if (failed.some(({ setting }) => effectiveFlags(setting).counts)) {
      review.disagreements.push(item);
      zone.evidence.decision = "open: disagreement — see --review";
    } else {
      Object.assign(zone, { status: "matched", roomIds: [proposed], floorId: roomFloor(proposed) });
      const independentPass = checks.some(({ setting }) => effectiveFlags(setting).independent && results[checkKey(setting)]?.result === "pass");
      if (failed.length === 0 && !independentPass) review.ruleOnly.push(zoneId);
    }
  }

  // --- review: decisions for zones not in the list, documents' zones not in the list, check summary, names ---
  for (const z of Object.keys(zr?.decisions ?? {})) if (!zoneSet.has(z)) review.stale.push({ zoneId: z, why: "not in the zone list" });
  for (const s of sources) {
    for (const z of distinct(s.rows.map((r) => r.zoneId))) if (!zoneSet.has(z)) review.notInZoneList.push({ zoneId: z, source: s.id });
  }
  review.checkSummary = checks.map(({ setting, src }) => ({ ...setting, computed: computeFlags(setting.kind, src.rows, resultsByCheck.get(checkKey(setting)) ?? []) }));
  review.uncoveredNames = {
    room: distinct(rooms.filter((r) => r.name && roomClass(r.name, dict).recClass === "rec:Room").map((r) => r.name as string)),
    storey: distinct(floors.filter((f) => storeyClass(f.name, null, dict) === "rec:Level").map((f) => f.name)),
    useGroup: distinct(sources.flatMap((s) => s.rows.map((r) => r.useGroup)).filter((u): u is string => !!u && !useGroupClasses(u, dict))),
  };

  const allRooms = [...rooms, ...createdRooms];
  const count = (st: ZoneStatus) => zones.filter((z) => z.status === st).length;
  const spatial: SpatialOut = {
    meta: {
      generatedBy: "match-zone-rooms.ts",
      generatedAt: new Date().toISOString(),
      zoneRooms: zr ? "zone-rooms.json" : null,
      totalFloors: floors.length,
      totalRooms: allRooms.length,
      totalZones: zones.length,
      zonesByStatus: { matched: count("matched"), created: count("created"), unlinked: count("unlinked") },
      roomsBySource: { ifc: rooms.length, documents: createdRooms.length },
    },
    building: { name: ifc.building?.name ?? "", longName: ifc.building?.longName ?? "" },
    floors,
    rooms: allRooms,
    zones,
  };
  return { spatial, review };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(file: string, hint: string): any {
  if (!fs.existsSync(file)) throw new Error(`not found: ${file} (${hint})`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function printReview(r: Review): void {
  const section = (title: string, lines: string[]) => {
    console.log(`\n${title} (${lines.length})`);
    for (const l of lines) console.log(`  ${l}`);
  };
  const zoneLine = (z: ZoneItem) =>
    `${z.zoneId} -> ${z.proposedRoom ?? "(no room)"}${Object.keys(z.checks).length ? "  " + Object.entries(z.checks).map(([k, v]) => `${k}=${v}`).join("; ") : ""}`;
  console.log(`Rule: ${r.ruleSummary.hits} zone(s) hit an IFC room; misses: ${r.ruleSummary.misses.join(", ") || "none"}`);
  section("Disagreements (a counting check fails)", r.disagreements.map(zoneLine));
  section("No room (no template gives an IFC room)", r.noRoom.map(zoneLine));
  section("Rule only (no fail, no independent pass) - one group decision", r.ruleOnly);
  section("In a document, not in the zone list (reported only)", r.notInZoneList.map((n) => `${n.zoneId} (${n.source})`));
  section("Stale decisions (re-ask)", r.stale.map((s) => `${s.zoneId}: ${s.why}`));
  section(
    "Checks (stored flags vs computed by the fixed rules)",
    r.checkSummary.map((c) => {
      const eff = effectiveFlags(c);
      const a = c.computed.agreement;
      return `${checkKey(c)}: agreement ${a.pass}/${a.pass + a.fail}; computed counts=${c.computed.counts} independent=${c.computed.independent}; stored counts=${eff.counts} independent=${eff.independent}${c.override ? ` (override: ${c.override.reason})` : ""}`;
    }),
  );
  section("Room names without a roomName word", r.uncoveredNames.room);
  section("Storey names without a storeyName word", r.uncoveredNames.storey);
  section("Use groups without a useGroup word", r.uncoveredNames.useGroup);
  section("Issues", r.issues);
}

function main(argv: string[]): void {
  const b = argv.find((a) => !a.startsWith("--"));
  if (!b) throw new Error("usage: npx ts-node tools/match-zone-rooms.ts <b> [--review] [--force]");
  const inputs = path.join(dataRoot(), b, "inputs");
  const ifc = readJson(path.join(inputs, "ifc-spatial.json"), "run tools/build-spatial-hierarchy.py first") as IfcSpatial;
  const zpm = readJson(path.join(inputs, "zone-point-mapping.json"), "run point mapping first");
  const zoneIds: string[] = (zpm.zones ?? []).map((z: any) => z.zoneId);
  const zr = loadZoneRooms(b);
  if (zr) {
    const ifcNumbers = new Set(ifc.spaces.map((s) => s.number).filter((n): n is string => !!n));
    const errors = validateZoneRooms(zr, ifcNumbers);
    if (errors.length) throw new Error(`zone-rooms.json is invalid:\n  - ${errors.join("\n  - ")}`);
  }
  const dict = loadPartsDictionary(b);
  const index = readJson(path.resolve(__dirname, "..", "ontologies", "brick-classification-index.json"), "brick index") as BrickIndex;
  const connPath = path.join(inputs, "building-connections.json");
  const feeds: Feeds | null = fs.existsSync(connPath) ? { plantFeedsZone: readJson(connPath, "").plantFeedsZone ?? [] } : null;

  const { spatial, review } = buildSpatial({ ifc, zoneIds, zr, dict, index, feeds });
  if (argv.includes("--review")) {
    printReview(review);
    return;
  }
  const out = path.join(inputs, "spatial-hierarchy.json");
  guardAgainstClassifiedOverwrite(out, argv.includes("--force"));
  fs.writeFileSync(out, JSON.stringify(spatial, null, 2) + "\n", "utf-8");
  const m = spatial.meta;
  console.log(`Wrote ${out}`);
  console.log(`  floors ${m.totalFloors}, rooms ${m.totalRooms} (ifc ${m.roomsBySource.ifc}, documents ${m.roomsBySource.documents}), zones ${m.totalZones}`);
  console.log(`  zones: matched ${m.zonesByStatus.matched}, created ${m.zonesByStatus.created}, unlinked ${m.zonesByStatus.unlinked}`);
  console.log(`  open review items: ${review.disagreements.length} disagreement(s), ${review.noRoom.length} no-room, ${review.stale.length} stale (see --review)`);
  for (const i of review.issues) console.log(`  ${i}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
