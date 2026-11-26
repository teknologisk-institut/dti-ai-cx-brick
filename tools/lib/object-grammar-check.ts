// tools/lib/object-grammar-check.ts
// Write-time data check for a bacnet profile: reads devices.csv and the per-device object files,
// walks every object through the profile's naming.objectNames grammar and reports what it did.
// Assumes the profile already passed validateProfile.

import * as fs from "fs";
import * as path from "path";
import { BuildingProfile, inputPath, dataRoot } from "./building-profile";
import { readCsvRows, readObjectRows, OBJECT_FILE_RE } from "./bacnet-objects";
import { compileGrammar, walkObjects, WalkDevice } from "./object-grammar";
import { plantTokenOf } from "./point-id";

/** devices.csv rows (keyed by header) joined to the per-device object files (objects_<instance>_*.csv),
 * one WalkDevice per object file. Errors (never a silent skip, the objects would be lost): an object file with no
 * devices.csv row; a devices.csv without an `instance` column. */
export function readWalkDevices(devicesFile: string, objectsDir: string): { devices: WalkDevice[]; errors: string[] } {
  const errors: string[] = [];
  const csv = readCsvRows(devicesFile);
  const header = csv[0] ?? [];
  const iInst = header.indexOf("instance");
  if (iInst === -1) {
    return { devices: [], errors: [`${devicesFile}: no "instance" column (header: ${header.join(", ")}); no object file can be matched to its device`] };
  }
  const rows = new Map<number, Record<string, string>>();
  for (const r of csv.slice(1)) {
    const instance = parseInt(r[iInst], 10);
    if (isNaN(instance)) continue;
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (r[i] ?? "").trim()));
    rows.set(instance, row);
  }

  const devices: WalkDevice[] = [];
  for (const file of fs.readdirSync(objectsDir).filter((f) => OBJECT_FILE_RE.test(f)).sort()) {
    const instance = parseInt(/^objects_(\d+)_/i.exec(file)![1], 10);
    const row = rows.get(instance);
    if (!row) {
      errors.push(`${file}: no device with instance ${instance} in devices.csv; its objects would be lost`);
      continue;
    }
    devices.push({ instance, name: row["object-name"] ?? "", row, objects: readObjectRows(path.join(objectsDir, file)) });
  }
  return { devices, errors };
}

export function checkBacnetProfileData(
  profile: BuildingProfile,
  dataRootDir?: string
): { errors: string[]; warnings: string[]; report: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const report: string[] = [];
  if (profile.dataShape !== "bacnet" || !profile.naming?.objectNames || !profile.inputs.devices || !profile.inputs.bacnetObjects) {
    return { errors, warnings, report };
  }
  const devicesFile = inputPath(profile, "devices", dataRootDir);
  const objectsDir = inputPath(profile, "bacnetObjects", dataRootDir);
  if (!fs.existsSync(devicesFile) || !fs.existsSync(objectsDir)) {
    report.push(`devices or object files not found, data check skipped: ${devicesFile} | ${objectsDir}`);
    return { errors, warnings, report };
  }

  const { devices, errors: readErrors } = readWalkDevices(devicesFile, objectsDir);
  errors.push(...readErrors);

  const g = compileGrammar(profile);
  const w = walkObjects(g, devices);
  errors.push(...w.deviceErrors);

  const deviceName = new Map(w.devices.map((d) => [d.instance, d.name]));

  for (const d of g.devices) {
    report.push(`devices ${d.id}: ${w.devices.filter((x) => x.ruleId === d.id).length}`);
  }

  for (const { rule } of g.rules) {
    if (rule.toDevice) {
      const n = w.placed.filter((p) => p.toDevice && p.ruleId === rule.id).length;
      report.push(`toDevice ${rule.id}: ${n} (${rule.reason ?? ""})`);
      if (n === 0) warnings.push(`rule ${rule.id} matches nothing`);
      continue;
    }
    if (rule.skip) {
      const n = w.skipped.filter((s) => s.ruleId === rule.id).length;
      report.push(`skip ${rule.id}: ${n} (${rule.reason ?? ""})`);
      if (n === 0) warnings.push(`rule ${rule.id} matches nothing`);
      continue;
    }
    const placed = w.placed.filter((p) => p.ruleId === rule.id && p.section !== "device");
    const parents = new Set(placed.map((p) => p.parentId)).size;
    report.push(`rule ${rule.id}: objects ${placed.length}, parents ${parents}`);
    for (const p of placed.slice(0, 3)) report.push(`  ${p.object.objectName} -> ${p.parentId} | ${p.pointPart}`);
    if (placed.length === 0) warnings.push(`rule ${rule.id} matches nothing`);
  }

  // Objects no rule placed on a controller: grouped by shape (digits -> 9)
  const unplaced = new Map<string, number>();
  for (const p of w.placed) {
    if (p.section !== "device" || p.toDevice) continue;
    const key = `${p.device.name}: ${p.object.objectName.replace(/\d/g, "9")}`;
    unplaced.set(key, (unplaced.get(key) ?? 0) + 1);
  }
  for (const [key, n] of unplaced) report.push(`unplaced ${key} x${n}`);

  for (const m of g.merge) {
    const copies = w.merged.filter((x) => x.ruleId === m.id).reduce((n, x) => n + x.instances.length - 1, 0);
    report.push(`merged ${m.id}: ${copies} copies (source ${m.source})`);
    if (copies === 0) warnings.push(`merge rule ${m.id} merges nothing`);
  }
  warnings.push(...w.warnings);
  for (const d of w.duplicates) {
    const copies = d.instances.map((i, k) => `${deviceName.get(i)}=${d.presentValues[k]}`).join(" | ");
    report.push(`duplicate not merged ${d.objectName}: ${copies}${d.differ ? " (values differ)" : ""}`);
  }
  for (const k of w.keptApart) {
    report.push(`duplicate kept apart ${k.sharedId}: ${k.objects.map((o) => o.objectName).join(" | ")}`);
  }

  // Plant tokens against the point dictionary
  const dictFile = path.join(dataRootDir ?? dataRoot(), profile.buildingId, "point-dictionary.json");
  if (!fs.existsSync(dictFile)) {
    warnings.push(`point-dictionary.json not found, plant token check skipped: ${dictFile}`);
  } else {
    const dict = JSON.parse(fs.readFileSync(dictFile, "utf-8"));
    const tokens = dict.plantTokens ?? {};
    const overrides = dict.plantOverrides ?? {};
    const plantIds = [...new Set(w.placed.filter((p) => p.section === "plant").map((p) => p.parentId))];
    for (const id of plantIds) {
      if (id in overrides) continue;
      const token = plantTokenOf(profile, id);
      if (token === null) warnings.push(`plant ${id}: no plant token and no plantOverrides entry`);
      else if (!(token in tokens)) warnings.push(`plant ${id}: no plantTokens entry for "${token}" and no plantOverrides entry`);
    }
  }
  return { errors, warnings, report };
}
