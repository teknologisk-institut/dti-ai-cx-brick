---
name: brick-assign
description: >
  Assign Brick (nightly) ontology classes to building entities (plants, equipment,
  floors, rooms, zones, and points) by writing brickClass directly into the
  source data files. Use this skill whenever the user asks to classify entities,
  assign Brick classes, map BMS data to Brick ontology, or asks which Brick
  class an entity should get. Also trigger when the user mentions
  "brick assign", "Brick classification", "assign classes", "brickClass",
  "classify-all", or wants to know why something was classified a certain way.
---

# Brick Assignment Skill

Assigns Brick (nightly) classes to every entity in a building by adding a
`brickClass` field directly into the source data files. Each entity's
classification lives next to its data — no separate assignments file.

## Primary workflow: classify-all.ts

For bulk classification of all entities, use the programmatic tool:

```bash
# Dry-run: see stats and flagged items without writing
npx ts-node tools/classify-all.ts {buildingId} --dry-run

# Full run: classify and write to all source files
npx ts-node tools/classify-all.ts {buildingId}

# Classify only one section
npx ts-node tools/classify-all.ts {buildingId} --only plants
npx ts-node tools/classify-all.ts {buildingId} --only equipment
npx ts-node tools/classify-all.ts {buildingId} --only spatial
npx ts-node tools/classify-all.ts {buildingId} --only zones
npx ts-node tools/classify-all.ts {buildingId} --only points
```

classify-all.ts reads all source data files and the building's `point-dictionary.json` (one shape,
`schemaVersion: 3`; it stops without it for points, plants and equipment), classifies every entity, and
writes brickClass + confidence (plus the parts and flags below) into every entity — **except any entity with
`reviewedManually: true`, whose class it never touches** (see "Manually-reviewed entities are frozen" below). It
reports high/low counts, point flags by kind, unknown unit strings, and lists flagged plants and unclassified
plant points.

**Use classify-all.ts first**, then fix what it flags: a wrong dictionary entry in the dictionary
(point-mapping skill, touchpoint 2), a single entity with assign-brick.ts.

### Manually-reviewed entities are frozen against reclassification

Any entity `assign-brick.ts` has ever written to — plant, zone, equipment, floor, room, point, or
subpoint — gets `reviewedManually: true`. From that point on, **every** `classify-all.ts` write
site checks this flag first and skips the entity unconditionally, on any future full run or
`--only` run, forever. This is **intentional, not a bug**: human judgment outranks automated
re-inference until a human deliberately revisits the entity via `assign-brick.ts` again — even if
better upstream evidence (e.g. a newly-extracted `ductPath`) later becomes available for it.
**If you're asked to do a "full reclassify" of a building that has had any manual
review pass (including HITL touchpoint 3), know that `classify-all.ts` will silently leave every
previously-reviewed entity untouched** — this is expected, and not something to "fix" by editing
`classify-all.ts` to ignore the flag. A reviewed point's `pointHost` (pure structure) is still recomputed,
and so are its `tags` and `partSources` (so its tags reach the TTL): its parts are combined like any point's,
then every tag that contradicts a decided part its reviewed class settles is dropped (for each decided part the
class's tags carry a value for, the point's other values of that part go; so does a frame tag, Entering/Leaving
or Supply/Return, whose opposite the class carries), with the source of any part left
without a tag. Its `brickClass`, `confidence`, `brickNote`, `reviewNote`, `needsReview` and `classFlags` are
never written.

The freeze survives a remap: a mapper run with `--force` carries every reviewed point and plant over by
`bmsPointId` / `plantId`, and whole reviewed plants or zones the remap no longer produces (point-mapping
skill, "How to run"). To move reviewed points onto better classes after a dictionary change, use the cause
groups below, never a blanket un-review.

## Single-entity writes: assign-brick.ts

For individual corrections or manual overrides (ids from `DEMO-TS`, skill-00 "The example buildings"):

```bash
# Plants
npx ts-node tools/assign-brick.ts {buildingId} --type plant --id VE01 --class "Air_Handling_Unit"
npx ts-node tools/assign-brick.ts {buildingId} --type plant --id BSP01 --class "Fire_Safety_Equipment" --note "Fire-damper group"

# Plant points (single; --point is the point's pointAbbreviation)
npx ts-node tools/assign-brick.ts {buildingId} --type plant-point --plant VA07 --point TF1 --class "Leaving_Hot_Water_Temperature_Sensor"

# Plant points (batch — reads JSON from stdin). Points are flat: a suffix point's pointAbbreviation is only
# its suffix (`SP` for VA07_TF1_SP), so name it by bmsPointId (single mode takes the first point with
# that abbreviation; batch mode skips an ambiguous one without bmsPointId)
echo '[{"plant":"VA07","point":"SP","bmsPointId":"VA07_TF1_SP","class":"Leaving_Hot_Water_Temperature_Setpoint"}]' | npx ts-node tools/assign-brick.ts {buildingId} --type plant-point --batch

# Zones
npx ts-node tools/assign-brick.ts {buildingId} --type zone --id Z_101 --class "rec:HVACZone"

# Zone points (batch)
echo '[{"zone":"Z_101","point":"TR1","class":"..."}]' | npx ts-node tools/assign-brick.ts {buildingId} --type zone-point --batch

# Equipment
npx ts-node tools/assign-brick.ts {buildingId} --type equipment --parent VE01 --id SF1 --class "Supply_Fan"

# Equipment (batch)
echo '[{"parent":"VE01","id":"SF1","class":"Supply_Fan"}]' | npx ts-node tools/assign-brick.ts {buildingId} --type equipment --batch

# Spatial
npx ts-node tools/assign-brick.ts {buildingId} --type floor --id level-1 --class "rec:Level"
npx ts-node tools/assign-brick.ts {buildingId} --type room --id "1.01" --class "rec:Office"
```

