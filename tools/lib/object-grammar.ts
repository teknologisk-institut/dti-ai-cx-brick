// tools/lib/object-grammar.ts
// Compiles a BACnet profile's naming.objectNames rules and places one object name.
// Pure: no fs. The rules live in the building profile; nothing building-specific here.

import { BuildingProfile, ObjectRule, compileRegex } from "./building-profile";
import type { ObjectRow } from "./bacnet-objects";

interface CompiledDevice {
  id: string;
  column: string;
  re: RegExp;
  role: "parent" | "controller";
}

interface CompiledRule {
  rule: ObjectRule;
  re: RegExp;
  rewrites: { re: RegExp; replace: string }[];
}

interface CompiledMerge {
  id: string;
  re: RegExp;
  source: string;
}

export interface Grammar {
  separator: string;
  stripPrefix: RegExp | null;
  devices: CompiledDevice[];
  rules: CompiledRule[];
  merge: CompiledMerge[];
}

export type Placement =
  | { kind: "plant" | "zone"; parentId: string; pointPart: string; ruleId: string }
  | { toDevice: true; ruleId: string }
  | { skip: true; ruleId: string; reason: string }
  | { unplaced: true };

export function compileGrammar(profile: BuildingProfile): Grammar {
  const on = profile.naming?.objectNames;
  if (!on) {
    throw new Error(`profile ${profile.buildingId}: naming.objectNames is required for a bacnet profile`);
  }
  const separator = profile.naming?.separator;
  if (separator === undefined) {
    throw new Error(`profile ${profile.buildingId}: naming.separator is required with naming.objectNames`);
  }
  return {
    separator,
    stripPrefix: on.stripPrefix ? compileRegex(on.stripPrefix) : null,
    devices: on.devices.map((d) => ({ id: d.id, column: d.column, re: compileRegex(d), role: d.role })),
    rules: on.rules.map((rule) => ({
      rule,
      re: compileRegex(rule),
      rewrites: (rule.parentRewrite ?? []).map((r) => ({ re: new RegExp(r.pattern), replace: r.replace })),
    })),
    merge: (on.merge ?? []).map((m) => ({ id: m.id, re: compileRegex(m), source: m.source })),
  };
}

/** First device rule whose column value matches; `row` is keyed by devices.csv header. */
export function deviceRole(
  g: Grammar,
  row: Record<string, string>
): { ruleId: string; role: "parent" | "controller" } | null {
  for (const d of g.devices) {
    if (d.re.test(row[d.column] ?? "")) return { ruleId: d.id, role: d.role };
  }
  return null;
}

/** A device name as an id part: strip the prefix once, then turn each whitespace run into the separator. */
export function cleanName(g: Grammar, name: string): string {
  return stripObjectName(g, name).replace(/\s+/g, g.separator);
}

/** An object name: strip the prefix once; its spaces stay (as the object's point ids always kept them). */
export function stripObjectName(g: Grammar, name: string): string {
  return g.stripPrefix ? name.replace(g.stripPrefix, "") : name;
}

/** Try the rules in order on the prefix-stripped name; first match wins. No merging here.
 * A toDevice match returns { toDevice }: the walk knows the device name that becomes the parent. */
export function placeObject(
  g: Grammar,
  deviceRuleId: string,
  objectName: string,
  opts?: { scopedOnly?: boolean }
): Placement {
  const name = stripObjectName(g, objectName);
  for (const c of g.rules) {
    const { rule } = c;
    if (rule.device !== undefined && rule.device !== deviceRuleId) continue;
    if (opts?.scopedOnly && rule.device === undefined) continue;
    const m = c.re.exec(name);
    if (!m) continue;
    if (rule.skip) return { skip: true, ruleId: rule.id, reason: rule.reason ?? "" };
    if (rule.toDevice) return { toDevice: true, ruleId: rule.id };
    let parentId = rule.parent ?? m.groups?.parent ?? "";
    for (const r of c.rewrites) parentId = parentId.replace(r.re, r.replace);
    return { kind: rule.kind ?? "plant", parentId, pointPart: m.groups?.point ?? "", ruleId: rule.id };
  }
  return { unplaced: true };
}

