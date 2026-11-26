---
name: brick-relationships
description: >
  Brick (nightly) relationship mapping patterns for TTL generation, including the
  RealEstateCore (REC) spatial hierarchy that replaced deprecated brick:Location
  classes. Defines how to construct correct triples connecting Equipment, Points,
  Spatial entities (rec:Building, rec:Level, rec:Room, rec:Wing), HVAC Zones,
  and TimescaleDB time-series. Use this skill when generating TTL files,
  constructing Brick triples, linking BMS points to TSDB, modeling building
  spatial hierarchy, or whenever the user asks about brick:hasPoint, brick:feeds,
  brick:hasPart, brick:hasLocation, rec:locatedIn, rec:isPartOf, rec:Level,
  rec:Room, ref:hasExternalReference, ref:hasTimeseriesReference, or how
  entities relate in the Brick ontology. Also trigger when the user mentions
  "relationship index", "triple patterns", "TSDB linkage", "spatial hierarchy",
  "building topology", "floor/room/zone structure", or "RealEstateCore".
---

# Brick Relationship Mapping

## Purpose

This skill describes how to construct valid Brick (nightly) triples for the AI-CX
building model. The classification index (`brick-classification-index.json`)
tells you **what** things are. This skill tells you **how** things connect.

## Reference data

Before generating TTL, load the relationship index:
```
Read: ontologies/brick-relationship-index.json
```

To regenerate it (only needed if Brick_nightly.ttl is updated — the index is built from
`ontologies/Brick_nightly.ttl`, added on 2026-08-17):
```
npx ts-node tools/build-brick-relationship-index.ts ontologies/Brick_nightly.ttl ontologies/brick-relationship-index.json
```

## Core structural relationships

These are the relationships you will use most often when building a Brick model
for a Danish BMS building. Listed in order of frequency:

### 1. `brick:hasPoint` — Sensor/actuator linkage

Connects an Equipment or Location to its telemetry Points (sensors, setpoints,
commands, statuses).

Examples use the example buildings (skill-00, "The example buildings") and the URIs `generate-ttl.ts` emits.

```turtle
bldg:VE01 a brick:Air_Handling_Unit .
bldg:VE01_TI1 a brick:Supply_Air_Temperature_Sensor ;
    brick:hasUnit unit:DEG_C .
bldg:VE01 brick:hasPoint bldg:VE01_TI1 .
```

**Domain:** Equipment, Location
**Range:** brick:Point
**Inverse:** `brick:isPointOf`

Every BMS point from the point-mapping JSON that has a `tsdb` entry should get
a `brick:hasPoint` triple from its parent (zone or plant/equipment).

### 2. `brick:hasPart` — Physical composition

A physical containment relationship — a damper, valve, or fan is **part of**
an AHU or VAV.

```turtle
bldg:VE01 a brick:Air_Handling_Unit .
bldg:VE01_SF1 a brick:Supply_Fan .
bldg:VE01 brick:hasPart bldg:VE01_SF1 .
```

**Inverse:** `brick:isPartOf`

Use this for sub-equipment within a plant. In the plant-point-mapping, when a
point is actually equipment (its class is an Equipment class; which tokens these are is the building's own
dictionary, see "Equipment point abbreviations" below), it represents a physical component, not just a telemetry point.

**Not for `*_System`-classified plants** — see 2b below; nightly recommends
`rec:includes` instead.

### 2b. `rec:includes` — System/Collection membership (nightly)

Nightly's `brick:System` shape flags `brick:hasPart` on a System as a `sh:Warning`
("Systems should use `rec:includes` instead"). For any plant classified as a `*_System`
(category `System` in the classification index), use `rec:includes` for both its
captured sub-equipment and its `brick:Controller` node (see 2c) — never `brick:hasPart`.
For Equipment-classified plants (e.g. `Meter`), `brick:hasPart` is still correct and
unchanged.

`DEMO-BN`'s radiator circuit `RAD01`, its valve `RAD01_MV1` and its controller `UC01`:

```turtle
bldg:RAD01 a brick:Hot_Water_System .
bldg:RAD01 rec:includes bldg:RAD01_MV1 , bldg:ctrl_UC01 .
```

### 2c. `brick:Controller` / `brick:hosts` / `brick:controls` — nightly only, 1.4.4 has none of these

`brick:hosts`/`brick:isHostedBy`/`brick:controls`/`brick:isControlledBy` don't exist in
1.4.4 at all — verified zero matches. A `brick:BACnet_Controller` node models the
physical automation station (from `plant.deviceInstance`/`plant.deviceName`), one node
per unique `(deviceInstance, deviceName)` pair, shared across every plant that
references it:

```turtle
bldg:ctrl_UC01 a brick:BACnet_Controller ;
    brick:controls bldg:RAD01_MV1 ;
    brick:hasPoint bldg:RAD01_TF1 ;
    brick:hosts bldg:RAD01_TF1 , bldg:RAD01_MV1_POS .
```

`hasPoint` (semantic ownership, points with no physical-equipment owner) and `hosts`
(network-exposure fact, every point on every plant the Controller backs) are additive,
not exclusive — a point can and should have both where applicable. `hasPoint` on
administrative points is an AI-CX extrapolation, not a settled Brick pattern (Brick's
own PR #724 discussion never concluded this case) — flag accordingly if a future review
needs to revisit it.

**Device points (BACnet).** A controller's objects that no grouping rule places on a plant or zone
(`plant-point-mapping.json` `devices[].points`: schedules, overrides, communication alarms, unnamed
registers) belong to the controller itself: its node gets both `brick:hasPoint` and `brick:hosts` for each of
them, and a controller that has only device points still gets its node. They have no plant and no
equipment owner, so they get no water frame tag. No equipment is synthesized from point names: sub-devices
come from equipment items (`equipmentType`), and a device connected to a plant is its own plant linked with
`brick:isPartOf` (the inverse of `hasPart`, section 2; from `building-connections.json` `plantHierarchy`).

### 3. `brick:feeds` — Flow topology

Upstream/downstream in an airflow or water circuit. The subject passes media
(air, water, electricity) to the object.

```turtle
bldg:VE01 brick:feeds bldg:Z_101 .
bldg:KO01 brick:feeds bldg:VE01 .
```

**Inverse:** `brick:isFedBy`
**Equivalent:** `rec:feeds`

Use this to model how AHUs feed zones, chillers feed AHUs, etc. The
`building_model.json` and images from Phase 4 determine which plants feed
which zones.

### 4. `brick:hasLocation` / `rec:locatedIn` — Spatial placement

Where something is physically located. In Brick (nightly), `brick:hasLocation` and
`rec:locatedIn` are declared `owl:equivalentProperty` — use either one, but be
consistent within a file. The range should be a `rec:Space` subclass (see
Spatial Hierarchy section below), not the deprecated `brick:Location`.

```turtle
bldg:VE01 brick:hasLocation bldg:Building .
bldg:Z_101 brick:hasLocation bldg:room_1_01 .
```

**Range:** rec:Space (rec:Building, rec:Level, rec:Room, rec:Wing)
**Inverse:** `brick:isLocationOf` (equivalent: `rec:isLocationOf`)
**Equivalent:** `rec:locatedIn`

The spatial data from `spatial_data.json` (IFC parse) and the building model
provide floor/room/building relationships.

### 5. `brick:meters` — Metering

A meter measures the consumption/production of a substance for an entity.

```turtle
bldg:VA07_QM1 a brick:Thermal_Power_Meter .
bldg:VA07_QM1 brick:meters bldg:VA07 .
```

**Inverse:** `brick:isMeteredBy`

Meters from the plant point mapping (a plant or equipment classed as a `brick:Meter` subclass: energy, heat,
volume meters) use this relationship. `generate-ttl.ts` does not emit `brick:meters` today: which entity a
meter measures is not in its inputs.

### 6. Physical connection — REMOVED in Brick nightly, do not use

`brick:connectedTo` existed in Brick 1.4.4 (symmetric, non-directional physical
connection) but has been **removed entirely** in Brick nightly — confirmed absent
from `ontologies/Brick_nightly.ttl` and from `brick-relationship-index.json`
(regenerated 2026-08-17). There is no direct replacement property for a plain
symmetric connection; model piping/ductwork connections with `brick:feeds` (if
directional) or `brick:hasPart`/`brick:hasLocation` (if containment/placement is
what's actually meant) instead. Using `brick:connectedTo` in generated TTL would
be a made-up predicate not defined in the target ontology.

## TSDB linkage — the critical connection

Every Brick Point with a time-series **must** have a `ref:hasExternalReference`
pointing to a `ref:TimeseriesReference` with the object name from objects.json (`tsdb.id`).

This is the bridge between the semantic graph and the live data in TimescaleDB.

### Pattern

```turtle
bldg:VE01_TI1 a brick:Supply_Air_Temperature_Sensor ;
    rdfs:label "Lufttemperatur efter aggregat (Supply Air Temperature Sensor)" ;
    brick:hasUnit unit:DEG_C .

bldg:VE01_TI1 ref:hasExternalReference [
    a ref:TimeseriesReference ;
    ref:hasTimeseriesId "VE01_TI1"
] .
```

### Where the id comes from

The `tsdb.id` field in the point-mapping JSON files (the `objects.json` object name):
```json
"tsdb": {
  "id": "VE01_TI1",     ← this becomes ref:hasTimeseriesId
  "objectType": "AnalogInput",
  "objectInstance": 12345,
  "units": "°C"
}
```

### Reference property chain

```
ref:hasExternalReference          → top-level property
  └─ ref:hasTimeseriesReference   → subProperty (more specific)
       └─ targets ref:TimeseriesReference class
            ├─ ref:hasTimeseriesId (required, xsd:string) → the tsdb.id
            └─ ref:storedAt (optional) → database reference
```

Either `ref:hasExternalReference` or `ref:hasTimeseriesReference` can be used
as the predicate. Both are valid — `hasTimeseriesReference` is more specific
and preferred when the reference is explicitly a time-series.

### Points without TSDB entries

Points in the CSV that have no `tsdb` match (setpoints, config parameters)
still get modeled as Brick entities with `brick:hasPoint` but do **not** get
a `ref:hasExternalReference` triple. They represent configuration, not live data.

## Spatial hierarchy — RealEstateCore in Brick (nightly)

In Brick (nightly), all `brick:` location classes are **deprecated**. The
relationship index (`spatial.deprecations`) lists every replacement — e.g.
`brick:Building` → `rec:Building`, `brick:Floor` → `rec:Level`. Always use the
`rec:` classes. The full class hierarchy, room subtypes (52), and level subtypes
(3) are in the index under `spatial.hierarchy`, `spatial.roomSubtypes`, and
`spatial.levelSubtypes`.

### Key rules the index alone does not convey

**1. Level subtypes by function:**
- Basement floors → `rec:BasementLevel`
- Normal floors → `rec:Level`
- Roof/technical floors → `rec:RoofLevel`
- All levels get `rec:levelNumber` (xsd:integer) for ordinal position

**2. Room subtype selection for Danish buildings:**
Look up the room function in the building model, then find the closest match in
`spatial.roomSubtypes`. Non-obvious mappings:
- Toilet / WC → `rec:PersonalHygiene` (not `rec:Bathroom` — that implies bathing)
- Serverrum / Teknikrum → `rec:UtilitiesRoom`
- Kantine → `rec:FoodHandlingRoom`
- If no subtype fits, use `rec:Room` with a descriptive `rdfs:label`

**3. Space-to-space vs non-space-to-space — the critical distinction:**

- **`rec:isPartOf` / `rec:hasPart`** — structural containment *between spaces*.
  A level is part of a building. A room is part of a level.
- **`brick:hasLocation`** — placing *non-spatial things* (equipment, zones) in a
  space. A zone is located in a room. An AHU is located on a level.

```
rec:Site
 └─ rec:hasPart ─► rec:Building
     └─ rec:hasPart ─► rec:Level          (floor is part of building)
         └─ rec:hasPart ─► rec:Room       (room is part of floor)
              ▲                ▲
              │                │
     brick:hasLocation    brick:hasLocation
              │                │
     brick:Equipment    rec:HVACZone
```

### Example: a complete spatial graph

`DEMO-TS` (skill-00, "The example buildings"). It has no wing; the `rec:Wing` block shows the pattern for a
building that has one (`generate-ttl.ts` emits no wings today).

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

bldg:Wing_A a rec:Wing ;
    rdfs:label "Wing A" ;
    rec:isPartOf bldg:Building .

bldg:Z_101 a rec:HVACZone ;
    rdfs:label "Z_101 Office 1.01" ;
    brick:hasLocation bldg:room_1_01 .

bldg:VE01 a brick:Air_Handling_Unit ;
    rdfs:label "VE01 (Air handling unit)" ;
    brick:feeds bldg:Z_101 ;
    brick:hasLocation bldg:Building .
```

## Building a complete TTL file

### Prefix declarations

```turtle
@prefix brick: <https://brickschema.org/schema/Brick#> .
@prefix ref:   <https://brickschema.org/schema/Brick/ref#> .
@prefix rec:   <https://w3id.org/rec#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .
@prefix unit:  <http://qudt.org/vocab/unit/> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix bldg:  <urn:{buildingId}/> .
```

### Entity ordering in the TTL

Group by entity type for readability:

1. **Site & Building** — `rec:Site`, `rec:Building`
2. **Wings** — `rec:Wing` with `rec:isPartOf` building
3. **Levels** — `rec:Level` (or `rec:BasementLevel` / `rec:RoofLevel`) with `rec:isPartOf` building
4. **Rooms** — `rec:Room` subtypes with `rec:isPartOf` level
5. **Zones** — `rec:HVACZone` with `brick:hasLocation` room
6. **Equipment** — `brick:Air_Handling_Unit`, `brick:Chiller`, etc. with `brick:hasLocation` level
7. **Sub-equipment** — `brick:Supply_Fan`, `brick:Damper`, etc.
8. **Points** — all `brick:Point` subclasses with `hasPoint` links
9. **TSDB references** — `ref:hasExternalReference` blocks
10. **Topology** — `brick:feeds` triples connecting equipment to zones

### Generating triples from point-mapping JSON

Points are flat (CLAUDE.md rule 5): a suffix point such as `Z_101_TR1_SP` is a point of its own, a sibling
of `Z_101_TR1`, never a point of it.

For each zone in `zone-point-mapping.json`:
```
zone → rec:HVACZone entity
  for each point:
    point → brick:Point subclass entity
    owner brick:hasPoint point   (owner = the zone's equipment item whose id the point id
                                  continues, e.g. Z_101_SPI1 for Z_101_SPI1_POS; else the zone)
    if point.tsdb:
      point ref:hasExternalReference [ a ref:TimeseriesReference ; ref:hasTimeseriesId "..." ]
```

For each plant in `plant-point-mapping.json`:
```
plant → brick:Equipment or brick:System subclass entity
  for each point:
    if point's class is an Equipment class (the building's dictionary decides which tokens are equipment):
      sub-equipment → brick:Equipment subclass
      plant [rec:includes if *_System, else brick:hasPart] sub-equipment
      points whose id continues its id → brick:hasPoint from it (when equipment-inventory lists it)
    else:
      point → brick:Point subclass
      point routes to its resolved pointHost (written by classify-all.ts —
      an equipment id or a brick:Controller node), never to a *_System plant
      directly — see "Plant → Points (hasPoint / Controller-routed)" below
    if tsdb: attach ref:hasExternalReference
```

### Plant → Points (hasPoint / Controller-routed)

```turtle
bldg:RAD01 rec:includes bldg:RAD01_MV1 .
bldg:RAD01_MV1 brick:hasPoint bldg:RAD01_MV1_POS .
bldg:ctrl_UC01 brick:hasPoint bldg:RAD01_TF1 .
```

Points route to their resolved `pointHost` (equipment or Controller) — never directly
to a `*_System` plant. Non-System (Equipment-classified, e.g. `Meter`) plants are
unaffected: their points still attach via `hasPoint` directly, since that was already
valid Brick. The full routing algorithm is `resolvePointHost` in `classify-all.ts`.

Data source: `plant-point-mapping.json` → `plants[].points[].pointHost` (written by
`classify-all.ts`)

## Units — QUDT URI mapping

Points with a known unit from TSDB (`tsdb.units`) should declare `brick:hasUnit`
using the QUDT URI, not a string literal. The `unit:` prefix must be declared
(`@prefix unit: <http://qudt.org/vocab/unit/> .`).

| TSDB units value | QUDT unit URI | Notes |
|-----------------|---------------|-------|
| `°C` | `unit:DEG_C` | Celsius |
| `%` | `unit:PERCENT` | Damper position, valve, humidity |
| `ppm` | `unit:PPM` | CO2 concentration |
| `Pa` | `unit:PA` | Pressure |
| `m³/hr` | `unit:M3-PER-HR` | Airflow volume |
| `m³/h` | `unit:M3-PER-HR` | Airflow volume (alternate) |
| `kWh` | `unit:KiloW-HR` | Energy |
| `W` | `unit:W` | Power |
| `L/s` | `unit:L-PER-SEC` | Flow rate |
| `bar` | `unit:BAR` | Pressure (hydraulic) |

If the unit string is null, empty, or not in this table, omit `brick:hasUnit`
entirely — do not guess or use a string literal.

**Example** (`DEMO-TS`):
```turtle
bldg:Z_101_TR1 a brick:Zone_Air_Temperature_Sensor ;
    rdfs:label "Temperaturføler rum (Room Temperature Sensor)" ;
    brick:hasUnit unit:DEG_C .

bldg:Z_101_SPI1_POS a brick:Damper_Position_Sensor ;
    rdfs:label "Stilling zonespjæld (Damper Position)" ;
    brick:hasUnit unit:PERCENT .
```

## Inverse relationships

You typically only need to assert one direction. OWL reasoners and SHACL
validators will infer the inverse. Prefer the "has" / forward direction:

| Prefer | Rather than | rec: equivalent |
|--------|-------------|-----------------|
| `brick:hasPoint` | `brick:isPointOf` | `rec:hasPoint` |
| `brick:hasPart` / `rec:hasPart` | `brick:isPartOf` / `rec:isPartOf` | — |
| `rec:includes` (*_System plants only) | — | — |
| `brick:hasLocation` | `brick:isLocationOf` | `rec:locatedIn` |
| `brick:feeds` | `brick:isFedBy` | `rec:feeds` |
| `brick:meters` | `brick:isMeteredBy` | — |
| `brick:controls` | `brick:isControlledBy` | — |
| `brick:hosts` | `brick:isHostedBy` | — |

For spatial containment, either `rec:hasPart` or `rec:isPartOf` works — pick
one direction and be consistent. This skill uses `rec:isPartOf` (child → parent)
in examples because it keeps the child entity self-contained, but `rec:hasPart`
(parent → child) is equally valid.

## Deciding which relationship to use

| Scenario | Relationship |
|----------|-------------|
| Sensor/setpoint belongs to equipment or zone | `brick:hasPoint` |
| Fan/damper/valve physically inside an AHU | `brick:hasPart` |
| Sub-equipment or Controller belongs to a `*_System`-classified plant | `rec:includes` (not `hasPart` — see 2b) |
| A point has no physical-equipment owner, only a BACnet automation station | `brick:Controller` node's `brick:hasPoint` + `brick:hosts` (see 2c) |
| AHU supplies air to a zone | `brick:feeds` |
| Equipment is on a specific floor | `brick:hasLocation` |
| Zone is in a room | `brick:hasLocation` |
| Energy meter measures AHU consumption | `brick:meters` |
| Point has live data in TimescaleDB | `ref:hasExternalReference` |
| Two pipes are connected | *(no direct property in nightly — `brick:connectedTo` was removed; use `brick:feeds` or reconsider as containment/placement)* |
| Building contains floors | `rec:hasPart` |
| Floor contains rooms | `rec:hasPart` |
| Building has wings | `rec:hasPart` |

## Equipment point abbreviations → sub-equipment vs telemetry

Some point abbreviations in the plant mapping represent physical equipment
rather than pure telemetry. These should use `brick:hasPart` instead of
`brick:hasPoint`:

Which abbreviations are equipment is the building's own data, not a list in this skill: a point is equipment
when its class (from its dictionary token entry) is an `Equipment`-category class in the classification
index, and a token entry's `equipmentType` creates the equipment item (point-mapping skill). `generate-ttl.ts`
relates an Equipment-classed point with `brick:hasPart` (`rec:includes` on a `*_System` plant). The same
token can be equipment in one building and telemetry in another (a damper in one, a setpoint in another); if
another building's confirmed dictionary exists under `data/`, read it as a suggestion, never apply it.

In `DEMO-TS` (skill-00, "The example buildings"):

| Token / point | Is equipment? | Brick class |
|-------------|--------------|-------------|
| `SPI` (`Z_101_SPI1`, the zone supply air damper, an equipment item from the token's `equipmentType`) | yes | `brick:Damper` |
| `Z_101_SPI1_POS` | no | `brick:Damper_Position_Sensor`, a point of the damper |
| `TR` (`Z_101_TR1`) | no | `brick:Zone_Air_Temperature_Sensor` (a `Temperature_Sensor` subclass) |
| suffix `_SP` (`Z_101_TR1_SP`) | no | `brick:Target_Zone_Air_Temperature_Setpoint` |

Class choices that hold in every building:
- Fans, pumps, valves, compressors are equipment: `Supply_Fan` / `Exhaust_Fan` / `Fan`, `Pump`, `Valve`,
  `Compressor`.
- A rotary heat exchanger (heat wheel) is equipment, `brick:Heat_Wheel` — NOT a damper; its heat-recovery
  efficiency is telemetry, a `brick:Parameter` point, not equipment.
- A damper is `brick:Damper`; an AHU's intake damper → `Outside_Damper`, its exhaust damper →
  `Exhaust_Damper` (by `ductPath` / description); a zone VAV damper stays `Damper`. A fire damper is also
  `brick:Damper` (Brick nightly still has NO `Fire_Damper`; `Damper` is the most-specific valid class).
- Temperature, pressure, CO2 and humidity telemetry → `Temperature_Sensor`, `Pressure_Sensor`, `CO2_Sensor`,
  `Humidity_Sensor` subclasses; a meter → a `brick:Meter` subclass (metering, section 5).