## Where brickClass is written

| Entity type | File | Fields written |
|------------|------|-------------|
| Plants | `data/{id}/inputs/plant-point-mapping.json` | `brickClass`, `tags`, `partSources`, `classFlags` (when flagged) on each plant entry |
| Plant points | `data/{id}/inputs/plant-point-mapping.json` | `brickClass`, `confidence`, `tags`, `partSources`, `classFlags`, `classificationAlternatives`, `needsReview`, `pointHost` on each point |
| Device points (BACnet) | `data/{id}/inputs/plant-point-mapping.json` `devices[].points` | as plant points; `pointHost` is always the device's controller (`{deviceInstance}\|{deviceName}`) |
| Zones | `data/{id}/inputs/zone-point-mapping.json` | `brickClass` on each zone entry |
| Zone points | `data/{id}/inputs/zone-point-mapping.json` | as plant points (no `pointHost`) |
| Equipment | `data/{id}/inputs/equipment-inventory.json` | `brickClass` on each equipment item |
| Floors | `data/{id}/inputs/spatial-hierarchy.json` | `brickClass` on each floor entry |
| Rooms | `data/{id}/inputs/spatial-hierarchy.json` | `brickClass` on each room entry |

A point's `tags` are every Brick tag its parts gave it (the TTL keeps them all, "Every tag reaches the TTL"
below); `partSources` names, per decided part, the source that decided it (`<level>:<entry path>`, e.g.
`"role": "suffix:suffixes[19]"`); `classFlags` lists its flags (`{ kind, detail }`). `brickNote` is written
only by the binary guards and by human review (assign-brick `--note`), and on equipment, floors and rooms with
no exact class.

## Data sources for classification decisions

| File | What it provides |
|------|-----------------|
| `ontologies/brick-classification-index.json` | Full Brick (nightly) class dictionary — keys are prefixed (`brick:Air_Handling_Unit`, `rec:Level`); class tags, parents, `equivalentClass` |
| `data/{id}/point-dictionary.json` | Every token, suffix, word, unit, override, plant token and plant override, with the Brick tags it contributes (point-mapping skill, "The one shape") |
| `data/{id}/building-config.json` | `naming`: the id grammar (`idParts`) and `plantToken` |
| `data/{id}/inputs/plant-point-mapping.json` | Plants with BMS points: `idParts`, `danishDescription`, `tsdb` (`units`, `objectType`, BACnet `stateTexts`); `semanticMeaning` is a label only. BACnet: also `devices` (controller-wide device points, same fields) |
| `data/{id}/inputs/zone-point-mapping.json` | Zones with BMS points: same fields |
| `data/{id}/inputs/equipment-inventory.json` | Equipment per zone/plant: `id`, `type`, `description`, `source`, `ductPath`, `medium`, plant `plantName`, `systemType` |
| `data/{id}/inputs/building-connections.json` | `plantServesPlant` chain — water context (hot/chilled/DHW) for the host routing |
| `data/{id}/inputs/spatial-hierarchy.json` | Floors (`id` `level-{n}`, `name`, `elevation_mm`, `levelNumber`) and rooms (`id`, `name`, `source` `ifc`/`documents`), written by `match-zone-rooms.ts` |

## Route differences

One mechanism classifies both routes: the same dictionary shape, the same sources and the same matcher.
What differs is only where a point's inputs come from:

- **Timeseries:** the id splits with `naming.separator`/`pointToken`; units are TSDB symbols (dictionary
  `units` entries); `objectType` values like `AnalogInput`; image `ductPath`s and the equipment inventory are
  usually present.
- **BACnet:** the id's point part splits with `naming.pointParts`; units are standard BACnet unit names (the
  generic table; `no-units` counts as no unit); `objectType` values like `analog-value`/`binary-input`; state
  texts are a source (word entries with `appliesTo: ["stateText"]`); vendor device registers are ordinary
  dictionary entries (there is no vendor-specific source); device points (`devices`) are classified with the
  same parts and no plant tags, hosted by their controller; `equipment-inventory.json` and
  `building-connections.json` are optional (without them a plant has no composition check and points have no
  image `ductPath`).

