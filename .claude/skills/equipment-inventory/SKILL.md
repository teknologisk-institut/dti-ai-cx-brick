---
name: equipment-inventory
description: >
  Guides extraction of equipment and sensors from BMS room and plant schematic
  images for the AI-CX project. Writes to equipment-inventory.json — a focused
  file capturing what equipment is installed in each zone and plant, separate
  from the topology in building-connections.json. Covers room schematic images
  (one zone per image, showing VAV boxes, sensors, valves) and plant schematic
  images (one plant per image, showing fans, coils, heat exchangers), read with
  the building's own screen guide (profile bmsScreens) and notes. Use this skill
  whenever the user mentions extracting equipment from BMS images, processing
  room schematics, zone equipment inventory, sensor lists, VAV zone types, or
  populating equipment-inventory.json. Also trigger when the user mentions
  "room images", "zone schematics", "equipment extraction", "sensor inventory",
  or "what's installed in zone X".
---

# Equipment Inventory — Image Extraction Guide

## Purpose

This skill guides you through extracting equipment and sensor inventories from
BMS room and plant schematic images, writing the results to
`equipment-inventory.json`. The building topology (which plants serve which
zones) is already in `building-connections.json`. This skill fills in **what's
physically installed** — the fans, coils, dampers, valves, and sensors in each
plant and zone.

The method is the same for every building. How this building's screens look (header fields, crop regions, the
name of the heat-recovery block, the equipment ids on the screens) is in the building's own screen guide and
notes (see "Reference files to load").

Examples use the example building `DEMO-TS` (`skill-00-context.md`, "The example buildings"): plants `VE01`,
`VA07`, `KO01`, `BSP01` (under `VE01`), zones `Z_101`, `Z_102`; its equipment ids (`SFAN1`, `EFAN1`,
`HRU1`, `HCOIL1`, `CCOIL1`, `FLT1`, `DMP1`, `PMP1`, `VLV1`, `TS1`, …) are invented.

## Relationship to building-connections

The building-connections skill extracts topology from overview and floorplan
images. This skill extracts equipment from the same plant images (different
data) plus the room images. Run building-connections first — it establishes
which plants serve which zones, which this skill can cross-reference.

**Processing order across both skills:**
0. `update-equipment.ts --bms` — right after point mapping: the point-list items of every plant and zone
   (no images needed; below)
1. `building-connections` — plant overviews → floorplans / room-schematic feeds / IFC reconcile (by
   `feedsSources`) → plant schematics (topology); the room overviews are read earlier, in the point-mapping
   skill's zone↔room step
2. `equipment-inventory` — plant schematics (equipment) → room schematics (equipment)

## Reference files to load before starting

```
Read: data/{buildingId}/building-config.json                ← the profile: bmsScreens, notes, inputs.images
Read: data/{buildingId}/{bmsScreens}                        ← the building's screen guide (the profile's bmsScreens)
Read: data/{buildingId}/{each file in notes}                ← the building's image pitfalls and corrections
Read: data/{buildingId}/inputs/spatial-hierarchy.json      ← zone IDs, floor/room structure
Read: data/{buildingId}/inputs/plant-point-mapping.json    ← known plant IDs (plants[].plantId)
Read: data/{buildingId}/point-dictionary.json              ← plantTokens: each plant's kind
Read: data/{buildingId}/inputs/building-connections.json    ← topology context (which plant feeds which zone)
Read: data/{buildingId}/inputs/equipment-inventory.json     ← current state (may be empty)
```

Read the screen guide and every `notes` file **before the first image**. They say how this building's screens
look (where the header fields, plant references and labels are, which crop regions to use, what the heat-recovery
block is called) and which misreads happened before. This skill gives the method; the building's files give the
screen facts. A building whose profile declares images but no `bmsScreens` has no screen guide yet: draft it
first (skill-00 Step 0, which lists its sections) and re-write the profile with `write-building-profile.ts
{buildingId} --force`; do not read images without it.

The screen guide's `## Equipment id → type` table is guidance: if the screen shows something else, write what it shows.

Follow the **BMS Image Reading Protocol** and **Danish Language Awareness** in `skill-00-context.md`
(crop-first, skeleton pass, id validation) for every image.

Run the summary to see what's already captured:
```
npx ts-node tools/update-equipment.ts {buildingId} --summary
```

## The tool — update-equipment.ts

All writes go through this tool. It manages `equipment-inventory.json` with
upsert semantics (merges equipment lists when a zone/plant appears again).

The tool merges automatically — if a zone already has equipment from a previous
extraction (or from the point list, `--bms` below), new equipment items are added to the set (keyed by
equipment ID). Pass JSON via stdin to avoid shell escaping issues with non-ASCII characters (e.g. Danish ø, æ,
å). Image writes are `--type zone` / `--type plant` (example below); the point-list pass is `--bms`; validate
and summarise with:

