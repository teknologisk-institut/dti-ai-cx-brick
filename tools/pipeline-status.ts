// tools/pipeline-status.ts
//
// Read-only overview of which build steps (0-6) apply to a building, given its
// profile (data/{buildingId}/building-config.json). Never writes anything.
//
// Usage: npx ts-node tools/pipeline-status.ts <buildingId>   (always exits 0)

import * as fs from "fs";
import * as path from "path";
import { loadProfile, dataRoot, BuildingProfile } from "./lib/building-profile";

export interface StepStatus {
  step: number;
  name: string;
  state: "applies" | "skipped" | "done";
  reason?: string;
}

// One input alternative: a label for messages and the relative paths it declares.
type Alt = { label: string; rels: string[] };

function list(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function computeStatus(profile: BuildingProfile, rootOverride?: string): StepStatus[] {
  const root = rootOverride ?? dataRoot();
  const base = path.join(root, profile.buildingId);
  const exists = (rel: string) => fs.existsSync(path.join(base, rel));
  const inp = profile.inputs;
  const img = inp.images ?? {};

  // Returns a skip reason if none of the alternatives is declared AND present on disk, else undefined.
  function missing(alts: Alt[]): string | undefined {
    const reasons: string[] = [];
    for (const a of alts) {
      if (a.rels.length === 0) {
        reasons.push(a.label);
        continue;
      }
      const absent = a.rels.filter((r) => !exists(r));
      if (absent.length < a.rels.length) return undefined; // at least one present
      reasons.push(...absent.map((r) => `missing path ${path.join(base, r)}`));
    }
    const undeclared = alts.filter((a) => a.rels.length === 0).map((a) => a.label);
    const absentPaths = reasons.filter((r) => r.startsWith("missing path"));
    const parts: string[] = [];
    if (undeclared.length) parts.push(`no ${undeclared.join(", ")}`);
    parts.push(...absentPaths);
    return parts.join("; ");
  }

  // Order of checks: inputs first (skipped if the required input is missing, even if the
  // output exists), then done if the output exists, else applies.
  function step(n: number, name: string, alts: Alt[], outputs: string[], done?: () => boolean): StepStatus {
    const reason = missing(alts);
    if (reason) return { step: n, name, state: "skipped", reason };
    const isDone = done ? done() : outputs.every(exists);
    return { step: n, name, state: isDone ? "done" : "applies" };
  }

  const rows: StepStatus[] = [{ step: 0, name: "Inventory", state: "done" }];

  // Step 1a: split point list (timeseries only)
  if (profile.dataShape === "timeseries") {
    rows.push(
      step(1, "Parse inputs: split point list", [{ label: "inputs.pointList", rels: list(inp.pointList) }], [
        "inputs/pointlist-plants.csv",
      ])
    );
  } else {
    rows.push({
      step: 1,
      name: "Parse inputs: split point list",
      state: "skipped",
      reason: "split applies to timeseries buildings only",
    });
  }
  // Step 1b: spatial hierarchy
  rows.push(
    step(1, "Parse inputs: spatial hierarchy", [{ label: "inputs.architectureIfc", rels: list(inp.architectureIfc) }], [
      "inputs/ifc-spatial.json",
    ])
  );

  const pointInputs: Alt[] =
    profile.dataShape === "timeseries"
      ? [
          { label: "inputs.pointList", rels: list(inp.pointList) },
          { label: "inputs.tsdbObjects", rels: list(inp.tsdbObjects) },
        ]
      : [
          { label: "inputs.devices", rels: list(inp.devices) },
          { label: "inputs.bacnetObjects", rels: list(inp.bacnetObjects) },
        ];
  // Point mapping needs ALL its point inputs, so check each as its own requirement.
  const pmReasons = pointInputs.map((a) => missing([a])).filter((r): r is string => !!r);
  if (pmReasons.length) {
    rows.push({ step: 2, name: "Point mapping", state: "skipped", reason: pmReasons.join("; ") });
  } else {
    rows.push(
      step(2, "Point mapping", [], ["inputs/plant-point-mapping.json", "inputs/zone-point-mapping.json"])
    );
  }
  // Point-list equipment items: done when the --bms pass has covered the current point mapping, i.e.
  // equipment-inventory.json's meta.bmsPass.mappingGeneratedAt equals plant-point-mapping.json's generatedAt.
  rows.push(
    step(2, "Equipment from point list (update-equipment --bms)", [], [], () => {
      const readJson = (rel: string): any => {
        try {
          return JSON.parse(fs.readFileSync(path.join(base, rel), "utf-8"));
        } catch {
          return undefined;
        }
      };
      const generatedAt = readJson("inputs/plant-point-mapping.json")?.generatedAt;
      const recorded = readJson("inputs/equipment-inventory.json")?.meta?.bmsPass?.mappingGeneratedAt;
      return typeof generatedAt === "string" && recorded === generatedAt;
    })
  );
  // Zone-room matching: zones (from point mapping) matched to IFC rooms -> spatial-hierarchy.json
  rows.push(step(2, "Zone-room matching", [], ["inputs/spatial-hierarchy.json"]));

  rows.push(
    step(
      3,
      "Building connections",
      [
        { label: "images.floorplans", rels: list(img.floorplans) },
        { label: "images.rooms", rels: list(img.rooms) },
        { label: "images.plantsOverview", rels: list(img.plantsOverview) },
        { label: "installationIfcs", rels: list(inp.installationIfcs) },
      ],
      ["inputs/building-connections.json"]
    )
  );
  rows.push(
    step(
      4,
      "Equipment inventory",
      [
        { label: "images.plants", rels: list(img.plants) },
        { label: "images.rooms", rels: list(img.rooms) },
      ],
      ["inputs/equipment-inventory.json"]
    )
  );

  rows.push(
    step(5, "Classification", [], [], () => {
      const f = path.join(base, "inputs", "plant-point-mapping.json");
      return fs.existsSync(f) && fs.readFileSync(f, "utf-8").includes('"brickClass"');
    })
  );
  rows.push(step(6, "TTL", [], ["outputs/building.ttl"]));

  return rows;
}

export interface ReviewCounts {
  ductConfirmed: number;
  ductPlants: number;
  mediumItems: number;
  plantItems: number;
}

// Review progress read from inputs/equipment-inventory.json (plant equipment only).
// undefined when the file is missing or unreadable.
export function reviewCounts(buildingDir: string): ReviewCounts | undefined {
  let inv: any;
  try {
    inv = JSON.parse(fs.readFileSync(path.join(buildingDir, "inputs", "equipment-inventory.json"), "utf-8"));
  } catch {
    return undefined;
  }
  const plants: any[] = Array.isArray(inv?.plantEquipment) ? inv.plantEquipment : [];
  const withItems = plants.filter((p) => Array.isArray(p?.equipment) && p.equipment.length > 0);
  const items = withItems.flatMap((p) => p.equipment as any[]);
  return {
    ductPlants: withItems.length,
    ductConfirmed: withItems.filter((p) => p.ductOrientation).length,
    plantItems: items.length,
    mediumItems: items.filter((i) => i?.medium).length,
  };
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.log("usage: npx ts-node tools/pipeline-status.ts <buildingId>");
    return;
  }
  let profile: BuildingProfile;
  try {
    profile = loadProfile(id);
  } catch (e) {
    console.log((e as Error).message);
    console.log("step 0 Inventory: not done");
    return;
  }
  for (const r of computeStatus(profile)) {
    console.log(`step ${r.step} ${r.name}: ${r.state}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  const rc = reviewCounts(path.join(dataRoot(), profile.buildingId));
  if (rc) {
    console.log(`review: duct direction confirmed on ${rc.ductConfirmed} of ${rc.ductPlants} plants`);
    console.log(`review: equipment medium on ${rc.mediumItems} of ${rc.plantItems} plant equipment items`);
  }
}

if (require.main === module) main();
