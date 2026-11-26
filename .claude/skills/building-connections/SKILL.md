---
name: building-connections
description: >
  Guides extraction of building topology connections from BMS schematic images
  for the AI-CX project. Covers three connection types: plant-feeds-zone (which
  ventilation/heating plants serve which zones), plant-serves-plant (cooling/heating
  supply chains between plants), and plant-hierarchy (parent-child relationships
  like fire damper groups under ventilation units). Chooses the feeds method from
  the building profile's feedsSources: floorplan colours (direct colour comparison
  of zone polygons with the plant buttons), the feeding-plant reference on room
  schematics, and a cross-check against the installation IFC. Includes save-per-image
  incremental writing to building-connections.json. Use this skill whenever the user
  mentions extracting connections from BMS images, processing floorplan images for
  zone-plant mapping, plant schematic analysis, building topology extraction, or
  populating building-connections.json. Also trigger when the user mentions "feeds",
  "serves", "hierarchy", "floorplan colors", "zone colors", "plant overview images",
  or "image extraction for connections".
---

# Building Connections — Image Extraction Guide

## Purpose

This skill guides you through extracting inter-system topology from BMS
schematic images and writing the results to `building-connections.json`. The
spatial hierarchy (building → floors → rooms → zones) is already established
in `spatial-hierarchy.json`. This skill fills in the **dynamic topology** —
which plants serve which zones, and how plants relate to each other.

Examples use the example building `DEMO-TS` (`skill-00-context.md`, "The example buildings"): plants `VE01`,
`VA07`, `KO01`, `BSP01` (under `VE01`), zones `Z_101`, `Z_102`.

## Reference files to load before starting

```
Read: data/{buildingId}/building-config.json                ← the profile: feedsSources, bmsScreens, notes, inputs.images
Read: data/{buildingId}/{bmsScreens}                        ← the building's screen guide (the profile's bmsScreens)
Read: data/{buildingId}/{each file in notes}                ← the building's image pitfalls and corrections
Read: data/{buildingId}/inputs/spatial-hierarchy.json     ← zone IDs, floor/room structure
Read: data/{buildingId}/inputs/plant-point-mapping.json   ← known plant IDs (plants[].plantId)
Read: data/{buildingId}/point-dictionary.json             ← plantTokens: each plant's kind
Read: data/{buildingId}/inputs/building-connections.json   ← current state (may be empty)
```

Read the screen guide and every `notes` file **before the first image**. They say how this building's screens
look (where the plant buttons, title bar and plant references are, what the labels mean) and which misreads
happened before. This skill gives the method; the building's files give the screen facts. A building whose
profile declares images but no `bmsScreens` has no screen guide yet: draft it first (skill-00 Step 0, which
lists its sections) and re-write the profile with `write-building-profile.ts {buildingId} --force`; do not
read images without it.

Follow the **BMS Image Reading Protocol** and **Danish Language Awareness** in `skill-00-context.md`
(crop-first, id validation) for every image.

Run the summary to see what's already captured:
```
npx ts-node tools/update-connections.ts {buildingId} --summary
```

## Which feeds method applies

The plant→zone relation (`feeds`) comes from the source(s) the profile's `feedsSources` lists:

| `feedsSources` value | Method |
|---|---|
| `floorplanColours` | Stage 2 — floorplans: zone polygons coloured by their feeding plant, matched to the plant buttons |
| `roomSchematicPlantButton` | Stage 2b — room schematics: one feeds entry per room image, from the feeding-plant reference the screen guide describes, read from a crop |
| `installationIfc` | Stage 2c — after the image source is written, run `python tools/reconcile-feeds-ifc.py {buildingId} data/{buildingId}/<installation_ifc>` and review every match / IFC-only / image-only line |
| (none) | No feeds from images. Say so in your report; do not read feeds from screens the profile does not name |

A building may list more than one (an image source plus `installationIfc`). With `installationIfc` and no image
source there is nothing to reconcile against: ask the user how feeds are to be written.

`serves` and `hierarchy` do not depend on `feedsSources`: they come from the plant overviews (Stage 1) and the
plant schematics (Stage 3) for every building that has those images.

## The tool — update-connections.ts

All writes go through this tool. It manages `building-connections.json` with
upsert semantics (merges zone lists when a plant appears again from another image).