## Classification logic summary

### Plants: classification from parts

`tools/lib/plant-class.ts` `classifyPlant`, called by classify-all for every unreviewed plant, shortest plant
id first:

1. **Plant override** (`plantOverrides.<plantId>`): its tags decide the class; nothing else is read.
2. **Own tags**: the plant-token entry (`plantTokens.<token>`, the token cut by the profile's
   `naming.plantToken`) plus every word entry with `appliesTo: ["plantName"]` found whole-word in the plant's
   own `plantName` (from its image; never the descriptions of its points).
3. **Parent plant**: the longest other plant id this id starts with (then the separator). Its class's medium
   tags (Air, Water, Hot, Chilled, Domestic) rank the candidates: a valve on a heating circuit becomes
   `Hot_Water_Valve`, on a ventilation plant `Valve`.
4. The class is the Brick Equipment or System class that carries **every own tag** (convention-only tags such
   as `District` are kept on the plant but not matched), most parent tags kept, then fewest tags.
5. **Image equipment composition** (the plant's equipment types in `equipment-inventory.json`: supply fan +
   return/exhaust fan or coil → `Air_Handling_Unit`; exhaust fan without supply fan → `Exhaust_Fan`; only fire
   dampers → `Fire_Safety_Equipment`; compressor/cooling unit → `Chiller`) is the **check** when a token
   entry exists (a different class is flagged `level-conflict`, the token decides) and the **decider** when
   there is no token entry. With no source at all the plant is `Equipment`, flagged `no-source`.

Written: `brickClass`, `tags` (own tags + the parent tags the class kept), `partSources` (`plantTokens.<t>`,
`words[i]`, `parent`, `equipment` or `plantOverrides.<id>`), `classFlags` (`level-conflict`, `tie`,
`no-source`). A flagged plant counts as low in the summary and is listed. A plant the sources cannot separate
gets a `plantOverrides` entry through the dictionary review.

The parent (step 3) is found from the id alone: a valve that is a plant of its own, id
`{circuitId}{sep}{valve}`, starts with its circuit's id and the separator, so it takes the circuit's medium
tags. A valve plant whose id does not start with its circuit's id needs a `plantOverrides` entry. So does a
plant whose own sources misread it, e.g. a meter whose objects look like a valve.

A plant's class tags then reach its points as the lowest-level source (the plant's medium and water kind), and
a plant whose `tags` carry `District` gives its boundary points the District frame (water direction, below).

### Equipment

**Matcher-primary, same architecture as points (`classifyEquipmentItem` in `classify-all.ts`):**
`deriveEquipmentTags(type, description, sys, medium, words)` (`tools/lib/tag-match.ts`) derives a Brick
tag-set from the equipment's `type`, its free-text `description` (through the building's word entries with
`appliesTo: ["equipment"]`, matched whole word), the parent plant's system type, and — when captured — the
equipment's own `medium` field; `matchEquipmentClass` matches that tag-set against Brick's own per-class tags
(largest eligible subset wins). The `type → class` table below is the **fallback only**, reached when the
matcher abstains (unrecognized `type`, no anchor). The equipment `type` itself comes from the image
extraction, or for BMS items from the point's token entry `equipmentType` (equipment-inventory skill).
Equipment classes never land on points: a point gets a point class and hangs on its equipment.

