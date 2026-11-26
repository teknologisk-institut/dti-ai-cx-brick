---
name: generate-ttl
description: >
  Generate a Brick (nightly) TTL (Turtle) file from classified building data for
  import into GraphDB. Use this skill whenever the user asks to generate TTL,
  create a Brick model, export to GraphDB, produce an ontology file, build
  a semantic model, or asks about the TTL output format. Also trigger when the
  user mentions "generate-ttl", "building.ttl", "GraphDB", "Turtle file",
  "RDF export", or wants to query/visualize building relationships.
---

# Generate TTL Skill

Produces a single `data/{buildingId}/outputs/building.ttl` file that encodes the full
Brick (nightly) semantic model for a building. The TTL is built in five layers,
each adding a different type of triple. The tool `tools/generate-ttl.ts`
handles all generation.

## Quick start

```bash
# Generate full TTL
npx ts-node tools/generate-ttl.ts {buildingId}

# Generate only specific steps (for debugging)
npx ts-node tools/generate-ttl.ts {buildingId} --steps 1,2,3

# Generate subgraph for one entity and its connections
npx ts-node tools/generate-ttl.ts {buildingId} --entity {plantId}
```

Output: `data/{buildingId}/outputs/building.ttl`

## Prerequisites

Before generating, all source files should have `brickClass` assigned.
Run `npx ts-node tools/classify-all.ts {buildingId}` first if not done.

## Data sources

| File | Used in steps | What it provides |
|------|--------------|-----------------|
| `data/{id}/inputs/plant-point-mapping.json` | 1, 3, 5 | Plants and their flat points with brickClass + TSDB ids (`tsdb.id`); BACnet: also `devices` (controller-wide device points) |
| `data/{id}/inputs/zone-point-mapping.json` | 1, 3, 5 | Zones and their flat points with brickClass + TSDB ids (`tsdb.id`) |
| `data/{id}/inputs/equipment-inventory.json` | 1, 3 | Equipment with brickClass, grouped by parent plant/zone |
| `data/{id}/inputs/spatial-hierarchy.json` | 1, 2, 4 | Zone-centred: building, floors, rooms with brickClass + floorId, and `zones[]` (`id`, `status`, `roomIds`, `floorId`, `name?`) |
| `data/{id}/inputs/building-connections.json` | 4 | plantFeedsZone, plantServesPlant, plantHierarchy |
| `ontologies/brick-classification-index.json` | 1 | Class verification + prefix URIs |
| `ontologies/brick-relationship-index.json` | all | Relationship definitions, TSDB reference pattern |
| `inputs.devices` from the building profile (bacnet buildings; usually `inputs/devices.csv`) | 5 | BACnet device registry → `ref:BACnetReference` |

Do NOT use building_model.json, building_dialect.json, or any phase-based files.

**Optional inputs (both data shapes):** `equipment-inventory.json` and
`building-connections.json` are optional — generate-ttl runs without them (a building with no
image extraction just has no equipment parts, no `feeds`/`serves`/`hierarchy`). See the
**BACnet differences** notes inline in Steps 4–5 below.

---

## Step 1: Entity declarations

Every entity gets a type assertion triple: `bldg:X a prefix:Class .`

The building-specific namespace is `bldg:` with URI `urn:{buildingId}/`.

### URI naming conventions

Examples use `DEMO-TS` (skill-00, "The example buildings").