```bash
# Add plant-feeds-zone
echo '{"plantId":"VE01","zoneIds":["Z_101","Z_102"],"sourceImage":"floorplans/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type feeds

# Add plant-serves-plant
echo '{"plantId":"KO01","servesPlantIds":["VE01"],"sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type serves

# Add plant-hierarchy (parent-child)
echo '{"plantId":"BSP01","parentPlantId":"VE01","sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type hierarchy

# Validate (zone ids against spatial-hierarchy.json; its plant-id check reads a file the pipeline no
# longer writes — check plant ids against plant-point-mapping.json yourself)
npx ts-node tools/update-connections.ts {buildingId} --validate

# Show summary
npx ts-node tools/update-connections.ts {buildingId} --summary
```

The tool merges automatically — if `VE01` already has zones from a previous image,
new zones are added to the set. Pass JSON via stdin to avoid shell escaping issues
with non-ASCII characters (e.g. Danish ø, æ, å).

## Three connection types

### 1. plantFeedsZone — "which plant supplies which zones"

**Source:** the profile's `feedsSources` (see "Which feeds method applies"); plant schematics can confirm it
(Stage 3).

A ventilation plant (AHU) or heating plant feeds air/heat to a set of zones.
The same zone often has both a ventilation plant AND a heating plant feeding it —
this is normal and expected. Each plant gets its own entry.

**Confidence guidance:**
- `"high"` — color match (or plant reference) is unambiguous, zone ID clearly readable
- `"medium"` — color is close but could be confused with another plant's color
- `"low"` — zone ID partially obscured or color match uncertain

### 2. plantServesPlant — "which plant supplies other plants"

**Source:** Plant overview images and individual plant schematics.

A chiller supplies cooling coils in AHUs. A heating plant supplies heating coils
in multiple ventilation units. This captures the supply chain above the zone level.

```
VA07 (heating plant) ─serves─► VE01
KO01 (chiller)       ─serves─► VE01
```

### 3. plantHierarchy — "which plant is a sub-system of another"

**Source:** Plant schematics (or plant overviews) showing a sub-system, such as a fire-damper group, that
belongs to a parent plant.

```
BSP01 ─parent─► VE01
```

In the Brick model, hierarchy becomes `brick:isPartOf` (the child is part of the
parent system).

## Image processing order

Process images in this order because each stage informs the next. Each stage reads the folder the profile's
`inputs.images` names for it; a stage whose folder the profile does not declare is skipped.

### Stage 1: Plant overview images (sequential)

```
List: data/{buildingId}/{inputs.images.plantsOverview}
```

What these screens show (tabs, tables, groupings) is in the screen guide's `## Plant overview screens`. Some
overview screens draw no plant-to-plant links; then the plant schematics (Stage 3) carry them.

**What to extract:**
- Plant-to-plant service relationships visible in the grouping
- Which plants are related (e.g., a group showing `KO01` alongside `VE01`
  suggests `KO01` serves `VE01`)

Process these sequentially — each screen builds context for understanding the
plant topology. Write `--type serves` (and `--type hierarchy`) entries as you discover them.

### Stage 1b: Room overview images — moved

The room-overview screens (the profile's `inputs.images.roomsOverview`) are read in the zone↔room step, before this skill:
see the **point-mapping** skill, "Zone↔room matching", step 3 (rows into `zone-rooms.json`, and the
`update-equipment.ts --type zone-meta` call for the zone names). Use the zone floors and names it wrote
(`spatial-hierarchy.json` `zones[].floorId`, `zones[].name`) to know which zones to expect on each floorplan.

### Stage 2: Floorplan images (`floorplanColours`)

```
List: data/{buildingId}/{inputs.images.floorplans}
```

Only when `feedsSources` lists `floorplanColours`. Each image shows a section of a floor with zone polygons
coloured by their serving plant. How this building's floorplan screens look (where the plant buttons sit, the
title bar's floor names, the button size; if the screen has separate views per system, how to switch between
them) is in the screen guide's `## Floorplans`.

**This is where color accuracy matters most.** Previous attempts failed because
the model described button colors in words ("light blue", "pale yellow") and then
tried to match zone colors to those verbal descriptions. Subtle colors on small
buttons get misidentified, and the verbal translation introduces a second error
opportunity. The method below avoids verbal color descriptions entirely.

#### Direct visual matching (not color names)

The screen has plant buttons (a legend). Each button's background fill is the
SAME color used for that plant's zone polygons on the floorplan.

```
Plant buttons (sketch of the idea; this building's layout: the screen guide's ## Floorplans)
  [VE01]  [VA07]
```

**Do NOT describe button colors in words.** Instead, for each zone polygon,
compare its fill directly to each button's fill and pick the closest visual
match. Work zone-by-zone:

```
For Z_101: polygon fill matches the VE01 button → VE01
For Z_102: polygon fill matches the VE01 button → VE01
```

The key is DIRECT COMPARISON — look at a zone, look at each button, decide
which button is the same shade. Never translate through color names.

**ONLY extract zones whose labels are visually readable in the image.** Each
zone polygon has a text label printed on it (the zone id, e.g. `Z_101`). You must actually
see and read that label in the current image to include it. Do NOT infer or
add zone IDs based on:
- Your knowledge of which zones exist on this floor from spatial-hierarchy.json
- Logical guesses about which zones "should" be on this floor
- Zone IDs from adjacent images or previous extractions

If a zone exists on the floor but its polygon/label is not visible in this
particular image crop, it does not belong in this extraction. The floorplan
images may not show every zone on a floor — some zones may be cut off, in a
different wing, or simply not rendered. Only report what you can literally
read in the image.

**Spatial contiguity check — the critical validation:**

After assigning all zones, check that each plant's zones form a spatially
contiguous group on the floorplan. Ventilation plants serve connected regions
of a floor — a plant serving a zone on the far left AND one on the far right
while skipping everything in between is almost certainly a color swap error.

If the zone assignments DON'T form contiguous regions, you likely swapped the
plant-to-color mapping. In that case:
1. Pick ONE zone whose color is most obvious (e.g., a large polygon)
2. Compare that zone's fill directly to each button fill
3. Re-do the assignments from that anchor point

**Small buttons:** plant buttons can be small (the screen guide gives their size). Their background fill can
be hard to read at low resolution; read them from a crop. If you're uncertain which button matches which
color, use the spatial contiguity check as the tiebreaker — the assignment that produces contiguous zone
groups is correct.

**Title bar — floor and wing identification:** read the title bar to identify which floor (and wing) this
image covers. The building's title-bar floor names are in the screen guide's `## Floorplans`; the zones to
expect on that floor are `spatial-hierarchy.json` `zones[].floorId`.

**Validation before writing:**
- Every zone ID must exist in `spatial-hierarchy.json` → `zones[].id`. If a zone
  ID is not found, you likely misread a digit. Re-read carefully before accepting
  an unknown zone ID. Common misreads: 3↔8, 5↔6, 1↔7.
- **Count the labeled polygons visible in the image** and verify your extraction
  has the same count. If you extracted more zone IDs than there are labeled
  polygons, you hallucinated zones — remove any zone whose label you cannot
  point to in the image. If you extracted fewer, re-examine for missed labels.
- A zone should map to exactly one ventilation plant per image. If you see
  a zone assigned to two ventilation plants, something is wrong.
- **Do not use spatial-hierarchy.json to ADD zones.** Only use it to VALIDATE
  that zones you already read from the image are real. The image is the source
  of truth for which zones appear, not the hierarchy file.

**After validation, write one entry per plant:**

```bash
echo '{"plantId":"VE01","zoneIds":["Z_101","Z_102"],"sourceImage":"floorplans/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type feeds

echo '{"plantId":"VA07","zoneIds":["Z_101","Z_102"],"sourceImage":"floorplans/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type feeds
```

Note: a heating plant often serves ALL zones on a floor, and may serve every zone in the building — its colour
then covers the whole floor. This is expected, not an error. Ventilation plants split the floor between them.

**Save after each floorplan image.** If a session crashes, already-written
connections persist. When resuming, run `--summary` to see what's already
captured, then continue with the remaining images.

### Stage 2b: Room schematic images (`roomSchematicPlantButton`)

```
List: data/{buildingId}/{inputs.images.rooms}
```

Only when `feedsSources` lists `roomSchematicPlantButton`. Each room schematic names the plant that feeds it;
where that reference sits on the screen, how large it is and the crop region to read it from are in the screen
guide's `## Room schematics`. For each room image:

1. Read the feeding-plant reference from an upscaled crop (`python tools/crop-image.py {image} --region
   NAME=x0,y0,x1,y1 --scale 4`, region from the screen guide), never the full frame.
2. Identify the image's zone the way the screen guide says (header or room id); validate it against
   `spatial-hierarchy.json` `zones[].id` and the plant against `plant-point-mapping.json` `plants[].plantId`.
   An unknown id is a misread: re-crop and re-read.
3. Write one feeds entry, then go to the next image:

```bash
echo '{"plantId":"VE01","zoneIds":["Z_101"],"sourceImage":"rooms/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type feeds
```

