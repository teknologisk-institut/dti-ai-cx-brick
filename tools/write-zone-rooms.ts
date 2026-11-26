// tools/write-zone-rooms.ts
// The only write path of data/{b}/zone-rooms.json (rule, second-source rows, check flags, human decisions).
//
// Usage (npx ts-node tools/write-zone-rooms.ts ...):
//   <b> rule        stdin: the rule object; replaces the rule
//   <b> sources     stdin: one source or an array; merged by id (the rows of the same id are replaced)
//   <b> checks      stdin: one check or an array; merged by kind:source
//   <b> decisions   stdin: { "<zoneId>": Decision, ... }; merged by zone id
//   <b> --validate  re-check the file
// Writes only if the result validates (a created room may not reuse an IFC room number, read from
// data/{b}/inputs/ifc-spatial.json when present). Exit 1 with every error otherwise.

import * as fs from "fs";
import * as path from "path";
import { dataRoot } from "./lib/building-profile";
import { checkKey, loadZoneRooms, validateZoneRooms, zoneRoomsPath } from "./lib/zone-rooms";
import type { ZoneRooms } from "./lib/zone-rooms";

function fail(msg: string): never {
  throw new Error(msg);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parseStdin(what: string): any {
  const text = readStdin();
  if (text.trim() === "") fail(`${what}: no JSON on stdin`);
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`${what}: stdin is not valid JSON: ${(e as Error).message}`);
  }
}

function ifcRoomNumbers(b: string): Set<string> | undefined {
  const p = path.join(dataRoot(), b, "inputs", "ifc-spatial.json");
  if (!fs.existsSync(p)) return undefined;
  const j = JSON.parse(fs.readFileSync(p, "utf-8"));
  return new Set<string>((j.spaces ?? []).map((s: any) => s?.number).filter((n: unknown): n is string => typeof n === "string" && n !== ""));
}

function mergeByKey<T>(current: T[], incoming: T[], key: (x: T) => string): T[] {
  const out = [...current];
  for (const item of incoming) {
    const i = out.findIndex((x) => key(x) === key(item));
    if (i === -1) out.push(item);
    else out[i] = item;
  }
  return out;
}

function main(argv: string[]): void {
  const [b, section] = argv;
  if (!b || !section) fail("usage: <b> rule|sources|checks|decisions  (JSON on stdin)  |  <b> --validate");

  if (section === "--validate") {
    const zr = loadZoneRooms(b);
    if (!zr) fail(`no zone-rooms file: ${zoneRoomsPath(b)}`);
    const errors = validateZoneRooms(zr, ifcRoomNumbers(b));
    if (errors.length) fail(`${errors.length} validation error(s):\n  - ${errors.join("\n  - ")}`);
    console.log(`Validation OK for ${b}.`);
    return;
  }
  if (!["rule", "sources", "checks", "decisions"].includes(section)) fail(`unknown section "${section}" (rule|sources|checks|decisions)`);

  const input = parseStdin(section);
  const current: ZoneRooms = loadZoneRooms(b) ?? { schemaVersion: 1, rule: { kind: "idTemplates", templates: [] }, sources: [], checks: [], decisions: {} };
  const next: ZoneRooms = JSON.parse(JSON.stringify(current));
  const asArray = (v: any): any[] => (Array.isArray(v) ? v : [v]);

  if (section === "rule") next.rule = input;
  else if (section === "sources") {
    const items = asArray(input);
    const bad = items.map((s, i) => (typeof s === "object" && s !== null && !Array.isArray(s) ? null : `sources[${i}]: must be an object`)).filter((m): m is string => m !== null);
    if (bad.length) fail(`refused, nothing written (${bad.length} validation error(s)):\n  - ${bad.join("\n  - ")}`);
    next.sources = mergeByKey(next.sources, items, (s) => s.id);
  }
  else if (section === "checks") {
    const items = asArray(input);
    const bad = items.map((c, i) => (typeof c === "object" && c !== null && !Array.isArray(c) ? null : `checks[${i}]: must be an object`)).filter((m): m is string => m !== null);
    if (bad.length) fail(`refused, nothing written (${bad.length} validation error(s)):\n  - ${bad.join("\n  - ")}`);
    next.checks = mergeByKey(next.checks, items, (c) => checkKey(c));
  }
  else {
    if (typeof input !== "object" || input === null || Array.isArray(input)) fail('decisions: stdin must be an object { "<zoneId>": Decision }');
    next.decisions = { ...next.decisions, ...input };
  }

  const errors = validateZoneRooms(next, ifcRoomNumbers(b));
  if (errors.length) fail(`refused, nothing written (${errors.length} validation error(s)):\n  - ${errors.join("\n  - ")}`);
  const file = zoneRoomsPath(b);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${section} to ${file}.`);
  next.rule.templates.forEach((t, i) => {
    if (!t.pattern.startsWith("^") || !t.pattern.endsWith("$")) console.log(`warning: rule.templates[${i}].pattern is not anchored with ^...$; it only applies when it matches the whole zone id`);
  });
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