```bash
npx ts-node tools/update-equipment.ts {buildingId} --validate
npx ts-node tools/update-equipment.ts {buildingId} --summary
```

### Example: the image writes (`DEMO-TS`)

Zone equipment (from a room schematic), then plant equipment (from a plant schematic, before touchpoint 1):

```bash
echo '{"zoneId":"Z_101","zoneType":"VAV zone","zoneFunction":"Office","controller":"CTRL-A","station":"ST-1","equipment":[{"id":"DMP1","type":"supply_inlet_damper"},{"id":"TR1","type":"temperature_sensor"}],"sourceImage":"rooms/<image>.png","confidence":"high"}' | npx ts-node tools/update-equipment.ts {buildingId} --type zone
echo '{"plantId":"VE01","systemType":"ventilation","equipment":[{"id":"SFAN1","type":"supply_fan"},{"id":"EFAN1","type":"exhaust_fan"},{"id":"HRU1","type":"heat_exchanger"}],"sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-equipment.ts {buildingId} --type plant
```

`ductPath`, `ductOrientation` and `medium` are written only after touchpoint 1 and the medium confirmation (the
full plant write is under Stage 1, "Write after each plant").

### Equipment items from the point mapping (`--bms`, before image extraction)

The point list proves which devices exist (those with points); images add devices without points and where
each device sits (`ductPath`, medium). So the point-list ("BMS") items are written for **every** plant and zone
in the mapping files, independently of images, by one pass that runs after point mapping and before any image
extraction:

```bash
npx ts-node tools/update-equipment.ts {buildingId} --bms
```

One rule for both routes: a point creates an item when the **token entry** of its id token in the building's
`point-dictionary.json` (`tokens.<zone|plant>.<token>`, else `tokens.any.<token>`) carries an
**`equipmentType`**; the item's `type` is that value (`damper`, `valve`, `pump`, `blind`, `occupancy`,
`temperature_sensor` …, the equipment-type vocabulary below), its `source` is `bms`. The item id is the
point's device: for a timeseries building the point abbreviation (a flattened suffix point is not its own
device), for a BACnet building `{token}{number}` from the point's id parts. A token without `equipmentType`
creates no item, and the dictionary's `notEquipment` list skips abbreviations outright. To make a token's
points equipment (or stop them being equipment), change its token entry through the point-mapping skill's
touchpoint 2, not this tool.

- **Self-device guard:** an item whose id equals the parent's own trailing device part (the plant *is* the
  device, e.g. a valve plant `RAD01_MV1` whose points would create item `MV1`) is not created; the pass prints
  these parents as `self-device skipped`.
- **Merge discipline:** the pass only adds ids not already present, never overwrites image-enriched fields
  and never removes an image item; it creates a plant or zone entry only when that entry gets at least one
  item. It is idempotent (a second run changes nothing). It records the run in `meta.bmsPass` against the
  plant mapping's `generatedAt`; `pipeline-status.ts` shows the step done when they match, so re-run it after
  every remap.
- **Image writes enrich:** `--type plant` / `--type zone` writes (below) keep merging as before: they add
  devices without points and the `ductPath`, `medium` and description of items the pass created.
- Sensor-type items (`temperature_sensor`, `air_quality_sensor`, …) are written like any item; they stay
  Point-class markers that the TTL never emits and that host no points, so they change no triple.
- Image extraction must not become the only way an item is written again: a plant or zone without a captured
  screen still gets the items its points prove.

The equipment class is decided at Step 5 from the item's `type`, its `medium` and its description; the
description reaches the class only through the building's word entries with `appliesTo: ["equipment"]`
(whole-word matches, cited in the dictionary like every other word).

### The equipment-type vocabulary

Write each item's `type` as one of the strings `classify-all.ts` knows (its `classifyEquipmentItem` type map
and `tools/lib/tag-match.ts` `EQUIPMENT_ANCHOR_TYPES` hold the full list). The common ones:

| Kind | `type` strings |
|---|---|
| Fans | `supply_fan`, `return_fan`, `exhaust_fan` |
| Heat recovery | `heat_exchanger` (plate / cross-flow unit, Exchanger), `heat_wheel` (rotary wheel, Wheel); `heat_recovery` is also classified as a Wheel |
| Coils | `heating_coil`, `cooling_coil` |
| Filters | `filter` |
| Dampers | `damper`, `supply_inlet_damper`, `fire_damper`, `outside_damper`, `exhaust_damper`, `mixing_damper` |
| Valves, pumps | `heating_valve`, `cooling_valve`, `valve`, `pump` |
| Units | `cooling_unit`, `chiller_compressor`, `storage_tank` |
| Blinds | `blind` |
| Sensor / setpoint markers | `temperature_sensor`, `temperature_setpoint`, `air_quality_sensor`, `presence_sensor`, `occupancy`, `diff_pressure_sensor` |

Which screen id is which type is the building's screen guide's `## Equipment id → type` (guidance, above). A
type outside the vocabulary is classified `HVAC_Equipment` and flagged; use the closest string above instead.