**Save after each room image** (the tool merges each new zone into the plant's set).

### Stage 2c: Reconcile with the installation IFC (`installationIfc`)

Only when `feedsSources` lists `installationIfc`, after the image source (Stage 2 or 2b) is written. For each
file in the profile's `inputs.installationIfcs` (paths relative to `data/{buildingId}/`):

```
python tools/reconcile-feeds-ifc.py {buildingId} data/{buildingId}/<installation_ifc>
```

It derives plant → rooms → zones from the IFC's systems (system name → plant id by the profile's
`naming.ifcSystemPlant`) and reports, per plant, match / IFC-only / image-only. Review every IFC-only and
image-only line: re-read the image source for that zone (the room-schematic crop or the floorplan) before
changing anything, and state what you decided for each line in your reply to the user (feeds entries have no
note field: `update-connections.ts` stores only `plantId`, `zoneIds`, `sourceImage`, `confidence`). Disagreements are reviewed, not silently trusted to either source. IFC systems the alias does not map
are reported as unmapped, not guessed; the building's `notes` say which ones are known.

### Stage 3: Plant schematic images (batched by plant kind)

```
List: data/{buildingId}/{inputs.images.plants}
```

These show individual plant schematics. The building's dictionary `plantTokens` give each plant's kind
(ventilation, heating, cooling, fire-damper group, …); where each kind's references sit on the screen is in the
screen guide's `## Plant schematics`. Process them in batches by kind:

1. **Ventilation plants** — where the plant schematic lists the zones it serves, if it does (see the screen
   guide's `## Plant schematics`), read them to confirm which zones this AHU serves. Cross-check against the feeds data from
   Stage 2 / 2b. Also look for connected plants (cooling coil → chiller reference, heating coil → heating plant
   reference).

2. **Cooling plants** — look for which AHUs this chiller serves (pipe
   connections to ventilation or cooling units). Write as `--type serves`.

3. **Heating plants** — look for which plants this heating system serves.
   Write as `--type serves`.

4. **Sub-systems such as fire-damper groups** — the screen names the parent plant (where: the screen guide).
   Write as `--type hierarchy`.

5. **Other plants** — weather stations, alarm systems, electrical —
   typically have no cross-plant connections to record.

Validate every plant id against `plant-point-mapping.json` `plants[].plantId` before writing.

**For each plant image, write immediately after extraction:**

```bash
# Serves relationship from a chiller schematic
echo '{"plantId":"KO01","servesPlantIds":["VE01"],"sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type serves

# Hierarchy from a fire-damper group schematic
echo '{"plantId":"BSP01","parentPlantId":"VE01","sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-connections.ts {buildingId} --type hierarchy
```

### Stage 4: Validation pass

After all images are processed:

```bash
npx ts-node tools/update-connections.ts {buildingId} --validate
npx ts-node tools/update-connections.ts {buildingId} --summary
```

Check for:
- Unknown zone IDs (misreads from floorplans or room schematics)
- Unknown plant IDs (misreads from schematics; check against `plant-point-mapping.json` yourself, see the tool
  section)
- Self-references or circular hierarchy
- Low-confidence entries that need re-examination

Cross-check coverage:
- Are all zones from `spatial-hierarchy.json` covered by at least one feeds entry?
- Are all ventilation plants assigned to at least one zone?
- Electrical/lighting plants (their kind from `plantTokens`) legitimately have no zone feeds — they
  operate at building/floor level.

## Context discipline

Image extraction is context-heavy. Follow these rules to keep context lean:

1. **One image at a time.** Read image → extract data → write to tool → release
   image from context before reading the next one.

2. **Don't accumulate analysis.** After writing a connection, the data is on disk.
   You don't need to remember previous images' extractions — the tool merges
   automatically.

3. **Re-read state after batches.** After processing a batch of images (e.g. all
   floorplans), run `--summary` to refresh your understanding of what's been
   captured rather than relying on accumulated context.

4. **Resume safely.** If a session ends mid-processing, the next session can run
   `--summary` and `--validate` to see exactly what's been captured and what's
   missing. No image processing is lost.

## What this skill does NOT cover

- **Equipment extraction** from plant/zone schematics → the **equipment-inventory** skill
- **Brick classification** → the **brick-assign** skill (`classify-all.ts`)
- **Spatial hierarchy** (floors, rooms) → already in spatial-hierarchy.json
- **Point-to-TSDB mapping** → handled by point-mapping tools
- **TTL generation** → handled by the TTL generator that joins all focused files