export function pointIdFor(separator: string, parentId: string, pointPart: string): string {
  return `${parentId}${separator}${pointPart}`;
}

// ---------------------------------------------------------------------------
// The walk over every device's objects (shared by the profile data check and the mapper)
// ---------------------------------------------------------------------------

export interface WalkDevice {
  instance: number;
  name: string;
  row: Record<string, string>;
  objects: ObjectRow[];
}

export interface PlacedObject {
  section: "plant" | "zone" | "device";
  parentId: string;
  pointPart: string;
  bmsPointId: string;
  /** object rule id; for a parent-role device's own points and for device points: the device rule id ("" if no role) */
  ruleId: string;
  /** a device point placed by a toDevice rule (ruleId is then that rule's id) */
  toDevice?: boolean;
  device: { instance: number; name: string };
  object: ObjectRow;
}

export interface WalkResult {
  devices: { instance: number; name: string; ruleId: string | null; role: "parent" | "controller" | null }[];
  /** a device with an object file and no device rule; two or more parent devices whose cleaned names give one plant id */
  deviceErrors: string[];
  placed: PlacedObject[];
  skipped: { ruleId: string; reason: string; instance: number; objectName: string }[];
  /** copies a merge rule collapsed; instances[0] is the kept (source) copy, the rest were not placed */
  merged: { ruleId: string; objectName: string; instances: number[]; presentValues: string[] }[];
  /** raw names placed on 2+ devices that no merge rule covers */
  duplicates: { objectName: string; instances: number[]; presentValues: string[]; differ: boolean }[];
  keptApart: { sharedId: string; objects: { instance: number; objectName: string; bmsPointId: string }[] }[];
  warnings: string[];
}

interface Candidate {
  section: PlacedObject["section"];
  parentId: string;
  pointPart: string;
  ruleId: string;
  toDevice: boolean;
  /** on a controller-role device; a parent-role device's registers are its own points, never copies */
  controller: boolean;
  device: { instance: number; name: string };
  object: ObjectRow;
}

/** Throw when an id occurs twice: a collision must never be silent (a repeated id loses a point downstream). */
export function assertUniqueIds(ids: string[]): void {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  if (dup.size > 0) throw new Error(`${dup.size} duplicated bmsPointId(s); nothing written: ${[...dup].join(", ")}`);
}

/** Place every object of every device. Devices go in instance order, objects in row order.
 * Copies of one name on several devices are all placed (a later one with a taken id gets the keep-apart id)
 * unless a merge rule covers the name: then only the source device's copy is placed. */