**Dampers take their position type on a plant duct.** A damper on a plant schematic gets its type from its
`ductPath`: `intake` → `outside_damper`, `exhaust` → `exhaust_damper`, any other position → `damper` (Brick has
no supply- or return-only damper class); a fire damper stays `fire_damper`. A damper on a room schematic (a VAV
damper) is `damper` or `supply_inlet_damper`, never a position type. Where a screen guide's id row says plain
"damper" for a plant damper, this rule still applies (`update-equipment.ts` normalises plant dampers the same way
on write).

**Equipment without an on-screen id** (e.g. an unlabelled coil drawn only as a symbol) is never written as an
item: an item's id is always one read from the screen or the point list, never made up. Record such equipment in
the building's `notes` (which plant, where on the screen, what the symbol is) instead.

## Image processing stages

Each stage reads the folder the profile's `inputs.images` names for it; a stage whose folder the profile does
not declare is skipped (the `--bms` pass above still runs).

### Stage 1: Plant schematics — equipment extraction

```
List: data/{buildingId}/{inputs.images.plants}
```

These are the same plant images used by the building-connections skill, but
here we extract **equipment** rather than topology. Process by plant kind (the building's dictionary
`plantTokens` give each plant's kind: ventilation, heating, cooling, fire-damper group, …). Where this building's
plant headers, labels and reference boxes sit is in the screen guide's `## Plant schematics`.

#### Plant title capture — do this for every plant image

Every plant schematic has a title header printed on the image itself (e.g. `VE01`'s "Air handling unit /
Office ventilation"). Read and record it verbatim as `plantName` on the plant entry — this is direct
transcription, not inference, the same evidential bar as reading an equipment ID label off the schematic. No
HITL confirmation needed (unlike `medium` below): if you can read the text, write it down.

This is the single most useful signal for catching a plant whose equipment was misclassified
against its own stated purpose (see `tools/audit-classes.ts`'s equipment audit, "EQUIPMENT MEDIUM
AUDIT" section, which reads `plantName` to check exactly this).

#### Controller/station capture — do this for every plant image, same header

The same title header may also carry the controller and station fields the screen guide names (where they sit:
the screen guide's `## Plant schematics`) — the same shape as the room schematic's own header (see Stage 2's
"Reading the room schematic header" below). Read and record them verbatim as `controller` and `station` on the
plant entry — direct transcription, same no-HITL-needed evidential bar as `plantName` above. Where the screen
guide says the plant header has no such fields, there is nothing to record.

**This is load-bearing pipeline input, not just annotation.** `classify-all.ts`'s Controller-
fallback routing (`resolvePointHost()`'s station-based branch) reads
`controller`/`station` off exactly this field to give a `*_System`-classed plant's admin/mode
points (plant state, operating mode, sanitation cycle — anything with no physical-equipment owner)
a valid Brick host. Skipping this for a `*_System` plant isn't a minor gap — every one of its
admin/mode points with no equipment owner will fail `validate-ttl`'s `system-hosts-point` check
until `controller`/`station` is captured and `classify-all.ts` rerun.

Same physical panel is shared across every plant it backs — don't be surprised when several plants
in the same plant room or riser report the same controller/station pair; that's expected, not a re-read
error.

##### Example: one plant header (`DEMO-TS`)

```
┌──────────────────────────────────────────────────────────────┐
│  Air handling unit         <controller field>: CTRL-A        │
│  VE01                                                        │
│  Office ventilation        <station field>: ST-1             │
└──────────────────────────────────────────────────────────────┘
```

The field labels and their positions are the screen guide's; the sketch shows only what is recorded:
`plantName` "Air handling unit / Office ventilation", `controller` `CTRL-A`, `station` `ST-1`.

#### Ventilation plants

Each AHU schematic shows a duct system with inline equipment. Read along the supply air path, then along the
return/extract path. Equipment appears as symbols inline with the duct; the equipment ID label is nearby — read
it carefully from a crop. Don't confuse the equipment ID with a measurement value (temperatures and pressures
are shown as numbers with units, often in a different colour; which colour on this building's screens: the
screen guide).

#### Duct/pipe orientation confirmation (HITL touchpoint 1) — do this FIRST

Every equipment item on a heating/cooling/DHW/ventilation plant (not fire-damper groups, which
never carry `ductPath`) needs a `ductPath` field capturing its physical position. Before
enumerating equipment on any such plant image, confirm the plant's orientation legend with the
human — once per image, not re-derived per equipment item:

1. **Check first whether this plant already has a human-confirmed `ductOrientation`** (a re-run
   of an already-processed image) — if so, skip straight to walking the equipment list per the
   existing legend; don't re-propose.
2. Read the full image and form a proposed orientation legend, using the reading procedures
   below (ventilation vs. water plants).
3. State the legend **and your reasoning**, grounded in the schematic's own labeled elements —
   specific equipment IDs, their relative positions, live values (e.g. "`TS2` reads 60°C,
   `TS1` reads 45°C — `TS2` is the shared main's raw supply, `TS1` is the local loop's own
   supply after the mixing shunt"). Never vague spatial terms like "top-right." Print the
   image's absolute path in plain text when referencing it (most terminals make a printed path
   clickable) — don't launch an image viewer unprompted.
4. The human confirms or corrects, via a structured prompt (not open-ended free text alone).
5. Only once confirmed, walk the equipment list and assign each item's `ductPath`
   deterministically from the now-settled legend, and write the legend itself via
   `ductOrientation` (schema below) before writing equipment.

**Confirming `ductPath` here does not, by itself, change any point's Brick class.** This pipeline
is not reactive — `update-equipment.ts` (this step) and `classify-all.ts` (Step 5 of the pipeline)
are separate script runs, each reading/writing files on disk; nothing watches
`equipment-inventory.json` for changes. `classify-all.ts`'s point classifier uses an equipment's
`ductPath` as the point's strongest source after a per-point override (the `ductPath` level of the
per-part combination, brick-assign skill; a suffix point uses its base point's item) — but only when
it actually runs. If this plant has already been through Step 5 before (its
equipment already has `brickClass` values), rerun `npx ts-node tools/classify-all.ts {buildingId}
--only equipment` and `--only points` after materializing the confirmed `ductPath` — otherwise the
confirmation sits correctly on disk but has no classification effect until someone happens to
rerun Step 5 for an unrelated reason. Already-`reviewedManually` entities are correctly skipped by
this rerun (frozen by design); everything else refreshes to reflect the newly-confirmed `ductPath`.

**Every relevant plant image gets this — not just ones where signals disagree.** Always propose
first; never a blind human pass, never silent solo inference.

**Boundary-vs-loop role stays with equipment type/class, not this legend.** This step establishes
physical fremløb/returløb direction only — it does not decide whether equipment plays a
"boundary" role (Entering/Leaving) or "loop" role (Supply/Return) in the final Brick
classification; that comes from the equipment's own Brick class elsewhere in the pipeline.

**Headless batch runs** (`tools/run-equipment-extraction.ts`) have no human, so they do neither confirmation:
their plant prompt writes no `ductPath`, `ductOrientation` or `medium` and skips a plant whose entry already has
a `ductOrientation`. Run touchpoint 1 and the medium confirmation interactively for those plants afterwards.

##### Reading procedure — ventilation plants

The heat-recovery unit (what this building's screens call it, and where it sits: the screen guide's
`## Plant schematics`) is the center reference point.

```
INTAKE ──→ [FLT1] ──→ [HRU1] ──→ [HCOIL1] ──→ [CCOIL1] ──→ [SFAN1] ──→ SUPPLY
                        ↕
EXHAUST ←── [EFAN1] ←── [HRU1] ←── [FLT2] ←── [DMP2] ←────────── RETURN
```

| ductPath value | Position | Which equipment typically |
|---|---|---|
| `intake` | Before the heat recovery on the outside-air side | intake filter (`FLT1`), outside-air damper (`DMP1`) |
| `preheat` | Between the heat recovery and the heating coil on the supply side | Preheat coil if present |
| `supply` | After the heat recovery on the supply side (toward rooms) | supply fan (`SFAN1`), post-recovery coils (`HCOIL1`, `CCOIL1`) |
| `return` | After rooms, before the heat recovery on the return side | return filter (`FLT2`), return damper (`DMP2`) |
| `exhaust` | After the heat recovery on the exhaust side (to outside) | exhaust or return fan (`EFAN1`) |

1. Find the heat-recovery unit — the center reference.
2. Equipment on the **outside-air side** before the heat recovery = `intake`.
3. Equipment on the **room side** after the heat recovery on the supply duct = `supply`.
4. Equipment on the **room side** before the heat recovery on the return duct = `return`.
5. Equipment on the **outside-air side** after the heat recovery on the exhaust duct = `exhaust`.
6. If a preheat coil exists between the heat recovery and the main heating coil = `preheat`.

The signal cross-checks for dense screens (supply/extract side marker, temperature gradient, skeleton-crop
method) are in `skill-00-context.md`'s "BMS Image Reading Protocol" — read that first when the screens need
them. This building's crop regions and the corner→stream layout of its screens are in the screen guide.

##### Reading procedure — water plants (any heating/cooling/DHW circuit)

No fixed geometry like the heat-recovery-centered method above — real topology varies (a simple loop with
one pump/valve pair, a mixing shunt, a primary/secondary heat-exchanger interface with four
meaningful positions). This is a discovery checklist, not a decision tree:

1. **Identify the reference structure.** Boundary equipment (a heat exchanger, a meter) if
   present; otherwise the loop's own circulation pump/valve, or a mixing shunt.
2. **Discover this schematic's actual signals** — don't assume a color scheme or line-style
   convention from another building or plant. Look for whatever's actually there: color, line
   style, flow-arrow glyphs, live-value thermal plausibility (supply reads hotter than return —
   this is physics, not a building convention), and any text already captured from a prior pass.
3. **Reason about function, not just position.** A mixing loop, a shunt with a check valve, or a
   primary/secondary exchanger interface all place "supply"/"return" meaning at a different
   topological scale than raw pipe position suggests (example below).
4. **State the proposal plainly** — what's confident vs. inferred — and let the human confirm or
   correct.

###### Example: a mixing loop (`DEMO-TS` `VA07`)

`VA07` is a mixing loop — a shared heating main feeds a local radiator circuit through a shunt with a check
valve and mixing valve (`VLV1`); `TS1`'s cooler reading vs. `TS2`'s hotter reading reflects the local loop's
post-mix supply vs. the shared main's raw supply, not resolvable from pipe position alone.

##### Water positions on items

Each item on a water plant gets the `ductPath` of its position. A plant that is an **interface** between two
circuits (a heat exchanger, a hot-water tank with a heating coil) puts every item on a **side**; a plain or mixing
loop uses `water_supply` / `water_return`. `classify-all.ts` reads the value on the item, not the legend text:

| `ductPath` | Where it sits | What the classifier does with it |
|---|---|---|
| `water_supply` / `water_return` | a plain loop or a mixing loop (a shunt is not an interface) | Supply / Return (Entering / Leaving on a DHW plant) |
| `primary_supply` / `primary_return` | the district or heating side of an exchanger or of a tank's coil | the district-facing port: supply = Entering, return = Leaving; the plant's `Domestic` is not carried to this side |
| `secondary_supply` / `secondary_return` | the building side of an exchanger | the downstream port: supply = Leaving, return = Entering |
| `dhw_supply` / `dhw_circulation_return` | the domestic side of a DHW exchanger or tank | supply = Leaving, circulation return = Entering |
| `dhw_makeup` | the cold-water feed into a DHW exchanger or tank | no direction |

- Write the side on **every** item of an interface plant: pumps, valves and sensors. A sensor's own side gives its
  points their direction, ahead of the description words.
- A sensor in the body of a tank or exchanger (the tank temperature) gets no `ductPath`: it measures the device.
- The exchanger or tank is the plant's `ductOrientation.referenceEquipment` and must be an item. A point on a side
  with no pump or valve is hosted on it, with that side's polarity. `update-equipment.ts --validate` warns when
  the reference is not an item, and when a legend names sides but items carry `water_*`.
- The legend's keys use the same values (`primary_supply`, `dhw_supply`, …).
- **An item's id is its point-list device id.** Where the screen labels the device differently, the item keeps the
  point-list id and the screen's label goes in `screenLabel`, written only after the user has confirmed the link
  with its evidence (description, live value; say when the object export and the screenshot are from different
  times, which weakens a value match). An item written earlier under the screen label is replaced in the same
  write with `"removeIds": ["<screen label>"]`. A device whose points sit on another plant gets its position on
  that plant's entry, not here.

##### Persisted schema — `ductOrientation`

Written once per plant image via `update-equipment.ts --type plant` (the `ductOrientation` field,
alongside `systemType`) — see the tool's own header comment for the exact write shape. `source` is
always `"human-confirmed"`; `legend` keys reuse `ductPath`'s own value vocabulary for simple cases,
or plant-specific names for boundary/exchanger interfaces (never a parallel naming scheme).

Simple loop (e.g. `VA07` — one pump/valve pair, no boundary equipment):
```json
"ductOrientation": {
  "source": "human-confirmed",
  "referenceEquipment": "VLV1",
  "legend": {
    "water_supply": "solid line, sourced from the shared main, past the mixing shunt toward PMP1",
    "water_return": "dashed line, flows toward the shared main; TS3 reads the post-mix return"
  }
}
```

Boundary/exchanger interface (primary/secondary, four meaningful positions):
```json
"ductOrientation": {
  "source": "human-confirmed",
  "referenceEquipment": "HX1",
  "legend": {
    "primary_supply": "enters left, ~90°C, into the exchanger",
    "primary_return": "exits left, ~40°C, away from the exchanger",
    "secondary_supply": "exits right of exchanger toward PMP1, TS1 ~55°C",
    "secondary_return": "enters right of exchanger from downstream consumers, TS2 ~30°C"
  }
}
```

Ventilation (four-position, tied to the heat-recovery unit, e.g. `VE01`):
```json
"ductOrientation": {
  "source": "human-confirmed",
  "referenceEquipment": "HRU1",
  "legend": {
    "supply": "post-HRU1, room side",
    "return": "pre-HRU1, room side",
    "intake": "pre-HRU1, outside-air side",
    "exhaust": "post-HRU1, outside-air side"
  }
}
```

This field is provenance/audit only — it does not change what `classify-all.ts` reads (still only
ever each equipment item's own `ductPath`). It's consumed by: (a) this skill itself, on re-run, to
know an image is already human-confirmed and skip re-asking; (b) a future audit, as the record of
who established ground truth and how; (c) `update-equipment.ts --validate`'s rollout-progress
tracking (flags plants with `ductPath`-tagged equipment but no `ductOrientation` yet).

The ductPath value itself is still critical for downstream Brick classification — it determines
whether a temperature sensor becomes `Supply_Air_Temperature_Sensor`,
`Return_Air_Temperature_Sensor`, `Intake_Air_Temperature_Sensor`, etc.

#### Equipment medium confirmation (HITL) — plant equipment only

Every equipment item **on a plant image** (not zone/room images — see scope note below) whose
physical role is one of `Pump`, `Storage` (tank), `Valve`, `Coil`, or `Exchanger` needs a `medium`
field: `'hot' | 'chilled' | 'domestic' | 'cold' | 'condenser'`. Fans, dampers, and filters are
air-path with no medium ambiguity; chillers are refrigerant-side, out of scope here.

**Scope note:** this touchpoint is plant-only, matching `ductPath`'s own existing plant-only
precedent. Zone equipment (e.g. a room's heating valve `VLV1` in `Z_101`) is not covered — the schema field
is available everywhere, but the extraction protocol doesn't ask for it in Stage 2, since zone
valves are single-medium by convention (a radiator loop) and none of the real bugs that motivated
this touchpoint involved zone equipment.

Reuse `ductPath`'s own protocol shape exactly — propose with grounded reasoning, let the human
confirm or correct, then write:

1. **Cross-check at least two independent signals** before proposing a reading:
   - Pipe color-coding, when the diagram uses it (e.g. a pipe pair in two colours).
   - Temperature values printed near the pipe — physics constrains which medium plausibly runs
     that hot/cold.
   - Danish medium words wherever they appear in the image or already-captured text — not only on
     valve labels, which is the only place the older `desc.includes('varme'/'køl')` matching ever
     looked.
   - Position relative to a heat-exchanger boundary — the same geometric logic the `ductPath`
     skeleton-crop method already uses for supply/return.
2. **State the proposed reading and the reasoning**, grounded in the schematic's own labeled
   elements — same standard as touchpoint 1's "specific equipment IDs, relative positions, live
   values" requirement, never vague spatial terms.
3. **The human confirms or corrects.**
4. **Write `medium` on the equipment item** alongside its other fields (same JSON payload as the
   rest of the plant's equipment list — no separate write step).

**This can override the equipment's own `type`-implied intent.** A `heating_valve` whose confirmed
`medium` is `chilled` is not a contradiction to resolve before writing — it's exactly the signal
this touchpoint exists to capture (the `type` label may itself be a mis-extraction from an earlier
pass; `medium`, captured with this rigor, is treated as the stronger evidence downstream). See
`tools/lib/tag-match.ts`'s `deriveEquipmentTags` for how it's consumed.

**Two intentional no-ops, so a carefully-confirmed reading isn't mistaken for a wasted one:** on an
`Exchanger`, any `medium` value other than `'condenser'` has no classification effect (the
Water_/Air_Cooled_Condenser_Heat_Exchanger distinction is controlled by description text about
which side is cooled, not by `medium`); and on a `Coil`, `'condenser'`/`'cold'` currently have no
effect beyond what description text already provides (no Condenser-tagged Coil class exists in the
Brick index today). Confirm and write `medium` anyway — it's still the correct evidence to capture,
even where today's matcher doesn't yet have a more specific class to reach with it.

#### System type tagging (systemType)

Each plant entry must include a `systemType` field indicating the plant's
primary function:

| systemType | When to use |
|---|---|
| `ventilation` | AHU with fans and duct system |
| `heating` | Hot water circuit |
| `cooling` | Chilled water or cooling circuit |
| `chiller` | Chiller unit with compressor |
| `dhw` | Domestic hot water system |
| `mixed` | Plant serves multiple functions (rare) |

The plant's kind is in the building's dictionary `plantTokens`. Confirm it from the schematic: if it has fans
and ducts → `ventilation`; if it has pumps, valves, and radiator/coil circuits with no fans → `heating` or
`cooling` based on whether it feeds heating coils or cooling coils.

#### Cooling plants

Use `systemType: "cooling"` (or `"chiller"` if the plant has a compressor). Determine `ductPath`
using the "Reading procedure — water plants" method above — don't assign `water_supply`/
`water_return` from position alone without confirming the legend with the human first.

Typically a chiller unit with pipe connections (what this building's cooling screens show: the screen guide's
`## Plant schematics`). Equipment:
- Compressor, condenser fan, evaporator
- Pumps (e.g. `PMP1`, `PMP2`) — use `ductPath: "water_supply"` or `"water_return"`
- Temperature sensors on supply/return pipes — use `ductPath: "water_supply"` / `"water_return"`

#### Heating plants

Use `systemType: "heating"`. Determine `ductPath` using the "Reading procedure — water plants"
method above — don't assign `water_supply`/`water_return` from position alone without confirming
the legend with the human first.

Typically heating circuits with:
- Pumps, mixing valves (e.g. `VLV1`) — use `ductPath: "water_supply"` or `"water_return"`
- Temperature sensors on flow/return — use `ductPath: "water_supply"` / `"water_return"`
- Expansion vessels

#### Fire-damper groups

Show individual damper positions (e.g. `BSP01` under `VE01`). Equipment is the dampers themselves; how this
building's fire-damper screens lay them out is in the screen guide's `## Plant schematics`.

**Write after each plant** (`DEMO-TS` `VE01`, after touchpoint 1 and the medium confirmation):
```bash
echo '{"plantId":"VE01","systemType":"ventilation","plantName":"Air handling unit / Office ventilation","controller":"CTRL-A","station":"ST-1","ductOrientation":{"source":"human-confirmed","referenceEquipment":"HRU1","legend":{"supply":"post-HRU1, room side","return":"pre-HRU1, room side","intake":"pre-HRU1, outside-air side","exhaust":"post-HRU1, outside-air side","water_supply":"pump/valve side feeding the heating/cooling coils from the plant room","water_return":"pump/valve side returning from the coils"}},"equipment":[{"id":"SFAN1","type":"supply_fan","ductPath":"supply"},{"id":"EFAN1","type":"exhaust_fan","ductPath":"exhaust"},{"id":"HRU1","type":"heat_exchanger"},{"id":"CCOIL1","type":"cooling_coil","ductPath":"supply","medium":"chilled"},{"id":"HCOIL1","type":"heating_coil","ductPath":"supply","medium":"hot"},{"id":"FLT1","type":"filter","ductPath":"intake"},{"id":"FLT2","type":"filter","ductPath":"return"},{"id":"DMP1","type":"damper","ductPath":"intake"},{"id":"DMP2","type":"damper","ductPath":"return"},{"id":"PMP1","type":"pump","ductPath":"water_supply","medium":"hot"},{"id":"VLV1","type":"heating_valve","ductPath":"water_supply","medium":"hot"},{"id":"VLV2","type":"cooling_valve","ductPath":"water_supply","medium":"chilled"}],"sourceImage":"plants/<image>.png","confidence":"high"}' | npx ts-node tools/update-equipment.ts {buildingId} --type plant
```

Note: The heat-recovery unit doesn't need a ductPath — it **is** the
reference point. Pumps and valves on coil water circuits get `water_supply`
or `water_return`.

### Stage 2: Room schematics — zone equipment

```
List: data/{buildingId}/{inputs.images.rooms}
```

These show individual zone schematics. Each image covers one zone. There may be several zone types with
different equipment configurations. How this building's room screens look (header fields, where the ducts,
sensors, valves and the parent-plant reference sit, crop regions) is in the screen guide's
`## Room schematics`.

#### Reading the room schematic header

The header carries the zone's metadata. Extract the zone type, the zone id, the zone function, and the
controller and station fields the screen guide names, as far as this building's header has them.

##### Example: one room header (`DEMO-TS`)

```
┌──────────────────────────────────────────────────────────────┐
│  VAV zone                  <controller field>: CTRL-A        │
│  Z_101                                                       │
│  Office                    <station field>: ST-1             │
└──────────────────────────────────────────────────────────────┘
```

- **Zone type** — "VAV zone"
- **Zone ID** — `Z_101` (validate against `spatial-hierarchy.json` `zones[].id`)
- **Zone function** — "Office"
- **Controller** — `CTRL-A`
- **Station** — `ST-1`

#### Reading the room schematic body

The schematic shows a room with, typically:

- **Duct connections** — supply and extract ducts with their VAV dampers, connecting to the parent AHU.
- **A parent-plant reference** — a box or button naming the feeding plant (e.g. `VE01`, `VA07`). Not
  zone equipment (pitfall 2).
- **Room sensors** — temperature (current reading in °C), temperature setpoint, air quality / CO2 (ppm),
  presence (active/inactive).
- **Heating** — a heating valve on the radiator circuit (valve position in %).

Different zone types have different equipment sets; the screen guide may list the typical sets. Don't memorize
them — read what's actually in each image. Some zones have extra equipment not in any list.

Use the type strings of "The equipment-type vocabulary" above, with the screen guide's `## Equipment id → type`
as guidance.

**Write after each room image** (one `--type zone` write per image).

##### Example: one room image's write (`DEMO-TS`)

```bash
echo '{"zoneId":"Z_101","zoneType":"VAV zone","zoneFunction":"Office","controller":"CTRL-A","station":"ST-1","equipment":[{"id":"DMP1","type":"supply_inlet_damper"},{"id":"DMP2","type":"damper"},{"id":"VLV1","type":"heating_valve"},{"id":"TR1","type":"temperature_sensor"},{"id":"TR1_SP","type":"temperature_setpoint"},{"id":"AQ1","type":"air_quality_sensor"},{"id":"OCC1","type":"presence_sensor"}],"sourceImage":"rooms/<image>.png","confidence":"high"}' | npx ts-node tools/update-equipment.ts {buildingId} --type zone
```

### Stage 3: Validation pass

After all images are processed:

```bash
npx ts-node tools/update-equipment.ts {buildingId} --validate
npx ts-node tools/update-equipment.ts {buildingId} --summary
npx ts-node tools/validate-ductpath.ts {buildingId}
npx ts-node tools/audit-classes.ts {buildingId}
```

`audit-classes.ts`'s "EQUIPMENT MEDIUM AUDIT" section (report D) is the `medium`-equivalent of
`validate-ductpath.ts` — run it after any plant pass, not just once at the end. Its
**contradictions** list needs a human to resolve (capture the flagged item's real `medium`, or fix
it directly via `assign-brick.ts` if it's clearly wrong); its **corrections** list is informational
only, already applied automatically. Note: its checks read each equipment item's already-committed
`brickClass`, which stays stale until `classify-all.ts` reruns and picks up a newly-captured
`medium` — run `audit-classes.ts` again after the "rerun classify-all.ts" step below if you captured
any `medium` values this session, not only immediately after `update-equipment.ts`.

`validate-ductpath.ts` is a regression check, not the primary confirmation mechanism — it catches
a `ductPath` disagreeing with an equipment's own supply/extract side marker in its id (the profile's
`naming.airDirectionMarker`), the same mechanical cross-check useful even after orientation is
human-confirmed (a human could still enter something inconsistent, or a future re-extraction could
silently overwrite a confirmed value).

**If any plant/zone processed this session already had Step 5 (Brick classification) run on it
before — check `--summary`'s equipment `brickClass` counts, or just track it as you go — rerun
`npx ts-node tools/classify-all.ts {buildingId} --only equipment` and `--only points` before
considering this pass done.** Confirming `ductPath` (touchpoint 1) only updates
`equipment-inventory.json`; it has no effect on any point's Brick class until `classify-all.ts`
actually reads it back. Skipping this leaves confirmed orientation data sitting inert.

Check for:
- Unknown zone or plant IDs (misreads; `--validate` checks zone ids against `spatial-hierarchy.json`; check
  plant ids against `plant-point-mapping.json` `plants[].plantId` yourself, as skill-00 protocol step 4)
- Zones with no equipment (missed images)
- Equipment type consistency across similar zones
- `validate-ductpath.ts` mismatches (side marker disagrees with assigned `ductPath`)

Cross-check against building-connections:
- Every zone in a feeds entry should have a zone equipment entry
- Every plant should have a plant equipment entry

## Continuous processing

This skill is designed for batch processing — work through all images in each
stage without stopping. The save-per-image pattern means progress is never lost.
`npx ts-node tools/run-equipment-extraction.ts {buildingId} --stage rooms|plants --dry-run` prints how many
images there are and how many are already processed (or list the profile's `inputs.images.*` folders).

**For room images:** Process sequentially. Read one image, extract
the zone equipment, write via the tool, then move to the next image. After
every 15-20 images, run `--summary` to check progress and reset context.

**For plant images:** Process by plant kind batch (ventilation first, then cooling, heating, fire-damper
groups). After each batch, run `--summary`.

**Resuming:** If a session ends mid-processing, the next session runs
`--summary` to see what's captured, then continues with remaining images.
The tool's upsert semantics mean re-processing an image is safe — it just
updates the existing entry.

## Context discipline

Room images are repetitive — most share the same layout with minor variations.
Keep context lean:

1. **One image at a time.** Read → extract → write → release before the next.
2. **Don't accumulate.** The tool stores everything on disk. You don't need to
   remember previous zones' equipment.
3. **Batch summaries.** After 15-20 room images, run `--summary` to refresh
   your count rather than tracking mentally.
4. **Skip duplicates.** If `--summary` shows a zone already has equipment,
   skip its image unless you need to verify.

## Known pitfalls

1. **Measurement values vs equipment IDs** — The schematic shows both equipment
   labels (e.g. `TR1`) and measurement values (e.g. "21.5 °C") near sensors.
   The equipment ID is the label, not the number. Values are often in a different colour (the screen guide).

2. **Parent plant references are NOT equipment** — A box naming `VE01` or `VA07` on a room schematic
   indicates the parent plant connection, not equipment in the zone. These relationships are in
   building-connections.json, not here.

3. **Setpoint vs sensor** — `TR1_SP` (setpoint control) and `TR1` (temperature
   reading) are separate equipment items. Include both.

4. **Equipment ID suffixes** — Some zones have numbered variants (`DMP1`, `DMP2`,
   `VLV1`, `VLV2`). Each is a separate equipment item.