| Entity | URI pattern | Example |
|--------|-----------|---------|
| Building | `bldg:Building` | `bldg:Building a rec:Building` |
| Floor | `bldg:{floorId}` (sanitised; ids like `level-m1`, `level-0`) | `bldg:level_1 a rec:Level` |
| Room | `bldg:room_{number}` | `bldg:room_1_01 a rec:Office` |
| Zone | `bldg:{zoneId}` | `bldg:Z_101 a rec:HVACZone` |
| Plant | `bldg:{plantId}` | `bldg:VE01 a brick:Air_Handling_Unit` |
| Equipment | `bldg:{parentId}_{equipId}` | `bldg:VE01_SF1 a brick:Supply_Fan` |
| Point | `bldg:{bmsPointId}` | `bldg:VA07_TF1 a brick:Leaving_Hot_Water_Temperature_Sensor` (boundary-role water point; loop-role points get `Supply_`/`Return_` instead — see brick-assign's water direction rule) |

Points are flat: a suffix point such as `Z_101_TR1_SP` is a point of its own (`bldg:Z_101_TR1_SP`), on the
same parent as `Z_101_TR1`, never a point of it.

Room numbers contain dots (e.g., "1.01") — replace dots with underscores in URIs
to avoid Turtle parsing issues: `bldg:room_1_01`.

### Prefix resolution

The `brickClass` field in source files stores classes without namespace prefix
for `brick:` classes (e.g., `"Air_Handling_Unit"`) but with prefix for `rec:`
classes (e.g., `"rec:BasementLevel"`).

Resolution rules:
- If brickClass starts with `rec:` → use as-is (it's a RealEstateCore class)
- Otherwise → prepend `brick:` (it's a Brick class)

Verify each class exists in `brick-classification-index.json` before emitting.
If missing, fall back to a generic parent class and add an `rdfs:comment`.

### Human-readable labels

Add `rdfs:label` triples for key entities using meaningful names:
- Floors: use the `name` field (e.g., "Level 1")
- Rooms: use `name` + `id` (e.g., "Office 1.01")
- Plants: use plantId (e.g., "VE01"), followed by the title half of the plant's `plantName` in
  equipment-inventory.json in parentheses when it has one (e.g., "VE01 (Air handling unit)")
- Zones: `"{id} {name}"` from `zones[].name` when present (e.g., "Z_101 Office 1.01"), else the zoneId alone

### Point tags (brick:hasTag)

Every point's `tags` (written by classify-all, brick-assign skill) are emitted as one sorted `brick:hasTag`
list in the Brick tag namespace (`@prefix tag: <https://brickschema.org/schema/BrickTag#>`), e.g.
`brick:hasTag tag:Air, tag:Damper, tag:Fire, tag:Position, tag:Status`. A part no Brick class holds stays in
the model this way; `validate-ttl.ts` accepts the namespace.

---

## Step 2: Spatial hierarchy

Build the containment tree: Building → Floors → Rooms.

Data source: `inputs/spatial-hierarchy.json`
- `building.name` → building label
- `floors[].id` + `floors[].brickClass` → floor entities
- `rooms[].id` + `rooms[].floorId` + `rooms[].brickClass` → room entities

Floor levels can also get `rec:levelNumber` from `floors[].levelNumber`.

### Example: spatial triples of `DEMO-TS`

```turtle
bldg:Building a rec:Building ;
    rdfs:label "Demo timeseries building" .

bldg:level_1 a rec:Level ;
    rdfs:label "Level 1" ;
    rec:levelNumber 1 ;
    rec:isPartOf bldg:Building .

bldg:room_1_01 a rec:Office ;
    rdfs:label "Office 1.01" ;
    rec:isPartOf bldg:level_1 .
```

(Example values only; ids and names come from the data.)

---

## Step 3: Equipment and point hierarchy

Three relationship types connect equipment and points to their parents:

### Plant → Equipment (hasPart / rec:includes)

```turtle
bldg:VE01 brick:hasPart bldg:VE01_SF1 .
```

`rec:includes` instead of `hasPart` for any plant classified as a `*_System` (nightly's
`brick:System` shape flags `hasPart` on a System as a `sh:Warning`) — see the
**brick-relationships** skill's "2b. rec:includes" section. Equipment-classified plants
(e.g. `Meter`) are unaffected.

Data source: `inputs/equipment-inventory.json` → `plantEquipment[].equipment[]` (image items and the
point-list items of `update-equipment.ts --bms`). generate-ttl creates no equipment node of its own from point
names: a sub-device that should be modelled (e.g. a shading controller's blind groups) is an equipment item
from its token's `equipmentType`, and a separate device connected to a plant (e.g. a weather station) is a
plant of its own with a `plantHierarchy` link (`brick:isPartOf`, Step 4).

### Plant → Points (hasPoint / Controller-routed)

`DEMO-BN` (skill-00, "The example buildings"): the radiator circuit `RAD01` (a `Hot_Water_System`) on
controller `UC01`, its valve `RAD01_MV1` an equipment item of `RAD01`:

```turtle
bldg:RAD01 rec:includes bldg:RAD01_MV1 .
bldg:RAD01_MV1 brick:hasPoint bldg:RAD01_MV1_POS .
bldg:ctrl_UC01 brick:hasPoint bldg:RAD01_TF1 .
```

Points route to their resolved `pointHost` (equipment or a `brick:Controller` node,
written by `classify-all.ts`) — never directly to a `*_System` plant. Non-System
(Equipment-classified) plants are unaffected: their points still attach via `hasPoint`
directly, since that was already valid Brick. Points are flat: a suffix point (`RAD01_MV1_POS`) is
routed like any other point, never attached to another point. See the **brick-relationships** skill's
"2c. brick:Controller" section; the full routing algorithm is `resolvePointHost` in `classify-all.ts`.

Data source: `plant-point-mapping.json` → `plants[].points[].pointHost` (written by
`classify-all.ts`)

### Controller → device points (BACnet)

A BACnet building's controller-wide objects that no grouping rule places on a plant or zone (schedules,
overrides, communication alarms, unnamed registers) are **device points** (`plant-point-mapping.json`
`devices[].points`). Each hangs on its own controller node `bldg:ctrl_{deviceName}` (`brick:hasPoint`;
`brick:hasPart` if its class is an equipment class), the same node also `brick:hosts` it, and it gets the usual
BACnet reference (Step 5). A controller whose only points are device points still gets its node
(`brick:BACnet_Controller`).

`DEMO-BN`'s schedule object, a device point of `UC01`:

```turtle
bldg:ctrl_UC01 a brick:BACnet_Controller ;
    brick:hasPoint bldg:UC01_SCHEDULE ;
    brick:hosts bldg:UC01_SCHEDULE .
```

Data source: `plant-point-mapping.json` → `devices[]` (`deviceInstance`, `deviceName`, `points`).

### Zone → Equipment (feeds / hasLocation) and Zone → Points (hasPoint)

A zone never `hasPart` its equipment: a zone equipment item with a specific class `brick:feeds` the zone
(the generic `HVAC_Equipment` fallback and fume-hood dampers do not), and gets `brick:hasLocation` to the
zone's room when the zone has exactly one room (see "Zone ↔ Room location" below). The zone's points attach with `hasPoint`, to the
equipment item whose id the point id continues (`Z_101_SPI1_POS` → `Z_101_SPI1`), else to the zone. In
`DEMO-TS`, zone `Z_101` with its supply air damper `SPI1`:

```turtle
bldg:Z_101_SPI1 brick:feeds bldg:Z_101 ;
    brick:hasLocation bldg:room_1_01 .
bldg:Z_101 brick:hasPoint bldg:Z_101_TR1 , bldg:Z_101_TR1_SP .
bldg:Z_101_SPI1 brick:hasPoint bldg:Z_101_SPI1_POS .
```

Data sources:
- `inputs/equipment-inventory.json` → `zoneEquipment[].equipment[]`
- `inputs/zone-point-mapping.json` → `zones[].points[]`

---

## Step 4: Cross-cutting relationships

### Plant feeds zone

An AHU supplies air to zones it serves. This is the `brick:feeds` relationship.

```turtle
bldg:VE01 brick:feeds bldg:Z_101 .
bldg:VE01 brick:feeds bldg:Z_102 .
```

Data source: `inputs/building-connections.json` → `plantFeedsZone[]`

### Plant serves plant

A chiller or heating plant serves other plants (e.g., KO01 chiller feeds
VE01 AHU with chilled water). Use `brick:feeds` for this too — the chiller
feeds the AHU.

```turtle
bldg:KO01 brick:feeds bldg:VE01 .
```

Data source: `inputs/building-connections.json` → `plantServesPlant[]`

### Plant hierarchy

Fire damper groups belong to their parent plant:

```turtle
bldg:BSP01 brick:isPartOf bldg:VE01 .
```

Data source: `inputs/building-connections.json` → `plantHierarchy[]`

### Zone ↔ Room location

When a zone serves a room, the zone has a location in that room:

```turtle
bldg:Z_101 brick:hasLocation bldg:room_1_01 .
```

Data source: `inputs/spatial-hierarchy.json` → `zones[].roomIds` (zone-centred; every building
uses the same shape). Emit one `hasLocation` per distinct room id in a zone's `roomIds`; a zone
may cover several rooms, and an unlinked zone has none. Zones are grouped by floor from
`zones[].floorId` (zones without one fall under "Unassigned").

A zone-equipment item additionally gets `brick:hasLocation` to its zone's room only when that
zone has exactly one room; with several rooms or none, no equipment location is emitted.

---

## Step 5: TSDB references and units

Points with a `tsdb.id` get an external reference linking them to their
TimescaleDB time-series. This is what makes the Brick model queryable —
a SPARQL query can find the sensor's class, navigate to its parent equipment
or zone, and retrieve the TSDB id (the `objects.json` object name, `tsdb.id`) to fetch actual data.

```turtle
bldg:VE01_TI1 ref:hasExternalReference [
    a ref:TimeseriesReference ;
    ref:hasTimeseriesId "VE01_TI1"
] .
```

Iterate all points (flat) in both plant-point-mapping (plants and devices) and
zone-point-mapping. For each entry where `tsdb` is not null and `tsdb.id`
exists, emit the blank node pattern above.

> **BACnet difference:** when the building profile's `dataShape` is `bacnet`, points (plant, zone and
> device points alike) emit `ref:BACnetReference` instead of `ref:TimeseriesReference`, with
> `bacnet:objectOf` (the host device), `bacnet:object-name` (`tsdb.id`, the raw object name),
> `bacnet:object-identifier` (`{objectType},{objectInstance}`) and `bacnet:object-type`.
> `objectOf` targets the actual host controller matched by the point's `tsdb.deviceInstance`
> (not a single gateway); device URIs are prefixed `dev_` to avoid plant-URI collisions; the
> device's `bacnet:ip-address` is `xsd:hexBinary`. Devices come from the profile's `inputs.devices`.

#### Example: one BACnet reference

`DEMO-BN`'s `RAD01_TF1`, raw object name `DEMO_RAD01_TF1` (the point id is the name after the site prefix is
stripped; `tsdb.id` keeps the raw name), an analog input on `UC01`:

```turtle
bldg:RAD01_TF1 ref:hasExternalReference [
    a ref:BACnetReference ;
    bacnet:objectOf          bldg:dev_UC01 ;
    bacnet:object-name       "DEMO_RAD01_TF1" ;
    bacnet:object-identifier "analog-input,1" ;
    bacnet:object-type       "analog-input"
] .
```

### Unit triples

Points with `tsdb.units` also get a `brick:hasUnit` triple using QUDT unit URIs.
The BMS unit strings are mapped to QUDT as follows:

| BMS unit | QUDT URI |
|----------|----------|
| °C | `unit:DEG_C` |
| % | `unit:PERCENT` |
| ppm | `unit:PPM` |
| Pa | `unit:PA` |
| m³/h | `unit:M3-PER-HR` |
| %RH | `unit:PERCENT_RH` |
| bar | `unit:BAR` |

```turtle
bldg:VE01_TI1 brick:hasUnit unit:DEG_C .
bldg:Z_101_TR1 brick:hasUnit unit:DEG_C .
```

> **BACnet difference:** a BACnet building's `tsdb.units` are BACnet engineering-unit *names*, also in
> `unitMap`: `degrees-celsius`→`DEG_C`, `percent`→`PERCENT`, `parts-per-million`→`PPM`,
> `cubic-meters-per-hour`→`M3-PER-HR`, `liters-per-hour`→`L-PER-HR`, `cubic-meters`→`M3`,
> `kilowatts`→`KiloW`, `kilowatt-hours`→`KiloW-HR`, `megawatt-hours`→`MegaW-HR`, etc.
> `no-units` is no unit: it emits no `hasUnit` and is not counted as an unmapped unit string.

This requires the `unit:` prefix: `@prefix unit: <http://qudt.org/vocab/unit/> .`

---

## TTL file structure

The output file should be ordered for readability:

```turtle
# Prefixes
@prefix brick: <https://brickschema.org/schema/Brick#> .
@prefix tag: <https://brickschema.org/schema/BrickTag#> .
@prefix rec: <https://w3id.org/rec#> .
@prefix ref: <https://brickschema.org/schema/Brick/ref#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix unit: <http://qudt.org/vocab/unit/> .
@prefix bldg: <urn:{buildingId}/> .

# ── Building & Spatial ──
# (building, floors, rooms)

# ── Plants ──
# (plant declarations + equipment + points)

# ── Zones ──
# (zone declarations + equipment + points)

# ── Connections ──
# (feeds, serves, hierarchy, location)

# ── TSDB References ──
# (timeseries linkage)
```

## Validation

Two tools validate the output — run **both** after generating:

```bash
npx ts-node tools/validate-ttl.ts  {buildingId}   # structure: valid Turtle, one type/entity, every class
                                                   #   present + NON-DEPRECATED in the index, hasPoint/hasPart
                                                   #   targets, dangling refs, spatial integrity
npx ts-node tools/validate-refs.ts {buildingId}   # IDs vs inputs: every ref:hasTimeseriesId / BACnet
                                                   #   object-name == a source point's tsdb.id (full coverage,
                                                   #   nothing fabricated/dropped). BACnet also verifies the
                                                   #   object-identifier (type,instance) + objectOf host
                                                   #   device-instance, and device blocks vs devices.csv;
                                                   #   device points are counted like plant/zone points.
```

Notes:
- `validate-ttl` **errors** on deprecated Brick classes (the index excludes them — see brick-assign's
  "Brick (nightly) conventions").
- A timeseries building's `ref:hasTimeseriesId` values are the `objects.json` object names (`tsdb.id`), not
  UUIDs; `validate-ttl` reports each non-UUID id as a benign `tsdb-uuid` **warning**.
- A building's current validation state is what these two commands print for it; it is not recorded here.

## Subgraph mode

When run with `--entity {id}`, generate only the triples reachable from that
entity by traversing: the entity itself, its equipment (hasPart), its points
(hasPoint), zones it feeds, rooms those zones are in, floors those rooms are on,
the building, and plants that serve it. This is useful for debugging and eval.

## Counts

A building's counts are not recorded here: each run of `generate-ttl.ts` prints its own (entities, spatial,
hierarchy, connections, TSDB refs, units, total lines, unmapped units), and
`npx ts-node tools/pipeline-status.ts {buildingId}` reports which build steps apply to the building and which
are done.