**`medium` is authoritative when present** — a human-confirmed `medium` (`'hot' | 'chilled' |
'domestic' | 'cold' | 'condenser'`, see equipment-inventory/SKILL.md's "Equipment medium
confirmation" touchpoint) overrides both the `type`-implied Heat/Cool intent (Valve/Coil) and
description/`sys` text-matching (Pump/Storage) — `type` is assigned by ID-naming convention at
extraction time with no independent cross-check, so a verified `medium` outranks it. How many of a
building's equipment items carry a captured `medium` is per-building state:
`npx ts-node tools/pipeline-status.ts {buildingId}` prints `review: equipment medium on N of M plant
equipment items` when the building has an equipment inventory. While N is 0 this branch is merged code that changes
nothing for that building.

Fallback `type → class` table (reached only on matcher abstain). Pump, valve, damper, wheel and exchanger
types never get here: their plain anchor class (`Pump`, `Valve`, `Damper`, `Heat_Wheel`, `Heat_Exchanger`)
carries no other tag, so the matcher always finds a class.

| equipment.type | Default Brick class | Context override |
|---------------|-------------------|-----------------|
| `supply_fan` | `Supply_Fan` | — |
| `return_fan` / `exhaust_fan` | `Return_Fan` / `Exhaust_Fan` | — |
| `heating_coil` | `Heating_Coil` | — |
| `cooling_coil` | `Cooling_Coil` | — |
| `blind` | `Blind` | — (the matcher has no anchor for it, so the table decides; a BMS item from a token entry with `equipmentType: blind`) |
| `temperature_sensor` (a sensor marker) | `Temperature_Sensor` | refined by the description's equipment word entries: the Sensor point class within the base and word tags that keeps the most word tags (e.g. a [Water] word → `Water_Temperature_Sensor`) |
| `damper` / `fire_damper` | `Damper` / `Damper` | Brick (nightly) still has NO `Fire_Damper`; fire dampers use `Damper` |
| `outside_damper` / `exhaust_damper` | `Outside_Damper` / `Exhaust_Damper` | AHU intake / atmosphere-exhaust dampers (normalized by `update-equipment` from the `ductPath`, else the description's equipment word entries: [Fire] keeps the type, [Outside]/[Intake] → outside, [Exhaust] → exhaust, [Mixed] → mixing; zone VAV dampers stay `Damper`) |

### Rooms and storeys: classes from dictionary words

No room or storey word is in code. `classify-all.ts` `classifyRooms`/`classifyFloors` call
`tools/lib/room-class.ts` (the same module `match-zone-rooms.ts` uses), which reads the building's dictionary
word entries (point-mapping skill, "Zone↔room matching", step 1):

- **Rooms:** the `appliesTo: ["roomName"]` entry whose phrase matches the room's name whole-word, longest phrase
  first, gives its `recClass`. No match → `rec:Room` (counted as low in the summary). A word inside a longer
  word does not match, so each distinct name the building uses needs its own entry where it should classify.
- **Storeys:** below elevation 0 → `rec:BasementLevel`; a `storeyName` entry with a `recClass` (e.g. the roof
  storey's word → `rec:RoofLevel`) gives that class; otherwise `rec:Level`. Level numbers and floor ids
  (`level-{n}`, `level-m{n}`) come from elevation alone (written by `match-zone-rooms.ts`).
- **Exclusions:** a `storeyName` or `spaceCategory` entry with `exclude: true` removes storeys/spaces that are
  not real floors or rooms (e.g. a storey used only as an authoring work plane, IFC spaces that are only area
  objects) before numbering; they never reach `spatial-hierarchy.json`.
- **Use groups:** `useGroup` entries (`recClasses`: the room classes a schedule/use group fits) are not used
  for classification; they drive the zone↔room `useGroup` check.

To change a room's class, change or add the dictionary word (draft → review → promote) and re-run
`classify-all.ts`; for one room only, `assign-brick.ts --type room` (frozen as `reviewedManually`). A room
created from the documents (`source: "documents"`) is classified the same way from its name.

### Zones

All BMS-controlled zones → `rec:HVACZone` (the non-deprecated REC class; `brick:HVAC_Zone` is
deprecated in Brick (nightly) — see **Brick (nightly) conventions** below).

### Points: classification from parts

A Brick point class is role + quantity + medium + stream + subject + qualifiers. Each point's **parts** come
from separate sources; each part is decided by its best source; Brick's own class tags pick the class. Every
word, token, suffix and unit symbol the parts come from is a dictionary entry with evidence. Language
knowledge still in classify-all's code (a known limitation): the water host routing's description/`semanticMeaning` direction
fallback (below). Pipeline per unreviewed point (classify-all `classifyPointFromParts`):

1. `collectContributions` (`tools/lib/point-parts.ts`): every dictionary entry that matches the point
   contributes its tags at its level (no first-match winner).
2. `combineParts` (`tools/lib/tag-match.ts`): per part, the first level in the source order that has a
   contribution decides it; every other tag is pooled; the generic conventions are applied; flags are raised.
3. `matchPointClass`: the Brick class that the combined tags support best.

#### The source order, and why

| Level | Source (`partSources` prefix) | Typically decides | Why at this position |
|---|---|---|---|
| 1 | `override` — `overrides.<full point id>` | anything | a human decision for this exact point |
| 2 | `ductPath` — the image `ductPath` of the point's equipment item (a suffix point uses its base point's) | stream, medium | image-based, per point, confirmed at HITL touchpoint 1 |
| 3 | `suffix` — `suffixes[i]` on the id's suffix parts | role, qualifiers | per point, structured |
| 4 | `desc` — `words[i]` in the description | any part | per point, rich, but free text and sometimes copied wrong |
| 5 | `token` — `tokens.<ctx>.<token>` | quantity, subject, the bare point's role | shared by every point with that token |
| 6 | `unit` — unit entries / the generic BACnet unit table, and state-text words | quantity; On/Off, fault | partial (`%` is ambiguous) |
| 7 | `plant` — the owning plant's class tags | medium, water kind | describes the whole plant |

The order was measured on both buildings before it was fixed. The object type is **not** a
source (dampers and valves read as `AnalogInput` would wrongly become sensors); it feeds the consistency
checks only.

**Within one level:** among id suffixes the part nearer the end of the id wins (`Z_101_TR1_SP_AL`: `AL` over `SP`);
among description words a phrase that contains another wins over it; two words that disagree on the role and
do not contain each other are a **word clash**: flagged, and the role is left to the next level. Two different
values at the same position at any level are flagged `level-conflict` (the first one is kept).

#### The decided parts and the conventions

- **Decided parts** (first level wins): role (`Sensor`, `Setpoint`, `Command`, `Status`, `Alarm`, `Parameter`;
  `On`/`Off` belong to the role), quantity, medium (`Air`/`Water`), water kind (`Hot`/`Chilled`/`Domestic`),
  stream (`Supply`, `Return`, `Exhaust`, `Outside`, `Intake`, `Zone`, `Mixed`), subject (`Valve`, `Damper`,
  `Fan`, `Pump` …), intent (`Heat`/`Cool`), occupancy (`Occupied`/`Unoccupied`/`Standby`). **Every other tag**
  (Min, Max, Limit, Deadband, Run, Time, Fault, Mode, Position …) is a union over all contributions.
- A suffix that sets a role replaces the token's role **and its On/Off**. A role-less On/Off contribution
  from a lower level (state texts) **refines** a decided `Status`/`Command` whose source carries neither.
- A decided `Hot` is refined by a lower level's `Domestic` (domestic hot water is hot water).
- **Generic conventions**, after combining: `Supply` → +`Discharge`; `Limit` with `Setpoint` → +`Parameter`;
  `CO2` with `Sensor` → +`Level`; a plain zone air temperature setpoint (zone point, no Heat, Cool, Effective,
  Deadband, Max or Min) → +`Target`; the **water frame** from the host routing (below) replaces a water
  point's Supply/Return.
- **Role fallback**: a point with a quantity and no role gets `Sensor`, confidence low, flag `role-fallback`.
  A point with neither role nor quantity becomes `Point`, low, flag `no-role` (the dictionary review lists these
  as open coverage items, so they should not reach classification).
- There is **no** "zone point → Air" or "air pressure → Static" default; those parts come from entries.

#### The matcher (`matchPointClass`)

- **The role is required, the quantity is not** (`Fault_Status`, `Enable_Command`, `Mode_Status` are
  reachable without one). A class is eligible when it carries a decided role tag and every one of its tags is
  among the point's tags.
- **Defining tags:** the class that keeps the most tags of the source that decided the role ranks first, then
  the larger class, then more core tags, then the deeper class. A point with `Deadband` only takes a Deadband
  class when one is eligible.
- **Alias classes** (tagless classes with an `equivalentClass`, e.g. `Run_Time_Sensor` ≡ `On_Timer_Sensor`) take
  the equivalent class's tags; at equal rank the class with its own tags wins.
- **No class holds all the point's tags** is normal, not an error: the tags are kept on the point and in the
  TTL, and the point is **not** flagged.
- `classificationAlternatives`: equivalent classes, then the next two eligible classes.

#### Flags, confidence and `needsReview`

| Flag (`classFlags[].kind`) | Raised when | Effect |
|---|---|---|
| `trade-off` | other eligible classes keep a decided part or a role-source tag the pick drops, while the pick keeps one they drop (the detail lists each class with the tags it keeps) | **flag only**: no `needsReview`, no lower confidence (user decision 2026-11-03); shown in touchpoint 3's view |
| `tie` | another class ranks exactly equal (and is not an equivalent) | `needsReview` |
| `word-clash` | description words disagree on the role (role left to the next level) | confidence low, `needsReview` |
| `role-fallback` | quantity, no role → `Sensor` | confidence low, `needsReview` |
| `no-role` | neither role nor quantity → `Point` | confidence low, `needsReview` |
| `level-conflict` | two values at the deciding level and position | `needsReview` |
| `binary-mismatch` | binary object type with a continuous `*_Sensor` class | `needsReview` (and the guard below) |
| `analog-onoff` | non-binary object type with an `On_Off_*` class | `needsReview` (and the guard below) |
| `unit-quantity` | the unit's quantity differs from the decided quantity | `needsReview` |

`confidence` is `high` unless a `role-fallback`/`word-clash`/`no-role` flag or a binary guard made it `low`.
`needsReview` is set by any flag except `trade-off`, by low confidence, and when the water host routing took
the point's direction from its description text instead of an equipment `ductPath` (a leftover of the old
meaning-text scan; a known limitation). The gate for a building is its count of low and `needsReview` points.

**Binary guards (write-time, both routes):** after matching, a binary-family object type (`binary-value`/
`binary-input`/`BinaryInput`/`BinaryValue`) with a continuous-measurement `*_Sensor` class is reset to
`Point`, `low`, with `brickNote` "demoted: binary objectType conflicts with continuous Sensor class <X>"
(`isBinarySensorMismatch()`); Brick's legitimately binary sensors (`BINARY_SENSOR_ALLOWLIST`:
`Occupancy_Sensor`, `Contact_Sensor`, `Motion_Sensor`) **and their subclasses** (e.g. `PIR_Sensor`) are allowed.
A binary-implying class (`On_Off_Status`, `On_Off_Command`, `Fault_Status`, `Alarm`) on a confirmed
non-binary object is likewise demoted to `Point` (`isNonBinaryCommandMismatch()`), and on a point with no
object type gets `low` with a note (`isUngroundedBinaryClaim()`). `validate-ttl.ts`'s own binary/Sensor
guardrail only sees `objectType` via `bacnet:object-type` triples, so it is blind to timeseries buildings;
the write-time guard is the one that covers both.