export function walkObjects(g: Grammar, devices: WalkDevice[]): WalkResult {
  const out: WalkResult = { devices: [], deviceErrors: [], placed: [], skipped: [], merged: [], duplicates: [], keptApart: [], warnings: [] };
  const candidates: Candidate[] = [];
  // plant id built from a parent-role device's name -> the devices giving it (two or more would fold into one plant)
  const parentPlants = new Map<string, { instance: number; name: string }[]>();

  for (const dev of [...devices].sort((a, b) => a.instance - b.instance)) {
    const role = deviceRole(g, dev.row);
    out.devices.push({ instance: dev.instance, name: dev.name, ruleId: role?.ruleId ?? null, role: role?.role ?? null });
    if (!role) {
      out.deviceErrors.push(`device ${dev.instance} ${dev.name}: object file but no device rule matches`);
      continue;
    }
    const device = { instance: dev.instance, name: dev.name };
    for (const object of dev.objects) {
      const p = placeObject(g, role.ruleId, object.objectName, role.role === "parent" ? { scopedOnly: true } : undefined);
      if ("skip" in p) {
        out.skipped.push({ ruleId: p.ruleId, reason: p.reason, instance: dev.instance, objectName: object.objectName });
      } else if ("toDevice" in p) {
        candidates.push({
          section: "device", parentId: cleanName(g, dev.name), pointPart: stripObjectName(g, object.objectName),
          ruleId: p.ruleId, toDevice: true, controller: role.role === "controller", device, object,
        });
      } else if ("unplaced" in p) {
        const parentId = cleanName(g, dev.name);
        if (role.role === "parent") {
          const l = parentPlants.get(parentId) ?? [];
          if (!l.includes(device)) l.push(device);
          parentPlants.set(parentId, l);
        }
        candidates.push({
          section: role.role === "parent" ? "plant" : "device", parentId,
          pointPart: stripObjectName(g, object.objectName), ruleId: role.ruleId, toDevice: false, controller: role.role === "controller", device, object,
        });
      } else {
        candidates.push({ section: p.kind, parentId: p.parentId, pointPart: p.pointPart, ruleId: p.ruleId, toDevice: false, controller: role.role === "controller", device, object });
      }
    }
  }
  for (const [plantId, devs] of parentPlants) {
    if (devs.length < 2) continue;
    out.deviceErrors.push(
      `plant ${plantId}: ${devs.length} parent devices give this plant id (cleaned device name): ${devs.map((d) => `${d.instance} "${d.name}"`).join(", ")}; they would fold into one plant (no automatic remedy)`,
    );
  }

  // Copies: group by raw name; a merge rule keeps the source device's copy, otherwise the name is a duplicate
  const byName = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.controller) continue;
    const l = byName.get(c.object.objectName);
    if (l) l.push(c);
    else byName.set(c.object.objectName, [c]);
  }
  const dropped = new Set<Candidate>();
  for (const [objectName, group] of byName) {
    const instances = [...new Set(group.map((c) => c.device.instance))];
    if (instances.length < 2) continue;
    const m = g.merge.find((x) => x.re.test(stripObjectName(g, objectName)));
    if (!m) {
      const values = group.map((c) => c.object.presentValue);
      out.duplicates.push({ objectName, instances: group.map((c) => c.device.instance), presentValues: values, differ: new Set(values).size > 1 });
      continue;
    }
    let keep = group.find((c) => c.device.name === m.source)?.device.instance;
    if (keep === undefined) {
      keep = Math.min(...instances);
      out.warnings.push(`merge rule ${m.id}: source "${m.source}" has no copy of ${objectName}; kept the copy on instance ${keep}`);
    }
    const kept = group.filter((c) => c.device.instance === keep);
    const rest = group.filter((c) => c.device.instance !== keep);
    for (const c of rest) dropped.add(c);
    out.merged.push({
      ruleId: m.id,
      objectName,
      instances: [...kept, ...rest].map((c) => c.device.instance),
      presentValues: [...kept, ...rest].map((c) => c.object.presentValue),
    });
  }

  // Ids: device order, then row order; a later object with a taken id gets the keep-apart id
  const idOwner = new Map<string, { instance: number; objectName: string }>();
  const keptApart = new Map<string, WalkResult["keptApart"][number]>();
  for (const c of candidates) {
    if (dropped.has(c)) continue;
    const { object, device } = c;
    let bmsPointId = pointIdFor(g.separator, c.parentId, c.pointPart);
    const owner = idOwner.get(bmsPointId);
    const me = { instance: device.instance, objectName: object.objectName };
    if (owner) {
      const sharedId = bmsPointId;
      const typed = `${sharedId}${g.separator}${object.objectType}-${object.objectInstance}`;
      bmsPointId = typed;
      if (idOwner.has(bmsPointId)) bmsPointId = `${sharedId}${g.separator}${device.instance}-${object.objectType}-${object.objectInstance}`;
      const clash = idOwner.get(bmsPointId);
      if (clash) {
        throw new Error(
          `duplicate object: "${clash.objectName}" on device ${clash.instance} and "${object.objectName}" on device ${device.instance} both yield id ${bmsPointId} (same device, object type and instance)`,
        );
      }
      idOwner.set(bmsPointId, me);
      let k = keptApart.get(sharedId);
      if (!k) {
        k = { sharedId, objects: [{ instance: owner.instance, objectName: owner.objectName, bmsPointId: sharedId }] };
        keptApart.set(sharedId, k);
        out.keptApart.push(k);
      }
      k.objects.push({ instance: device.instance, objectName: object.objectName, bmsPointId });
    } else {
      idOwner.set(bmsPointId, me);
    }
    out.placed.push({
      section: c.section, parentId: c.parentId, pointPart: c.pointPart, bmsPointId, ruleId: c.ruleId,
      ...(c.toDevice ? { toDevice: true } : {}), device, object,
    });
  }
  return out;
}