**Gap this doesn't cover, and what does:** `classify-all.ts`'s `reviewedManually` guard skips a reviewed
point *before* these checks run, so a reviewed point is never re-checked on a later rerun. `assign-brick.ts`
itself (single and batch mode, plant-point and zone-point writes) runs the same `isBinarySensorMismatch()` check
at write time and prints a loud `WARNING:` to stderr if a human-entered `class` looks like a mismatch — but it
still applies the write. The reviewer's judgment is never silently overridden.

#### Every tag reaches the TTL (`brick:hasTag`)

`generate-ttl.ts` emits each point's `tags` as one `brick:hasTag` list (`@prefix tag:
<https://brickschema.org/schema/BrickTag#>`, e.g. `brick:hasTag tag:Air, tag:Damper, tag:Fire,
tag:Position, tag:Status`), so a part that no Brick class holds (a fire damper's Fire, a damper command's
Supply and Air) is kept in the model. `validate-ttl.ts` accepts the `tag:` namespace. A reviewed point's
`tags` are its combined tags minus those that contradict a decided part of its reviewed class (see
"Manually-reviewed entities are frozen"), so they reach the TTL too.

#### Water direction: the host routing (unchanged by the parts)

Water temperature naming is **equipment-role-based** (2026-08-16), not medium-only. classify-all resolves each
plant point's host (`pointHost`) and its raw supply/return direction, and turns them into the frame tags:
- Loop's own circulation equipment (pump/valve on that one loop) → `Supply`/`Return`
- Boundary-interface equipment (heat exchanger, chiller, meter) → `Leaving`/`Entering`
  (supply/fremløb = leaves the boundary; return/returløb = enters it); a primary-side (`primary_*` ductPath) point the
  other way round, and on a DHW plant without the plant's Domestic tag
- Points with no physical-equipment owner (Controller-hosted) → no directional tag
- DHW has no `Supply_`/`Return_` variant at all (only `Entering_`/`Leaving_`), even for loop-hosted points
- `District` is added with Leaving/Entering when the plant's `tags` carry it
- A suffix point is hosted like its base point when its own abbreviation finds no equipment
- The full routing algorithm (`pointHost` resolution) this depends on is `resolvePointHost` in
  `classify-all.ts`

The frame tags replace the point's Supply/Return when the point is a water point; dictionary entries never
carry them.

Air duct path examples (image `ductPath`, level 2):
- `ductPath: "supply"` → `Supply_Air_Temperature_Sensor`
- `ductPath: "return"` → `Return_Air_Temperature_Sensor`
- `ductPath: "exhaust"` → `Exhaust_Air_Temperature_Sensor`
- `ductPath: "intake"` → `Intake_Air_Temperature_Sensor`

#### Suffix points (flat)

Points are flat: a CSV suffix such as `_SP` (`Z_101_TR1_SP`) is flattened by the mapper into a self-contained sibling
point, not a subpoint of its base. A suffix point is classified like any other point: its `idParts` carry the
base token and the suffix, so the token entry, the suffix entries, the point's own description words and its
base point's `ductPath` all contribute, and the suffix decides the parts it states (usually the role). There is
no suffix table in code: to change a suffix point's class, fix the dictionary entry that decided the wrong part
(its `partSources` name it) through the point-mapping skill, then remap and reclassify.

#### Example: one point's parts

`VE01_TI1_SP` of `DEMO-TS` (skill-00, "The example buildings"), invented description "Setpunkt indblæsning
drift", no image `ductPath` on `TI1`: the plant-context token `tokens.plant.TI` gives [Supply, Air, Temperature,
Sensor], the suffix `SP` gives [Setpoint] and decides the role (it replaces the token's Sensor), and two
description words decide the stream ([Supply], ranked above the token's own Supply) and the occupancy
([Occupied]); the Supply convention adds Discharge. `partSources`: role `suffix:suffixes[0]`, quantity and
medium `token:tokens.plant.TI`, stream and occupancy `desc:words[i]`. The
pick is `Supply_Air_Temperature_Setpoint`, flagged `trade-off` against `Occupied_Air_Temperature_Setpoint`
(each keeps a decided part the other drops); Occupied stays in `tags` and reaches the TTL. Had the token left
Air out, the parent plant's class tags would give the medium (`VE01` → Air, medium `plant:plant`) and the pick
would be the same.

### After a dictionary change: class changes by cause group

When a dictionary change moves many classes (or before promoting a new dictionary), judge the changes by
**cause group**, not point by point:

```bash
npx ts-node tools/compare-classes-by-cause.ts <buildingId> --before <inputsDir> --after <inputsDir> [--out <file.md>]
npx ts-node tools/apply-class-verdicts.ts <buildingId> --groups <groups.json> --verdicts <verdicts.json>
```

- `compare-classes-by-cause.ts` (read-only) compares every point's class between two inputs dirs (a
  reviewed point's before class is its reviewed class) and groups the changes by (before class → after class,
  the entry that decided the role). It prints counts per verdict (same / more specific / less specific /
  different / flagged) and flag counts per kind for both sides; `--out` writes the groups (largest first, every
  point id) as Markdown and, beside it, the same groups as JSON.
- The human judges each group **better** or **worse**. A worse group is fixed in the dictionary and
  re-measured; a point with an unknown cause is judged on its own.
- `apply-class-verdicts.ts` applies the verdicts (`{ "<group key>": "better" | "worse" }`) to the current
  mapping files: a reviewed point in a better group takes the group's new class and a `reviewNote`
  "cause group <key> approved <date>"; every other reviewed point keeps its class.
- `tools/diff-pointclass.ts <a> <b>` remains the by-id class diff for a single write-back batch.

## HITL Touchpoint 3: low-confidence classification review

**Standard, non-skippable step of this skill's guided flow** — runs immediately after any
`classify-all.ts` invocation that actually writes point classifications (a full run, or
`--only points`), whether that's a first full onboarding pass or a later incremental
reclassification. Does **not** trigger on `--dry-run` (nothing persisted yet) or any other
`--only` value (`plants`/`equipment`/`spatial`/`zones` alone never write point `confidence`).

### 1. Group the points to review

```bash
npx ts-node tools/group-low-confidence.ts {buildingId}
```
Read-only, regenerates fresh every time — never trust a group list from an earlier session, the
population shrinks as review lands and grows as new data is added. The population is every point with
`needsReview`, `confidence: 'low'`, or a `trade-off` flag. Points are grouped by **(flag kinds, decided
parts)**: the decided parts are the point's `partSources`, so one group is one combination of deciding
entries. Each sample shows the point's class, tags, `partSources` and `classFlags`. If it reports an
`INCONSISTENCY` error, stop and fix the tool before using its output for review.

### 2. For each group, find the cause before proposing

The `partSources` say which entry decided each part, and the flags say what went wrong:
- `trade-off` / `tie`: the detail lists the rival classes and the tags each keeps. Choose the class that keeps
  the part that matters for this point; the matcher's other candidates are in `classificationAlternatives`.
- `role-fallback` / `no-role`: no source gave a role; find the word or suffix that should.
- `word-clash` / `level-conflict`: two entries disagree; one of them is too broad.
- `binary-mismatch` / `analog-onoff` / a demoted `Point`: the class contradicts the object type.
- `needsReview` with no flag: the water direction came from the description, not from an equipment
  `ductPath` (check the host, `pointHost`, and the plant's `ductPath` legend), or a binary guard set
  `brickNote`.

Reason against `ontologies/brick-classification-index.json`'s tags/definitions, and cross-reference
`equipment-inventory.json`/`building-connections.json` for `ductPath`/water context on the group's sample ids.

**Homogeneity check, before proposing one verdict for the whole group:** identical deciding entries can still
mean different things in different physical contexts (the same setpoint phrase on a heating plant vs. a
cooling plant). Check the group's samples share physical context before writing one answer across the whole
group. If they don't agree, split the group and review the sub-groups separately.

Always state a verdict — confirm current class / propose a more specific class / fix an entry / flag as
genuinely ambiguous — before asking. Never hand the human a raw group with no proposal.

### 3. Present in batched conversational rounds

Several groups' verdicts per round, plain conversational text with a confirm/correct pattern —
not a tool-enforced per-round cap. Exact batch size is a judgment call per session.

### 4. Write back — never edit `classify-all.ts` or any other shared tool

- **The cause is a dictionary entry** (wrong for every point it decides, e.g. a stream tag on a token whose
  points span streams, a missing role word): fix the entry through the point-mapping skill's touchpoint 2
  (loop-back), remap with `--force` (reviews carried over) and reclassify. This fixes the whole group and the
  next building's drafting learns from it.
- **A decision for these points only:** write it per point. Through `assign-brick.ts` batch mode for a class
  verdict, or through an `overrides.<full point id>` dictionary entry when the point's tags should change too.
  **BACnet device points** (`plant-point-mapping.json` `devices[].points`) cannot be written by `assign-brick.ts`
  (it looks up `plants[]` only; a known limitation). Review one today by an `overrides.<full point id>` dictionary entry
  (touchpoint 2 loop-back, then `map-points --force` and `classify-all`), or, for a point already
  `reviewedManually`, by a cause-group verdict through `apply-class-verdicts.ts` (it reads `devices`).
- **Confirmed correct as-is:** promote `confidence` to `'high'`, no class change (pass the
  point's existing `brickClass` back as `class` — batch mode validates that `class` is present
  on every entry and skips any entry that omits it, so this is a required same-value write, not
  optional). This is what makes review non-repeating: confirmed points leave the review population for good,
  and `reviewedManually` (set automatically by `assign-brick.ts`) protects them from being reset by a future
  `classify-all` rerun or remap.
- **A pattern that looks systemic beyond this building's dictionary** (a generic convention seems wrong):
  data-level correction for the current building, **and report the pattern to the human** (changing a generic convention is a code change). Never implemented inline
  during review.

Example batch write-back for a confirmed group (pass the JSON via a file and shell redirect for
large batches — an inline `echo` argument gets unwieldy past a handful of points):
```bash
npx ts-node tools/assign-brick.ts {buildingId} --type zone-point --batch < /path/to/batch.json
```

The `batch.json` file should contain an array of points with explicit `confidence` field:
```json
[{"zone":"Z_101","point":"TR1","class":"Zone_Air_Temperature_Sensor","confidence":"high"}]
```

Each object requires the `confidence` field — omitting it leaves the point's old (possibly `'low'`) confidence unchanged, defeating the review's purpose. Adjust zone/point/class to match the actual entities being written back.

### 5. Verify before considering the pass done

```bash
npx ts-node tools/generate-ttl.ts {buildingId}
npx ts-node tools/validate-ttl.ts {buildingId}
```
Confirm no *new* `binary-objecttype-vs-sensor` errors appeared versus the count before this
review pass started — a bad verdict reintroducing that exact failure shape is the mechanism's
own worst case, and this check is cheap defense-in-depth against it. **This check is blind to timeseries
buildings** (see "Binary guards" above — `validate-ttl.ts`'s guardrail only sees `objectType` via
`bacnet:object-type` TTL triples): for them this step gives no signal either way, and the real protection is
`assign-brick.ts`'s own write-time warning, not this post-hoc check.

Also available: `tools/diff-pointclass.ts <before-snapshot> <after-file>` — a read-only,
by-`bmsPointId` class diff. Copy the building's point-mapping file before a write-back batch,
then diff it against the post-write file to confirm the batch touched exactly the intended
points' classes and nothing else (it does not track confidence-only changes, so a same-value
confirm write reports no "change" — that's expected).

## Brick (nightly) conventions (no deprecated classes)

The model uses **only non-deprecated** Brick (nightly) classes — `validate-ttl` **errors** on any deprecated
class (its index excludes them). The classifier emits the replacements directly:

| Deprecated (do NOT emit) | Use instead |
|---|---|
| `brick:HVAC_Zone` | `rec:HVACZone` |
| `brick:Room` | `rec:Room` |
| `brick:Zone_Air_Temperature_Setpoint` | `Target_Zone_Air_Temperature_Setpoint` by the plain-setpoint convention; `Heating_`/`Cooling_`/`Effective_…` and `Temperature_Deadband_Setpoint` when the point's tags carry Heat, Cool, Effective or Deadband (from its word or suffix entries) |
| `*_Supply_*` / `*_Return_*` water-temp sensor naming | See "equipment-role-based" rule above — not a fixed Leaving/Entering swap anymore |
| `Domestic_Hot_Water_Supply_Temperature_{Sensor,Setpoint}` | `Leaving_Domestic_Hot_Water_Temperature_{Sensor,Setpoint}` (DHW has no `Supply_`/`Return_` variant at all) |

The matcher only picks classes from the index, which excludes deprecated ones.

**Water direction is equipment-role-based, not a fixed medium swap** (2026-08-16). Within the
Entering/Leaving branch specifically: **supply / fremløb → `Leaving_*`**, **return / returløb →
`Entering_*`** (water *leaves* the boundary as supply, *returns to / enters* it) — the **opposite** of
a load/coil frame. See `skill-00-context.md`'s "Water Supply/Return vs Entering/Leaving" rule; the
full mechanism is the water host routing in `classify-all.ts`. Deprecated-class set: nightly has **255** deprecated classes vs
1.4.4's 251 — not identical; re-verify any class in this table against
`ontologies/brick-classification-index.json` (now built from nightly) rather than assuming it transfers
unchanged.

## Incremental updates

To reclassify a subset:
- **New plant**: run `classify-all.ts --only plants` then `--only equipment` then `--only points`
- **New zone**: run `classify-all.ts --only zones` then `--only points`
- **Dictionary change**: promote it (point-mapping skill), remap with `--force` (reviews carried over), run
  `classify-all.ts`, and judge class changes by cause group (above)
- **Individual fix**: use `assign-brick.ts` for the specific entity
- **Full reclassify**: run `classify-all.ts` (rewrites every entity that is *not*
  `reviewedManually` — see "Manually-reviewed entities are frozen" above; a manually-reviewed
  entity is never touched by this, by design)

## Quality checks

1. **Flagged items** — classify-all.ts lists flagged plants and unclassified points, and counts point flags
   by kind
2. **Review population** — `needsReview` / `confidence: "low"` points: touchpoint 3 (`group-low-confidence.ts`)
3. **Generic fallbacks** — `rec:Room`, `Point`, `Equipment`, `HVAC_Equipment` = check `classFlags` / `brickNote`
4. **Unknown units** — the summary's unknown unit strings: add a unit entry if the unit names a quantity
5. **Coverage** — compare entity counts against source files
