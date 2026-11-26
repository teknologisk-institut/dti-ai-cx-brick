---
name: point-mapping
description: >
  Map BMS points from CSV pointlists and TimescaleDB objects to structured
  JSON with semantic meaning, TSDB linkage, and parent-to-point hierarchy.
  Covers both zone points (zone ids) and plant points (plant ids).
  Use this skill whenever the user asks to map points, generate a point mapping,
  analyze sensor data, link BMS points to TSDB, or prepare data for Brick
  ontology classification. Also trigger when the user mentions "pointlist-zones",
  "pointlist-plants", "zone-point-mapping.json", "plant-point-mapping.json",
  or asks about the relationship between CSV points and objects.json. Also covers
  zone↔room matching ("zone-rooms.json", "match-zone-rooms", room overview screens).
---

# Point Mapping Skill

## What this does

Produces structured JSON files that join two data sources:

1. **pointlist-zones.csv / pointlist-plants.csv** — BMS alarm/config export with points, Danish descriptions, and alarm classes
2. **objects.json** — TimescaleDB/BACnet object registry with UUIDs, object types, and units

The output groups everything by **parent → flat points** (a suffix row is its own point), with:
- Semantic meaning extracted from Danish BMS abbreviations
- TSDB linkage (`tsdb.id` = the `objects.json` object name) for each point that has a live time-series
- Coverage gaps flagged (CSV-only and TSDB-only points)

Both tools produce the **same output structure** — just `zones[]` vs `plants[]` at the top level.

## When to use

- User asks to map, generate, or regenerate point mappings
- User needs to understand what sensors/actuators a zone or plant has
- Preparing data for Brick ontology classification
- Investigating TSDB coverage gaps
- User asks about the relationship between the CSV pointlist and objects.json
- Matching zones to rooms (`zone-rooms.json`, `match-zone-rooms.ts`, `spatial-hierarchy.json`): see
  "Zone↔room matching" below

## Prerequisites

The building profile must exist (see the inventory step below). For timeseries buildings
`map-points.ts` runs `split-pointlist-csv.ts` itself; run the splitter by hand only when invoking
`map-plant-points.ts` / `map-zone-points.ts` directly.

## Before mapping a new building: inventory step

The profile-aware tools (map-points and the mappers, update-equipment, classify-all, generate-ttl,
validate-refs, pipeline-status) read `data/{buildingId}/building-config.json` (the building profile)
and stop with "no building profile — run the inventory step (see point-mapping skill)" if it is
missing. Create it first:

0. Check the building folder against the README's "Input requirements". If `data/{buildingId}/` is missing,
   empty, or its files are not where those say, tell the human which folders to create and which input goes
   where (point data and IFC models in `inputs/`, screenshots in `images/<kind>/`, documents in
   `docs-unsorted/`) before drafting the profile. `inputs/` and `docs-unsorted/` are fixed: the tools write
   generated files to `inputs/` and search documents only in `docs-unsorted/`.
1. List `data/{buildingId}/` (inputs, images, docs).
2. Propose `dataShape` and `inputs` from what is there, with the evidence for each field, e.g.
   `devices.csv` + an `objects/` folder → `bacnet`; a `*_pointlist.csv` + `objects.json` → `timeseries`.
3. For a `timeseries` building, draft `pointListFormat` first, from the point list's header and a sample of
   rows: the delimiter, which header is the plant / point / description / alarm-class column, the null
   sentinel (`nullValue`), and any rows that are export artifacts rather than points (`skipRows`). Show the
   human the evidence: the header line, sample rows, and the count of each candidate skip.
4. Then draft `naming`, the building's **id grammar** (see "Id grammar and word discovery" below for what
   each field splits and how the review shows sample splits):
   - Timeseries: group the Plant column into shapes (digits -> `9`), propose `zoneId` (regex, group 1 =
     the zone id, and it must be the start of the Plant value: the mappers and the profile data check reject a
     pattern whose group 1 is not a prefix of the Plant value), `separator` and `pointToken` (regex, group 1 =
     the dictionary token), and show the human the shape counts that each pattern classifies as zone vs
     plant. Draft `unsplittablePointNames` only where the data shows a case (a separator-containing point
     name with no base point).
   - BACnet: `separator`, `objectNames` (which plant, zone or device each object belongs to; "The BACnet
     object-name grammar" below) and `pointParts`, an anchored regex over the point part of an object name
     (after `objectNames` has placed the object) with the named groups `token`, `number` and optionally
     `rest` (a trailing letter and the separator-delimited suffix parts).
   - Both routes: `plantToken` (regex, group 1 = the plant token the dictionary's `plantTokens` key on), and
     `airDirectionMarker` only if ids carry a supply/extract marker.
   An opaque register family (configuration ids) is not a naming field: it is an id-suffix entry in the
   dictionary (tags `[Parameter]`).
4a. **Images.** When the profile declares images, also draft `bmsScreens` (the screen guide,
   `data/{buildingId}/notes/bms-screens.md`), `notes`, `feedsSources` and, with installation IFCs,
   `naming.ifcSystemPlant` (IFC system names vs the plant list), as skill-00-context.md "Step 0" describes
   (open a few images of each kind first; the screen guide's sections, which the image skills look up by
   heading, are listed there); the human confirms them with the rest of the profile in step 5.
5. **HITL: show the draft to the human and confirm the route (`dataShape`), the input list, and the
   `pointListFormat` (timeseries) and `naming` evidence.** For BACnet, one decision at a time: the device
   roles, the cleanup, each object rule with its counts and sample splits, each skip rule with its evidence,
   every group of copies on several controllers (keep apart, merge, or `toDevice`), and the unplaced name
   shapes (they become device points). Rules carried over from earlier work are shown as pre-existing.
6. On confirmation, write it:
   ```
   echo '<profile json>' | npx ts-node tools/write-building-profile.ts {buildingId} [--force]
   npx ts-node tools/write-building-profile.ts {buildingId} --validate
   ```
   Run the `echo ... |` write from Bash (Git Bash), not PowerShell: PowerShell 5.1 pipes ASCII to
   native programs and mangles æ/ø/å in paths. The write (and `--validate`) prints the data check.
   Timeseries: zone and plant row counts, rows skipped per rule, and null cells; a missing column is an error,
   and 0 zone rows or every row classified as zone is a warning. BACnet: devices per device rule (a device
   with an object file and no role is an error), per object rule the objects placed, parents produced and
   three sample splits, skips and merges per rule, unplaced objects by name shape per device, names on several
   controllers that no merge rule covers (with whether their values differ), distinct objects that would share
   one id (kept apart), a rule that matches nothing (warning), and every grammar plant without a
   `plantTokens` or `plantOverrides` entry (warning; classification needs one). Compare it with the draft
   evidence; the report is what the human confirms in step 5.
7. Run `npx ts-node tools/pipeline-status.ts {buildingId}` to see which steps apply.

See skill-00-context.md "Step 0 — Inventory (building profile)" for the profile fields.

### The BACnet object-name grammar (`naming.objectNames`)

A BACnet scrape is a device registry (`devices.csv`) and one object file per device. Which plant, zone or
device each object belongs to is building data in the profile, drafted from the building's own devices and
object names, never a rule in code. Draft it from the data: list the devices and which have object files,
group each device's object names by shape (digits as `9`) with counts, and propose:

- **Device roles** (`devices`, ordered, first match wins). Each rule matches one `devices.csv` column by
  header name (`vendor-name`, `model-name`, `object-name`, …) with an anchored `pattern`, and gives a `role`:
  - `parent`: the whole device is one plant. Its id is the device's object-name after the cleanup (whitespace
    becomes the separator in ids built from a device name); its objects are device-relative register names,
    point id `{plantId}{separator}{object-name}`.
  - `controller`: a programmable controller; the object rules place its objects. Objects no rule places become
    **device points** of the controller (`plant-point-mapping.json` `devices`, point id
    `{device object-name after cleanup}{separator}{object-name}`), hosted by its controller node in the TTL.
  A rule may name one device (an `object-name` pattern) ahead of a rule for its whole model, so a rule can be
  scoped to that device. A device with an object file that no rule matches is an error; a device without an
  object file (e.g. a supervisor station) needs no role. A vendor or model name matched here is this
  building's data: another building's identical name means nothing until its own draft is confirmed.
- **Cleanup** (`stripPrefix`, optional): an anchored pattern removed from the start of every object name (and
  of a `parent` device's name), e.g. a site prefix. Measure every variant of the prefix in the data. Object
  names otherwise keep their spaces (the dictionary's suffix entries may match them).
- **Object rules** (`rules`, ordered, first match wins; tried on the prefix-stripped name). Each has `id`, `evidence`,
  an anchored `pattern` with the named groups `parent` and `point` (the point part may be empty: the point id is
  then `{parent}{separator}`), and `kind` `plant` or `zone`. Options:
  - `device`: a device rule id; the rule applies only to that device's objects. On a `parent` device only such
    device-scoped rules apply (they take objects away from the device plant, e.g. a sub-device such as a
    weather station connected to it);
  - `parent`: a literal parent instead of the `parent` group (for a device-scoped rule whose objects do not
    name their parent);
  - `parentRewrite`: an ordered list of `{ pattern, replace }` applied to the captured parent only (a typo or
    a location spelling in some names, so the objects land in the parent the rest use);
  - `skip: true` with a `reason`: matching objects are not mapped and are counted per rule (e.g. a controller's
    copies of registers that a `parent` device already provides; scope such a rule to the parents that really
    have their own device);
  - `toDevice: true` with `device` and a `reason`: matching objects on that device become its device points,
    flagged with the rule id, instead of joining the plant or zone their name names (objects that carry another
    zone's name but whose values do not fit it).
  Rule order is part of the grammar: a narrow rule (a meter under a zone, a skip) goes before the broad rule
  that would also match it.
- **Copies on several controllers** (`merge`, optional). The same object name on several controllers is kept
  apart by default: each copy is a point on its own controller, the second and later copies get the id
  `{id}{separator}{objectType}-{objectInstance}`, or `{id}{separator}{deviceInstance}-{objectType}-{objectInstance}`
  when that id is already taken (copies on different controllers with the same object type and instance); a
  genuine duplicate (same device, type and instance) is an error, and the mapper refuses to write duplicate ids.
  A `merge` rule (`id`, anchored `pattern`, `source` = the
  object-name of the device that hosts the one point, `evidence`) makes a group confirmed as one source one
  point; the other copies are counted, not mapped. Copies and merges concern controller-role devices only; a
  `parent` device's registers are its own points. Two distinct objects that would produce one id are always
  kept apart and listed.
- **Consistency with the dictionary:** every plant the grammar produces needs a `plantTokens` entry for its
  plant token, or a `plantOverrides` entry; the data check lists each one without (drafted at touchpoint 2).

Evidence entries use the dictionary's kinds (`data` rows with counts, `doc` quotes, `human` answers,
`pre-existing` for decisions carried over). Nothing is deferred: every object is a plant or zone point, a
device point, or skipped by a confirmed rule, and the mapper's summary counts each (`byRule`, `skipped`,
`merged`, `toDevice`, `devicePoints`, `duplicatesKeptApart`).

#### Example: the `DEMO-BN` grammar

`DEMO-BN` (skill-00, "The example buildings") has one controller, `UC01` (instance 1001), and raw object
names such as `DEMO_RAD01_TF1`: a site prefix, then the parent, then the point part. After the cleanup these
are skill-00's object names (`RAD01_TF1`, `RAD01_MV1_POS`). Its `naming` members:

```json
"separator": "_",
"objectNames": {
  "stripPrefix": { "pattern": "^DEMO_",
    "evidence": [{ "kind": "human", "answer": "every object name starts with the site prefix DEMO_", "date": "2026-01-15" }] },
  "devices": [
    { "id": "controller", "column": "object-name", "pattern": "^UC\\d{2}$", "role": "controller",
      "evidence": [{ "kind": "human", "answer": "UC01 is a programmable controller", "date": "2026-01-15" }] }
  ],
  "rules": [
    { "id": "radiator-circuit", "pattern": "^(?<parent>RAD\\d{2})_(?<point>.+)$", "kind": "plant",
      "evidence": [{ "kind": "human", "answer": "RADnn objects belong to radiator circuit RADnn", "date": "2026-01-15" }] },
    { "id": "zone", "pattern": "^(?<parent>Z_\\d{3})_(?<point>.+)$", "kind": "zone",
      "evidence": [{ "kind": "human", "answer": "Z_nnn objects belong to zone Z_nnn", "date": "2026-01-15" }] }
  ]
},
"pointParts": { "pattern": "^(?<token>[A-Z]+)(?<number>\\d*)(?<rest>_.+)?$" },
"plantToken": { "pattern": "^([A-Z]+)\\d+$" }
```

Sample splits: `DEMO_RAD01_TF1` → plant `RAD01`, point `RAD01_TF1` (token `TF`, number `1`);
`DEMO_RAD01_MV1_POS` → plant `RAD01`, point `RAD01_MV1_POS` (token `MV`, number `1`, suffix `POS`: the valve
`RAD01_MV1`); `DEMO_Z_201_TR1` → zone `Z_201`, point `Z_201_TR1`; an object no rule places (e.g.
`DEMO_SCHEDULE`) becomes a device point of `UC01` (`UC01_SCHEDULE`). The one grammar plant `RAD01` needs
a `plantTokens.RAD` entry in the dictionary. A real building's grammar is longer (device-scoped rules first,
narrow rules such as meters and skips before the broad plant and zone rules, `parentRewrite` for misspelt
parents, merge rules for copies) but has this shape. If another building's confirmed profile or dictionary
exists under `data/`, read it as a suggestion, never apply it.

## How to run

Draft and confirm the building's dictionary first (HITL touchpoint 2, moment 1, below), then map.

```
npx ts-node tools/map-points.ts {buildingId} [--force]
```
`map-points.ts` dispatches on the profile's `dataShape`: timeseries buildings run `split-pointlist-csv.ts`
→ `map-plant-points.ts` → `map-zone-points.ts`; bacnet buildings run `map-bacnet-points.ts`.
Output: `data/{buildingId}/inputs/plant-point-mapping.json` and `zone-point-mapping.json`.
(The individual mappers can still be run directly.) Every mapper needs the building's
`point-dictionary.json` (one shape, `schemaVersion: 3`) and stops without it.

If the output files already exist and are up-to-date, read them directly instead of regenerating.

**`--force` on a classified building carries the human reviews over.** The mappers refuse to overwrite a
mapping file that already holds `brickClass` data unless `--force` is passed
(`guardAgainstClassifiedOverwrite()`, `tools/lib/rerun-guard.ts`). With `--force`,
`carryOverReviewed()` (same file) copies, from the old file:
- every `reviewedManually` point's `brickClass`, `confidence`, `reviewedManually`, `reviewNote` and
  `brickNote` onto the new point with the same `bmsPointId`;
- every `reviewedManually` plant's same fields onto the new plant with the same `plantId`;
- **whole reviewed plants and zones the remap no longer produces** (the plant or zone is reviewed, or holds
  a reviewed point, and its id is gone from the new mapping): copied over unchanged with all their points,
  printed as "carried over whole" and listed in `summary.carriedOverWhole`. A point of such a group whose
  `bmsPointId` the new mapping already has is left out with a warning (no duplicate ids), and the summary
  totals are recomputed afterwards;
- a warning for every reviewed point or plant that matches nothing in the new mapping (its review is not
  carried; check each one).

Everything else is recomputed: re-run `classify-all.ts` straight after the remap (unreviewed points have no
class until then). A reviewed point keeps its reviewed class even when the new dictionary would give a
better one; to take such changes deliberately, judge them by cause group (brick-assign skill, "After a
dictionary change: class changes by cause group").

## HITL touchpoint 2: the point dictionary, drafted from documentation

The building's `data/{buildingId}/point-dictionary.json` is **drafted, cited, confirmed knowledge**: the agent
drafts every entry from the building's own documents and data, every entry carries its evidence, the human
reviews only what needs judgment, and a tool validates and writes the result. Run it every time this skill is
walked through for a building — the same standing as every other step in this skill's flow.

The dictionary holds every word, id token, id suffix, unit symbol and plant token the building uses, each with
the Brick tags it contributes. Classification code holds none of them: it combines each point's parts from
these entries (brick-assign skill, "Points: classification from parts"). Anything the dictionary does not
say is not known.

There are three moments, all using one mechanism (the draft file and `tools/write-point-dictionary-entry.ts`):

1. **Draft review** — before point mapping (`init --full`): id grammar, word discovery, every entry.
2. **Loop-back** — after point mapping, and again after the equipment inventory (step 4) has image
   `ductPath`s (`init --gaps`): coverage per point, word clashes, the post-image stream check.
3. **Doc-vs-data contradiction check** — inside moment 1, and standalone whenever a document is added to
   `docs-unsorted/` (`review-dictionary-draft.ts --check-only`).

### The one shape

Every building's dictionary has the same sections, whatever its route (`schemaVersion: 3`):

| Section | Entry path | Matches |
|---|---|---|
| id tokens | `tokens.<zone\|plant\|any>.<token>` | the point's token, from the id grammar |
| id suffixes | `suffixes[i]` | a regex `pattern` (`flags` only `i`, `m`, `s`, `u`), tested on the id's suffix parts |
| words | `words[i]` | a literal `phrase`, whole words, in the text `appliesTo` names |
| units | `units.<unit string>` | the point's unit string, exactly (trimmed) |
| overrides | `overrides.<full point id>` | exactly one point, base or flattened suffix point |
| plant tokens | `plantTokens.<token>` | the plant's token (`naming.plantToken`) |
| plant overrides | `plantOverrides.<plantId>` | exactly one plant |
| `meterReadings`, `notEquipment`, `equipmentIdRules` | as named | unchanged sections (`meterReadings` keeps its own `category`; `equipmentIdRules` stay first-match) |

Every part entry has `meaning` (the English label; it becomes the point's `semanticMeaning`), `tags`
(Brick tags), `evidence` (non-empty), optionally `danishGloss`, and in a draft `status` and `review`. There is
no `category`.

- **Contexts.** A token is looked up in its context's table (`zone` or `plant`), else in `any`, never both. A
  building whose tokens mean the same in zones and plants keeps them all under `any`. A suffix or word entry
  applies everywhere unless its `context` names one.
- **Every matching entry contributes.** There is no first-match winner, and the order of `suffixes` and
  `words` decides nothing. An entry carries **only the parts it is sure of for every point it matches**; a
  part that varies across its points is left out and comes from a more specific source.
- **Suffix entries** are tested on each tail of the suffix that starts at a separator (`TR1_SP_AL` tests
  `SP_AL` and `AL`); between two suffix entries the match nearer the end of the id wins a part (`AL` over
  `SP`). A suffix's `meaning` may use `{base}` (the token's meaning) and `{1}`..`{9}` (its capture groups):
  that is how a flattened suffix point gets a self-contained label.
- **Words are literal**: letters, digits, spaces and `. - / '` only, never a regular expression. Matching is
  case-insensitive and whole-word after whitespace normalisation: a match must not touch a letter on either
  side (æ, ø and å are letters; digits are boundaries), so a short word never fires inside a longer one.
  A compound is its own entry. `appliesTo` (default `["description"]`):
  `description` (the point's description), `stateText` (BACnet state texts: active/inactive/state-text
  items, a unit-level source, e.g. On/Off from "Til/Fra"), `plantName` (the plant's name from its image,
  for plant classification), `equipment` (an equipment item's description, for equipment classification).
- **Units.** The standard BACnet engineering-unit names (`degrees-celsius`, `pascals`, `kilowatt-hours`,
  `amperes` …) are one generic table in `tools/lib/units.ts`. A building's `units` holds only its own
  symbols and spellings. `%`, `percent`, `no-units` and an empty unit give no quantity. An unknown unit never
  blocks: the point is classified from its other sources and classify-all counts the unit in its summary.
- **`equipmentType`** (token entries only, optional): the type of the BMS equipment item the token's bare
  points create in `equipment-inventory.json` (`damper`, `valve`, `occupancy` …, the equipment-type
  vocabulary). A token without it creates no item (equipment-inventory skill, "Equipment items from the
  point mapping").
- **Overrides** key on the full point id, so one flattened suffix point can be overridden alone.
- `semanticMeaning` is a label for people and the TTL's `rdfs:label`. No dictionary entry matches it. One
  leftover reads it: when no equipment `ductPath` gives a plant water point its supply/return direction,
  classify-all's water host routing falls back to the description and `semanticMeaning` text, and the point
  gets `needsReview` (a known limitation).

### The mechanism

- **The draft file** is `data/{buildingId}/point-dictionary.draft.json`. It has the dictionary's shape
  plus, per entry, a `status` (`proposed` | `confirmed` | `changed`) and a `review`
  (`{ "docVsData": "agree" | "contradict" | "n/a", "note": "<free text>", "flag": true }`, your judgment),
  and a top-level `accounting` block (`legend` rows with their disposition, `removed` keys with their reason,
  `ignoredWords` with their reason). `status`, `review` and `accounting` are stripped on promotion, except the
  ignored-word records: the dictionary keeps them as `accounting.ignoredWords` (`{ word, reason }`), and the
  next `init` brings them back into the draft. The mappers never read the draft or the ignored words.
- **Never hand-edit the dictionary or the draft.** Every write goes through
  `tools/write-point-dictionary-entry.ts`; there is no direct single-key write mode. The tool validates and refuses a
  bad write with an error message (it names the entry path); nothing is changed on refusal.
- **Run every write from Bash (Git Bash), not PowerShell** — PowerShell 5.1 mangles æ/ø/å piped on stdin.

#### Entry paths

`tokens.zone.TR`, `tokens.any.TR`, `suffixes[0]`, `words[2]`, `units.°C`, `overrides.<full point id>`,
`plantTokens.VE`, `plantOverrides.<plantId>`, `meterReadings`, `meterReadings.readings.KWH`, `notEquipment`,
`equipmentIdRules[0]`. Array entries (`suffixes`, `words`, `equipmentIdRules`) are **appended** when the path
has no index and `--insert` is not given. Position matters only for `equipmentIdRules` (first match wins);
moving an entry shifts the indices other records point at (the tool warns about legend records that moved).

#### Subcommands

```bash
npx ts-node tools/write-point-dictionary-entry.ts init <buildingId> --full|--gaps [--force]
echo '<entry json>' | npx ts-node tools/write-point-dictionary-entry.ts set <buildingId> <path> [--insert <i>]
echo '<json array>' | npx ts-node tools/write-point-dictionary-entry.ts set-batch <buildingId>
npx ts-node tools/write-point-dictionary-entry.ts status <buildingId> <path> [<path> ...] confirmed|changed
npx ts-node tools/write-point-dictionary-entry.ts account <buildingId> legend <file> <row> <disposition> [--note <text>]
npx ts-node tools/write-point-dictionary-entry.ts account <buildingId> removed <path> --reason <text>
npx ts-node tools/write-point-dictionary-entry.ts account <buildingId> ignored-word <word> --reason <text>
npx ts-node tools/write-point-dictionary-entry.ts remove <buildingId> <path>
npx ts-node tools/write-point-dictionary-entry.ts promote <buildingId> [--equipment <inputsDir>]
npx ts-node tools/write-point-dictionary-entry.ts --validate <buildingId> [--equipment <inputsDir>]
```

- **`init --full`** creates the draft from the current dictionary (an empty one-shape dictionary if there is
  none). Every entry is `proposed`, with a `pre-existing` evidence object carrying the old `source` (`"(none)"`
  if it had none). It also creates one `accounting.legend` record per data row of each abbreviations legend
  declared in `profile.inputs.docs.abbreviations`, with an empty disposition, and brings the dictionary's
  ignored-word records in as `proposed` (re-confirm or change each). It refuses to overwrite an
  existing draft without `--force` (a replaced draft loses its review work).
- **`init --gaps`** (moment 2) copies the current entries and the dictionary's ignored-word records in as
  `confirmed` (already decided). It adds no
  placeholder entries: the gaps are what the review lists (coverage per point, uncovered words, word clashes,
  the stream check). Write each new or changed entry through `set`.
- **`set`** reads one entry as JSON on stdin and writes it at `<path>`. `status` defaults to `proposed`. A
  `review` object, if given, must be `{ docVsData?, note?, flag? }`; `flag: true` (boolean) raises a doubt: a
  flagged entry goes to the one-at-a-time list as reason `flagged` (with the note) even when its evidence
  agrees. `set` replaces the whole entry, including its `review`. The entry is structurally
  validated (the whole dictionary with the entry in place); errors are reported against the written path.
- **`set-batch`** reads a JSON array of `{ "path": ..., "entry": {...}, "insert": <i>? }` and applies all items,
  or none: one bad item refuses the whole batch and every problem is listed. Prefer it whenever you write more
  than a couple of entries.
- **`status`** marks an entry `confirmed` or `changed` (a change also carries `human` evidence, below). The path
  may also be `accounting.legend[<i>]`, `accounting.removed[<i>]` or `accounting.ignoredWords[<i>]`. It cannot
  set `proposed`; use `set`. Several paths may be given in one call; the call is all or nothing (one bad path
  refuses every path). Prefer it for confirming a batch.
- **`remove`** deletes one draft entry. It does not record a current dictionary key that disappears with it:
  record that separately with `account ... removed`.
- **`account legend`** records the disposition of one legend row. `<row>` is the 1-based number of the line in the CSV,
  **counting only non-blank lines: the header is row 1, the first data row is row 2** (blank lines are skipped before numbering, in `init` and `account` alike; cite the same number in `doc` evidence as `row <n>`).
  `<disposition>` is `entry:<path>` | `plant-id` | `point-id` | `meter-id` | `wildcard` | `not-in-data` |
  `not-a-token`. The record is (re)set to `proposed`; confirm it with `status ... accounting.legend[<i>] confirmed`.
- **`account removed`** records a current dictionary key that the draft does not carry, with its reason
  (`proposed` until you confirm it with `status ... accounting.removed[<i>] confirmed`).
- **`account ignored-word`** records a description word (one word of letters, as word discovery lists it) that
  carries no part, with its reason. `proposed` until confirmed with `status ... accounting.ignoredWords[<i>]
  confirmed`. `promote` keeps the record in the dictionary and the next `init` brings it back, so a word is
  recorded once.
- **`promote`** refuses while anything is `proposed` (entries, and the records of legend rows, removed keys and
  ignored words), a record is
  missing or invalid (a legend row, a removed current key or an ignored word), the review has a word clash,
  a frequent uncovered word or a point with neither role nor quantity, or the strict check fails; otherwise
  writes `point-dictionary.json` (evidence kept; `status`, `review` and the draft's other records stripped;
  ignored-word records kept as `accounting.ignoredWords`) and deletes the
  draft.
- **`--validate`** strict-validates the dictionary, and the draft if there is one, and lists orphan overrides
  (an override whose id matches no current point). Exit code 1 on any issue.
- **`--equipment <inputsDir>`** (`promote`, `--validate`): the mapping files (and `equipment-inventory.json`
  when it is there) for the open-item, coverage and "decided by this entry" checks come from `<inputsDir>`
  instead of `data/{buildingId}/inputs`. Use it when the building's mapping files are older than the current
  mapper (for example before the first remap with a new dictionary): judge coverage on a fresh remap made in a
  scratch copy, not on stale files. Both print which inputs they used and how many data rows they could not
  check.

### Id grammar and word discovery

Both are drafted by the agent from the building's data and documents, shown to the human with samples and
counts, and confirmed, before the entries are written.

- **Id grammar** (profile `naming`, inventory step 4 above): how a point id splits into **token**, instance
  **number**, an optional **trailing letter**, then separator-delimited **suffix parts**, and how a plant id
  gives its **plant token**. Timeseries splits with `separator`, `pointToken` and `unsplittablePointNames`;
  BACnet with `pointParts`. The mappers write each point's split as `idParts` (`token`, `number`, `suffix`).
  The review prints **grammar samples**: every token with its point count and sample splits, every suffix part
  and every trailing letter with its count. A token that should not exist, or a suffix glued to the wrong
  part, means the grammar is wrong; fix the profile, not the dictionary.
- **Word discovery**: the review lists every distinct description word (descriptions split on non-letters,
  lower-cased) with its count and sample points, most frequent first. Every word occurring at least
  `--word-min` times (default 5) must be **covered**: part of some word entry's phrase, or recorded with
  `account ... ignored-word` and a reason. An uncovered frequent word is open and blocks promotion. Before
  mapping (no mapping files yet) discovery runs on the raw point list or object files.

A word entry is written for the parts the word fixes on every point whose description holds it, e.g. a stream
word → `[Supply, Air]`, a role word → `[Setpoint]`, a qualifier → `[Min, Limit]`. A word whose meaning
depends on its neighbours gets a phrase entry for the combination (below, word clashes).

### The review tool

```bash
npx ts-node tools/review-dictionary-draft.ts <buildingId> [--exclude <b1,b2,...>] [--check-only] [--classes <dir>] [--equipment <inputsDir>] [--word-min <n>]
```

Read-only. It decides every point with **the classifier's own combiner** (the same contributions, levels and
rules as classify-all), so what it reports is what classification will do. It prints, in order:
**one-at-a-time** items, **missing or open records** (a current key the draft neither carries nor records as
removed, an ignored-word record that is empty or still proposed), the open legend records as one table,
**data-only** items, a count of **agrees**, information lines, then the parts sections: word discovery,
grammar samples, coverage, suffix vs description roles, the stream check. Exit code 1 while anything
one-at-a-time or data-only is open, a record is missing or open, a frequent word is uncovered, or a point has neither role nor quantity, so a step can gate
on it.

- **Coverage per point.** Every point must get a role and a quantity from some source. A point with
  **neither** is open (listed with its description). A point with a quantity and no role gets the Sensor
  fallback at low confidence; those are listed as information (they become touchpoint 3 work if left).
- **Word clashes** (one at a time, reason `word-clash`, grouped by description): two words in one
  description give different roles and neither contains the other. Resolve with a phrase entry for the
  containing words (the whole description or the words that belong together) that carries the right role: a
  containing phrase settles the clash between the words inside it. A phrase without a role does not settle a
  role clash between role words inside it. A clash that still reaches classification leaves the role to the
  next source and flags the point (low confidence).
- **Suffix vs description roles** (information): points whose suffix entry and description words give
  different roles. The suffix wins by the source order; check that it should.
- **Stream check** (information, needs `--equipment`): every entry carrying a stream tag whose points span
  more than one image `ductPath`, and every point whose `ductPath` stream disagrees with a description stream
  word. The image wins at classification; the list shows where an entry's stream tag is too broad.
- **Entries that decide no point** are listed as information.
- `--equipment <inputsDir>`: the points (and their image `ductPath`, from that directory's
  `equipment-inventory.json`) come from there. Without it they come from `data/{buildingId}/inputs` and the
  stream check is skipped. Use it at the post-image loop-back, and whenever the real mapping files are older
  than the current mapper.
- `--exclude` removes buildings from the cross-building notes. **Always exclude a legacy copy of the same
  building** (an older data folder for the building you are drafting): it would otherwise be compared as if it
  were another building.
- `--check-only` prints only the doc-vs-data contradictions (moment 3).
- `--classes <dir>` compares tags from a scratch mapping (made with the staged draft) with the classes in the
  building's real mapping files; used when verifying a draft before a remap, not in the normal flow.

### What the agent drafts from

1. **The documents** named in `profile.inputs.docs` (abbreviation legends, function descriptions, zone matrix),
   then the rest of `docs-unsorted/`, read through `search-supporting-docs.ts <buildingId> <query>`.
   A tabular legend is read row by row and **every row gets a disposition**. XLSX is reported "unsupported";
   use a CSV equivalent where there is one.
2. **The building's own data:** the point list's Danish descriptions per token and suffix (timeseries), or the
   object descriptions, units, object types and state texts (bacnet). These give `data` evidence and the
   other side of the contradiction check. On a BACnet building this includes the **vendor devices**: a
   `parent` device's register names (e.g. a valve's position, flow and energy registers) become token,
   suffix or override entries as their id parts dictate, and the vendor's own descriptions (often English:
   "setpoint", "write 1 to …", "shows …") become word entries, cited from the object rows and, where the
   building has one, the vendor's manual. The **device points** (controller-wide objects: schedules, overrides,
   communication alarms, unnamed `Analog Value n` registers) need entries like any other point. There is no
   vendor table in code: a register's meaning in one building is at most a suggestion for another.
3. **The current dictionary:** every entry is carried over as `pre-existing` evidence, plus whatever new
   evidence the draft finds.

**What gets an entry.** Every token, suffix, frequent word and unit symbol that **occurs in the building's
data**, and every plant token. A document-only abbreviation (a legend row with no matching data) gets **no
entry**: record it with `account ... legend <file> <row> not-in-data`.

**The building's documentation is faulty best-case evidence, not truth.** A document entry that the building's own
point-list descriptions contradict is a contradiction for the human, never an automatic winner.

### Evidence: the four kinds

Every entry has a non-empty `evidence` array. `notEquipment` and `equipmentIdRules` entries hold no meaning,
so they carry `evidence` but no `tags`.

| `kind` | Fields | Checked at write |
|---|---|---|
| `doc` | `file` (relative to `data/{buildingId}/`), `location` (free text, e.g. `row 12`, `line 340`), `quote` (verbatim, original language) | The file exists and its extracted text (CSV/JSON raw; PDF through the same extraction and cache as `search-supporting-docs.ts`) contains `quote` after whitespace normalisation. An unreadable file makes the quote **unverifiable**, which is an error. |
| `data` | `rows`: up to 5 `{ pointId, description }`, verbatim; `count`: how many points the entry decides (information only) | Every `pointId` exists in the raw inputs (timeseries: the point list, ids composed as the mapper composes them: parent + `naming.separator` + point), its description matches verbatim, and (point entries, when mapping files exist) the classifier's combiner says this entry decides a part of that point. Only empty descriptions is not evidence. |
| `human` | `answer` (the human's words), `date` | Non-empty. |
| `pre-existing` | `source` (the old `source` string, or `"(none)"`) | Only on entries carried over from the current dictionary. |

A legend row cited as `doc` evidence uses `location: "row <n>"`, with `<n>` numbered as `account legend` numbers it
(non-blank lines, header = row 1).

### Tags

`tags` is an array of Brick tags (`Sensor`, `Setpoint`, `Temperature`, `Air`, `Supply`, `Min`, `Limit`, ...).
Required on every part entry (an empty array is allowed); every tag must be a tag of some class in
`ontologies/brick-classification-index.json` (checked at write, in the review and at promotion). The tags
are what classification reads.

- **An entry states only what it fixes.** Classification decides each part (role, quantity, medium, water
  kind, stream, subject, intent, occupancy) from the first source in the order override → image `ductPath` →
  id suffix → description words → id token → unit / object type / state texts → plant type, and pools every
  other tag. So a suffix that sets a role replaces the token's role (and its On/Off), a description stream
  word replaces a token's stream, and a qualifier such as `Min` or `Deadband` is added from wherever it comes.
  Tag what the source itself says, not a guess at the final Brick class.
- **A token describes its bare point.** Its tags include the role of the point the token names on its own: a
  token for a temperature sensor carries `Sensor`. A token carries no role only when its bare points genuinely
  have mixed roles; those points then need their role from a suffix or description word (coverage lists the
  ones that get none).
- **At most one role tag per entry** (`Sensor`, `Setpoint`, `Command`, `Status`, `Alarm`, `Parameter`). `On` and
  `Off` belong to the role: a role-less `On`/`Off` contribution (state texts) refines a decided `Status` or
  `Command` that carries neither.
- **A stream tag only when every point the entry decides is on that stream** (`Supply`, `Return`, `Exhaust`,
  `Outside`, `Intake`, `Mixed`, `Zone` …). Before tagging a token, list its bare points by instance number and
  description. If the descriptions differ, the stream depends on the point (often on its position, e.g.
  before or after a heat-recovery wheel), so the token carries quantity, medium and role only; the point's
  image `ductPath`, else its description words, decide the stream. The post-image stream check lists the
  entries this rule missed.
- **Never tag a point entry with the water frame** (`Leaving`, `Entering`, `District`) or `Discharge`: the
  classifier adds them (Discharge with Supply; the frame from the equipment host routing). Copies on point
  entries are ignored.
- **Plant tokens and plant words** carry the tags of the plant's Brick equipment or system class
  (`[AHU, Air, Equipment, Handler, Handling, Unit]`), plus `District` where the plant is a district-heat
  boundary (the host routing then adds it to its boundary points).

### The cross-building rule

The rule, verbatim:

- The building's own documentation always wins.
- If another building defined the same token differently, show it as a note on the draft (flagged because the
  token is risky, not because the draft is wrong).
- If the documentation is silent, offer another building's meaning as a suggestion labelled "seen in {b},
  not confirmed here". Never applied automatically.
- If documentation and prior buildings agree, say nothing.

Interpretation:

- "Documentation" means `doc` evidence only.
- An entry with only `data` evidence is still decided by the building's own data. Another building's meaning then
  appears as a note only where it differs, never as a suggestion that competes with the data.
- With neither `doc` nor `data` evidence, the "seen in {b}" suggestion applies.
- Meaning **and** tags are compared; a difference in either produces the note. The comparison covers `zone`
  and `plant` token entries against the same context's tokens in the other dictionaries; `any` tokens are not
  compared yet.

Never copy another building's meaning into this building's dictionary yourself: the same token can mean something
different per building. The note and the suggestion are shown to the human, who decides.

### Moment 1 — draft review (before point mapping)

1. **Id grammar** confirmed in the profile (inventory step 4).
2. `init <buildingId> --full`. Note the data's tokens and suffixes and the legend rows that each need a record.
3. **Draft.** Read the documents and the point list; write every entry with `set` / `set-batch` (meaning,
   tags, `danishGloss` if useful, evidence, `review`; `equipmentType` on tokens whose points are equipment),
   carrying every current entry; record every legend row (`account ... legend`); record every current key
   you do not carry with `account ... removed`; cover or ignore every frequent word (word discovery).
   Quote Danish **verbatim** with file and location — no translation; quoting is more faithful than paraphrasing.
4. `review-dictionary-draft.ts <buildingId> [--exclude ...]`. Work the buckets in order:
   1. **One at a time:** doc-vs-data contradictions; entries whose meaning or tags differ from the
      pre-existing entry; flagged entries; gaps (no `doc` and no `data` evidence); unsupported pre-existing
      entries (only `pre-existing` evidence); new entries; word clashes; and every
      missing or open record (a current key the draft neither carries nor records as removed, a legend row
      with no record, an open ignored-word record). Show
      the human the evidence side by side with your proposal; the human confirms, changes or skips.
   2. **One table, confirm-all:** data-only entries. The human may name rows to
      change; those go through the one-at-a-time flow.
   3. **A count, list on request:** agrees.
   4. **Open lists:** uncovered frequent words and points with neither role nor quantity; each gets an entry
      (or an ignored-word record).
   5. Cross-building notes sit on the entry they concern, inside 1–3.
5. **Record the answer.** A confirmation: `status ... confirmed`. A change: `set` the entry with `human` evidence
   (the answer verbatim, the date) and `status: "changed"`. **One confirmation per entry, not per point.**
6. The draft file holds the state; re-running the review shows only what is still open. Re-run until it exits 0.
7. `promote <buildingId>` (when the building's mapping files may take the new dictionary), then run the mapper.

#### How the review was actually run (method used so far)

The steps above are the contract; in practice the review went in agent-assessed batches, approved in chat:

1. Run the review; for a large draft, export it with
   `npx ts-node tools/export-dictionary-review.ts <out.json> <buildingId> [--exclude <b,...>]` (drafts,
   `reviewDraft` buckets and notes, legend dispositions, per-entry Brick class fits with definitions).
2. Assess it in batches, bucket by bucket, applying the rules in "The review tool" and "What the agent drafts from"
   above. Per batch, show the human the entries with your assessment (agree, change, or open question) and the
   evidence behind it; contradictions one at a time, the rest as tables.
3. The human approves, or corrects, in chat. Nothing is applied before that.
4. Apply through the write tool only: approvals as one multi-path `status ... confirmed`, corrections as `set`
   (or one `set-batch`) with `human` evidence (`answer` quoting the approval, for example "Approved in chat:
   <the human's words>", and `date`) and `status: "changed"`.
5. Re-run `review-dictionary-draft.ts` until it exits 0, as in step 6.

**Option: the interactive review page.** `export-dictionary-review.ts <out.html> <buildingId>` fills
`tools/review-page/dictionary-review.template.html`, a one-card-per-entry page for the human to answer on
directly (published as a claude.ai artifact). It was used once, then replaced by the batch method as faster. Applying
its answers is manual, and it is not an official pipeline step. Offer it to the human for a large draft, as an
alternative to the batch review in chat.

### Moment 2 — loop-back after point mapping (and after step 4)

What the mapper and the classifier could not decode comes back through the same mechanism:

- the mapping summary's `unresolvedTokens` (points no dictionary entry labels: their `semanticMeaning` is
  their description) and `unresolvedSuffixes` (suffixes no suffix entry matches), also printed by the mapper;
- the review's coverage, word discovery and word clashes on the mapped points;
- after the equipment inventory has image `ductPath`s (step 4): the stream check, with
  `--equipment data/{buildingId}/inputs`.

1. `init <buildingId> --gaps`, then for each gap run
   `npx ts-node tools/search-supporting-docs.ts {buildingId} <token or word>`:
   - **Match found** -> propose the entry, quoting the Danish text verbatim with the file and location the
     search returned, for a yes/no confirm.
   - **No match** -> ask the human, structured, one item at a time.
2. `set` each confirmed answer (with its evidence and tags); the same review and `promote` follow.
3. **Materialize the whole batch in one pass** — confirm and write every answer first, then one mapper
   run and one reclassify:
   1. Re-run the mapper with `--force` to write the new dictionary's labels and id parts into the output JSON.
      The confirmed `danishGloss` backfills a point's `danishDescription` **only when the raw description was
      blank** (BACnet: an override's `danishGloss` replaces the object's description for that point, and
      `rawDescription` keeps the original). Reviewed points, plants and whole reviewed groups are carried over ("How to run" above); read
      the carry-over summary and every warning it prints.
   2. Immediately re-run `classify-all.ts` for this building, then generate and validate the TTL. Unreviewed
      points have no class between the two runs.

### Moment 3 — doc-vs-data contradiction check

- **Inside moment 1:** set `review.docVsData` on every entry that has both `doc` and `data` evidence
  (`agree` / `contradict`; `n/a` when only one kind). Silent on agreement; only disagreements reach the human.
  The check runs against the point list's own descriptions, which is how a faulty legend is caught.
- **Standalone:** whenever a document is added to `docs-unsorted/`, search the new document for the dictionary's
  tokens and words, update `review` on the entries concerned (or add `doc` evidence), and run
  `npx ts-node tools/review-dictionary-draft.ts <buildingId> --check-only`. It prints only contradictions and
  exits 1 while any remain. It needs a draft: run `init <buildingId> --gaps` first (current entries come in as
  `confirmed`) if there is none.

### Example: one entry, written and confirmed

A zone token of `DEMO-TS` (skill-00, "The example buildings") whose legend row says room temperature sensor
and whose point-list descriptions agree (a building's own meanings and ids are in its own dictionary and
profile):

```bash
echo '{"meaning":"Room Temperature Sensor","tags":["Zone","Air","Temperature","Sensor"],
"danishGloss":"Temperatur rum","review":{"docVsData":"agree"},
"evidence":[{"kind":"doc","file":"docs-unsorted/<legend>.csv","location":"row 12","quote":"TR;Temperatur rum"},
{"kind":"data","rows":[{"pointId":"Z_101_TR1","description":"Temperatur rum"}],"count":2}]}' \
 | npx ts-node tools/write-point-dictionary-entry.ts set DEMO-TS tokens.zone.TR
npx ts-node tools/write-point-dictionary-entry.ts status DEMO-TS tokens.zone.TR confirmed
npx ts-node tools/write-point-dictionary-entry.ts account DEMO-TS legend docs-unsorted/<legend>.csv 12 entry:tokens.zone.TR
```

### Example: what the one shape holds in the two example buildings

- The timeseries example (`DEMO-TS`) keeps `zone` and `plant` token tables: its zone token carries the zone
  tags (`tokens.zone.TR` [Zone, Air, Temperature, Sensor] in `Z_101`), its plant tokens do not
  (`tokens.plant.TI` in `VE01`, `tokens.plant.TF` in `VA07`, whose Hot comes from the parent plant's class
  tags). A building whose letters mean one thing in a zone and another in a plant needs the two tables. The
  BACnet example (`DEMO-BN`), whose tokens mean the same everywhere, keeps them all under `any`
  (`tokens.any.TF` for `RAD01_TF1`, `tokens.any.TR` for `Z_201_TR1`).
- `DEMO-TS` marks its setpoints with an id suffix part (`Z_101_TR1_SP`), so it has a suffix entry
  `^SP(?=_|$)` → `[Setpoint]`. A trailing letter or an opaque configuration-register family is a suffix entry
  in the same way (a register family → `[Parameter]`).
- `DEMO-TS`'s units are symbols (`°C`, `m³/h`) and need unit entries (`units.°C`); `DEMO-BN` uses the standard
  unit names only (`degrees-celsius`) and has none.
- A plant the sources cannot classify gets a `plantOverrides` entry (e.g. a plant whose objects look like
  another kind of equipment, or a plant whose image is not captured yet, kept at its earlier class).

## Zone↔room matching

Runs **after point mapping** (it reads the zones from `zone-point-mapping.json` `zones[].zoneId`, for both
routes) and writes `data/{buildingId}/inputs/spatial-hierarchy.json`. It needs `inputs/ifc-spatial.json`
(step 1, `python tools/build-spatial-hierarchy.py --building {buildingId}`) and the building's dictionary.
The building's zone↔room knowledge lives in **`data/{buildingId}/zone-rooms.json`** (rule, second-source rows,
check flags, human decisions), written only through:

```bash
echo '<json>' | npx ts-node tools/write-zone-rooms.ts {buildingId} rule|sources|checks|decisions
npx ts-node tools/write-zone-rooms.ts {buildingId} --validate
npx ts-node tools/match-zone-rooms.ts {buildingId} --review      # read-only: what needs the human
npx ts-node tools/match-zone-rooms.ts {buildingId} [--force]     # writes spatial-hierarchy.json
```

The write tool merges the section (sources by `id`, checks by `kind:source`, decisions by zone id) and
writes only if the whole file validates (regexes compile, every source row cites, levels are integers, every
decision has an action, a reason and `answered`, a created room has number + level + citation and does not
reuse an IFC room number). Run the `echo ... |` writes from Bash (Git Bash), not PowerShell (æ/ø/å).
Without a `zone-rooms.json` the matcher still writes floors and rooms, with every zone `unlinked`.

### 1. Room, storey and use-group words (dictionary)

Room and storey classes come from the building's dictionary, not code (brick-assign skill, "Rooms and
storeys"). List the distinct IFC space names, storey names and space categories from `ifc-spatial.json`
(and the overview's use-group values, step 3) and draft word entries in the HITL touchpoint 2 flow
(`write-point-dictionary-entry.ts`, review, promote):

| `appliesTo` | Carries | Evidence rows (`data`) |
|---|---|---|
| `roomName` | `recClass` (e.g. `rec:Classroom`) | `pointId` = IFC room number, `description` = its IFC name |
| `storeyName` | `recClass` (roof storey → `rec:RoofLevel`) or `exclude: true` (a storey that is not a floor) | `pointId` = `description` = the IFC storey name |
| `spaceCategory` | `exclude: true` (IFC spaces that are not rooms) | `pointId` = room number, `description` = the category |
| `useGroup` | `recClasses` (the room classes the group fits) | `pointId` = zone id, `description` = the source's name |

Matching is whole-word, longest phrase first, so draft entries from the building's own distinct names (a word
inside a longer word does not match). Every distinct name word is an entry or an `accounting.ignoredWords`
record. `recClass`/`recClasses` must exist in `brick-classification-index.json` (the matcher reports any that
do not). Storeys are numbered from elevation alone (level 0 = the storey at elevation 0, else the lowest
above; below it −1, −2, …; floor ids `level-{n}`, `level-m{n}`); below elevation 0 → `rec:BasementLevel`.
`--review` lists the room, storey and use-group names that no word covers.

### 2. Draft the rule

The rule (`rule.kind: "idTemplates"`) is an **ordered list of templates**: a regular expression over the
zone id and a replacement giving a room number. A zone takes the **first template whose result is a room
number the IFC has**; a zone no template places has no proposed room. Draft it from the building's own zone
ids and IFC room numbers, with evidence per template (what it handles, example zones, hit count). Show the
human the rule's hit rate and its misses. The zone-id format and the room-number format are this building's
data (in `zone-rooms.json`), never code. A template's optional group must not leak "undefined" into the room
number (the write tool checks only that each pattern compiles with its flags and that `room` is
non-empty, so check the optional-group case yourself).

### 3. Read the second sources (one source row per zone per source, each cited)

Sources the profile lists (a building without one skips it). Each row holds `zoneId` plus the values the
source states — `roomNumber`, `level` (an **integer level number**: translate the source's storey text when
writing the row and cite the text read), `name`, `useGroup` — and a `cite` (file + page/row, or image path).
Record on the source which column gave which value (`columns`).

- **Zone matrix / commissioning documents (PDF):** the PDF text layer is unreliable — `pdftotext -layout`
  scrambles columns and pairs the wrong zone with the wrong room. Read the rows with
  `pdftotext -raw -enc UTF-8` (into the scratchpad) or from the rendered page, and spot-check several rows
  against the rendered page before writing.
- **Room-overview screens** (`inputs.images.roomsOverview`): tabbed tables, one image per floor/wing tab.
  One image at a time, **crop-first** (skill-00 "BMS Image Reading Protocol"; never read values from the full
  frame): the building's screen guide (`bmsScreens`) says where the tab bar, table and header fields are; crop
  the tab bar to identify the active tab, then the table. Write that image's rows before the
  next image (CLAUDE.md rule 2; the source's `rows` grow per image — re-send the whole source each time). Take
  the level from the tab or a level column, the name, room number and use-group columns where the screen has
  them. Report a tab that has no screenshot. The same reading also feeds the zone names into
  `equipment-inventory.json`, unchanged:
  ```bash
  echo '{"zones":[{"zoneId":"<zone>","zoneFunction":"<name>"}],"wingTab":"<tab>","sourceImage":"rooms_overview/<img>.png","confidence":"high"}' | npx ts-node tools/update-equipment.ts {buildingId} --type zone-meta
  ```
  Live values on these screens (temperatures, CO2, valve %) prove which zone a row is, not which room; they
  are not recorded.
- **Room-schematic headers** (`inputs.images.rooms`): one header crop per image
  (`python tools/crop-image.py <img> --region header=<x0,y0,x1,y1> --scale 2`, the band measured on the
  building's first schematic; the screen guide says where the header fields are), zone id + zone name only (panel
  fields such as the controller's location describe the controller, not the zone), saved after each image.
  Read fresh: `equipment-inventory.json` `zoneFunction` mixes readings with no provenance.
- **Feeds** (`{ "id": "feeds", "kind": "feeds", "file": "inputs/building-connections.json", "rows": [] }`):
  no rows; the check compares `building-connections.json` `plantFeedsZone` with the installation IFC's
  room → plants (`ifc-spatial.json` `roomPlants`). It exists only after the image step: **re-run the matching
  (and `--review`) after step 3** writes the feeds; until then the check is reported as skipped.

A source row may name a zone that is not in the zone list; the review reports it ("in a document, not in the
zone list"), nothing more.

### 4. Checks and the two fixed flags

Each check (`kind:source`) compares one value per zone with a proposed room: `number` (row's room number vs
proposed), `floor` (row's level vs the room's storey level), `name` (row's name vs the IFC room name:
lower-cased, spaces/punctuation removed, then equal, containment, or edit distance ≤ 2), `useGroup` (the
room's class is within the group's `recClasses`; `unknown` for a plain `rec:Room`), `feeds` (the zone's
plant is among the plants serving the room). Each gives `pass`, `fail` (with the values) or `unknown`.

The flags are **computed by fixed written rules**, shown to the human with the rule, and stored as computed
(`write-zone-rooms.ts … checks`, with `agreement`):

- **`counts`** = `pass / (pass + fail)` ≥ **80%** (unknown excluded). A counting check's `fail` is a
  disagreement for the human; a non-counting check is evidence only.
- **`independent`**: `name`, `useGroup` and `feeds` are independent. A `number` or `floor` check is
  independent only if the source states the value in a field of its own **and** the value does not occur
  verbatim in the zone id (then it only confirms the rule was read correctly).

Never adjust a flag to make a result come out; if the human disagrees with a computed flag, store their value
in `override` with a reason (`by`, `date`), so the computed flag and the override both stay visible.

### 5. Review and decisions (HITL)

`--review` prints, contradictions first: **disagreements** (a counting check fails), **no room** (no
template gives an IFC room), **rule only** (no fail but no independent pass — one group decision, not zone by
zone), **in a document, not in the zone list** (reported only), **stale decisions**, the per-check agreement
with computed vs stored flags, the names no dictionary word covers, and issues. Record the review output
before showing it to the human. The human confirms the rule and the flags first, then each listed zone, one
at a time; per zone one of:

| `action` | Result |
|---|---|
| `accept` | the proposed room |
| `room` | another IFC room (`roomId`) |
| `create` | a room created from the documents (`room`: number, name, level, `cite` list); written as `source: "documents"` (not in the IFC) |
| `unlinked` | no room, with the reason |

Write each answer exactly as given (`by: "user"`, date, the reason in the user's words) with `answered` =
the proposed room and the check results the review showed. A decision carried over from earlier work cites
its source in `carriedOver`. Re-run `--review` until nothing is open, then write with `match-zone-rooms.ts`.

**Reuse and stale:** on every re-run a decision is reused while its `answered` still matches (same proposed
room, same check results). If the rule, a source or the dictionary changes what it answered, or a created
room's number now exists in the IFC, the decision is **stale**: the zone is left unlinked and listed for the
human to answer again — never applied silently. A decision for a zone no longer in the zone list is listed
as stale too.

**Output** (`spatial-hierarchy.json`): `floors`, `rooms` (`source: "ifc" | "documents"`) and zone-centred
`zones[]` (`status` `matched` / `created` / `unlinked`, `roomIds`, `floorId` — the room's storey, or for an
unlinked zone the level from the first source row giving one — `name`/`useGroup` from the first source in
`sources` order, and `evidence`: template, check results, decision). The rerun guard refuses to overwrite a
classified file without `--force`; re-run `classify-all.ts` straight after.

#### Example: the two example buildings

- `DEMO-TS` (zones `Z_101`, `Z_102`): one template `^Z_(\d)(\d{2})$` → `$1.$2` (`Z_101` → room `1.01`); zone
  matrix (room number counts and is independent — "1.01" is not verbatim in `Z_101`; its level is), overview
  screens and schematic headers. An atrium zone matched to a balcony room came up as a name disagreement; a
  zone with no IFC room got a room created from the documents.
- `DEMO-BN` (zone `Z_201`): its own rule, here the template `^Z_(?<level>\d)(?<room>\d{2})$` →
  `$<level>.$<room>` (`Z_201` → room `2.01`; a building may need several templates, tried in order); the
  overview's level (`2`) occurs in the zone id `Z_201`, so its floor check is not independent (a value read
  off the id only confirms the rule); its schematic names are mostly nicknames (name checks below 80%,
  evidence only); the use-group and feeds checks count.

## Output structure (Example)

Both files share the same structure. **Points are flat** — per CLAUDE.md rule 5, a CSV suffix row
(e.g. `_SP`) is composed into a self-contained sibling `Point`, never nested under a parent. Zone example
(`DEMO-TS`, its dictionary holding `tokens.zone.TR` and the suffix entry `^SP(?=_|$)` as `suffixes[0]`),
after `classify-all.ts` (the mapper writes everything up to `tsdb`; classify-all adds the rest). The `zones`
array is abbreviated: `Z_102`, with the same two points, is left out.

```json
{
  "buildingId": "DEMO-TS",
  "generatedAt": "2026-01-15T09:00:00.000Z",
  "summary": {
    "totalZones": 2,
    "totalPoints": 4,
    "matchedToTsdb": 2,
    "unmatchedCsvPoints": 2,
    "unmatchedTsdbObjects": 0,
    "unresolvedTokens": {},
    "unresolvedSuffixes": {}
  },
  "zones": [
    {
      "zoneId": "Z_101",
      "pointCount": 2,
      "points": [
        {
          "pointAbbreviation": "TR1",
          "bmsPointId": "Z_101_TR1",
          "idParts": { "token": "TR", "number": "1", "suffix": null },
          "semanticMeaning": "Room Temperature Sensor",
          "danishDescription": "Temperatur rum",
          "alarmClass": "A2",
          "tsdb": { "id": "Z_101_TR1", "objectType": "AnalogInput", "objectInstance": 101, "units": "°C" },
          "brickClass": "Zone_Air_Temperature_Sensor",
          "confidence": "high",
          "tags": ["Sensor", "Temperature", "Air", "Zone"],
          "partSources": { "role": "token:tokens.zone.TR", "quantity": "token:tokens.zone.TR", "medium": "token:tokens.zone.TR", "stream": "token:tokens.zone.TR" },
          "classificationAlternatives": ["Air_Temperature_Sensor", "Temperature_Sensor"]
        },
        {
          "pointAbbreviation": "SP",
          "bmsPointId": "Z_101_TR1_SP",
          "idParts": { "token": "TR", "number": "1", "suffix": "SP" },
          "semanticMeaning": "Room Temperature Sensor Setpoint",
          "danishDescription": "Setpunkt temperatur rum",
          "alarmClass": "",
          "tsdb": null,
          "brickClass": "Target_Zone_Air_Temperature_Setpoint",
          "confidence": "high",
          "tags": ["Setpoint", "Temperature", "Air", "Zone", "Target"],
          "partSources": { "role": "suffix:suffixes[0]", "quantity": "token:tokens.zone.TR", "medium": "token:tokens.zone.TR", "stream": "token:tokens.zone.TR" },
          "classificationAlternatives": ["Air_Temperature_Setpoint", "Temperature_Setpoint"]
        }
      ]
    }
  ],
  "unmatched": {
    "csvPointsNotInTsdb": ["Z_101_TR1_SP", "Z_102_TR1_SP"],
    "tsdbObjectsNotInCsv": []
  }
}
```

`unresolvedTokens` / `unresolvedSuffixes` map a token or suffix to the number of points no dictionary entry
labels (moment 2 above). classify-all also writes `classFlags`, `needsReview` and `brickNote` on a point when
they apply, and keeps a `reviewedManually` point's class.

Plant output is identical but uses `plants[]` with `plantId` instead of `zones[]` with `zoneId`, and its
summary has `totalPlants` and `systemRows` (system alarm rows left out) instead of `totalZones`; classify-all
also writes each plant's `brickClass`, `tags`, `partSources` and (when flagged) `classFlags`. A plant point the
mapper synthesizes from `objects.json` (a meter reading with no point-list row, decoded with the dictionary's
`meterReadings`) carries a point-level `source` saying where it came from:

```json
{
  "pointAbbreviation": "KWH",
  "bmsPointId": "VA07_QM1_KWH",
  "idParts": { "token": "QM", "number": "1", "suffix": "KWH" },
  "semanticMeaning": "Heat Meter Energy",
  "danishDescription": "",
  "alarmClass": "",
  "tsdb": { "id": "VA07_QM1_KWH", "objectType": "AnalogInput", "objectInstance": 7, "units": "kWh" },
  "source": "synthesized (2026-08-25) from objects.json (TSDB) -- no CSV pointlist row for this reading"
}
```

A BACnet mapping has a top-level `source: "bacnet-scrape"` and no `unmatched` block (no `matchedToTsdb` or
`unmatched*` counts). Its plant summary has `totalPlants`, `totalPoints`, `zones`, `zonePoints`, the walk's
counts (`byRule`, `skipped`, `merged`, `toDevice`, `devicePoints`, `duplicates`, `duplicatesKeptApart`; see
the object-name grammar above) and `unresolvedTokens` / `unresolvedSuffixes` across plants, zones and
devices; its zone summary has `totalZones`, `totalPoints` and `unlabelled`. A BACnet mapping also carries,
per plant and zone, `groupedBy` (the object rule or device rule that produced it) plus
`deviceInstance`/`deviceName`, and in `plant-point-mapping.json` a `devices` array
(`{ deviceInstance, deviceName, pointCount, points }`: the controller-wide device points). A BACnet point's
`tsdb` is its BACnet reference (`id` = object-name, `objectType`, `objectInstance`, `deviceInstance`,
`units`, and `stateTexts` when the object has state texts); `rawDescription` keeps the object's own
description where an override's `danishGloss` replaced it; `groupingRule` names the `toDevice` rule that made
an object a device point.

## Id grammar and meanings: profile and dictionary

A building's point-id grammar and the meanings of its parts are data, not skill text.
Each lives in the building's own folder and is never shared between buildings (the same token can mean
something different per building):

- **Grammar** — `naming` (and, timeseries, `pointListFormat`) in `data/{buildingId}/building-config.json`:
  how the point list is read (`pointListFormat`), how a plant/zone id is cut into parent, separator and point
  token (`naming.zoneId`, `separator`, `pointToken`, `unsplittablePointNames`), which plant, zone or device a
  BACnet object belongs to (`objectNames`), the BACnet point-part grammar (`pointParts`), the plant token
  (`plantToken`) and the air-direction marker (`airDirectionMarker`).
- **Meanings** — `data/{buildingId}/point-dictionary.json`, the one shape above: `tokens`, `suffixes`, `words`,
  `units`, `overrides`, `plantTokens`, `plantOverrides`, plus `meterReadings`, `notEquipment` and
  `equipmentIdRules`.

Read these files for the building at hand; do not carry a token or suffix meaning over from another
building. A token, suffix or word that is missing is resolved in touchpoint 2 (moment 2, the loop-back) above
and written to the dictionary with its evidence.

## CSV row types (Example)

Row shapes the point list can hold, shown with `DEMO-TS` ids (skill-00, "The example buildings"). Which
shapes exist, and how the Plant column is classified as zone or plant, comes from the building's
`naming.zoneId`.

| Pattern | Example Plant | Example Point | Full BMS ID | Interpretation |
|---------|--------------|---------------|-------------|----------------|
| Zone only | `Z_101` | `TR1` | `Z_101_TR1` | Zone-level point |
| Zone, suffix in Point | `Z_101` | `TR1_SP` | `Z_101_TR1_SP` | Flat suffix point of `TR1` |
| Zone+Point | `Z_101_SPI1` | `POS` | `Z_101_SPI1_POS` | Flat suffix point of the supply air damper `SPI1` |
| Plant | `VE01` | `TI1` | `VE01_TI1` | Plant-level point |
| Plant composite | `VA07_QM1` | `FLOW` | `VA07_QM1_FLOW` | Flat suffix point of the heat meter `QM1` |

Plant parent ids can contain the separator, so the plant mapper matches the longest prefix against the
Plant column values. Both mappers handle composite rows where the Plant column holds parent plus point.

## Coverage gap interpretation

- **CSV → no TSDB**: Normal, often the larger share. Setpoints, configuration parameters, and alarm settings that live in the BMS controller but have no time-series. Still important for Brick modeling.

- **TSDB → no CSV**: Live measurement points (often airflow and damper position readings, test modes, energy meters) that exist in the TSDB but weren't in the alarm export. Only meter readings the plant mapper synthesizes (the
  dictionary's `meterReadings`, above) become points; the others are listed in the mapping's
  `unmatched.tsdbObjectsNotInCsv`, not classified.

## Timeseries vs BACnet point mapping

The profile's `dataShape` picks the mapper. A `timeseries` building (point-list CSV + `objects.json`
TimescaleDB registry) uses `map-plant-points.ts` + `map-zone-points.ts`, driven by the profile's
`naming` and `pointListFormat`. A `bacnet` building (per-device BACnet scrape, no `objects.json`) uses
`map-bacnet-points.ts`, which produces both mapping files in one pass: it walks the devices, places each
object in its plant or zone (or makes it a device point, or skips it) with `naming.objectNames`, and splits the
point part with `naming.pointParts`. Both routes read the same one-shape dictionary and write the same point
fields; they differ only in where the id, description, unit, object type and state texts come from. Vendor
device registers are decoded by the building's own dictionary entries like any other point; there is no
vendor table or vendor-specific classification source.

Dictionaries must never be merged or shared between buildings, even though they are the same shape — the same
token can mean something different per building, so a combined table would be actively wrong, not just
imprecise.

### Example: the same token, two buildings

In one timeseries building `SP` is Spjæld (damper); in one BACnet building `SP` is Setpunkt (setpoint).
Neither reading may be reused for the other, which is why each building's `point-dictionary.json` stands
alone and why a BACnet building's tokens are decoded from its own descriptions.

## Using the output for Brick classification

classify-all.ts reads, per point:
1. **`idParts`** → the token and suffix entries that apply
2. **`danishDescription`** (and BACnet `tsdb.stateTexts`) → the word entries that apply
3. **`tsdb.units`** → the quantity (dictionary unit entries, then the generic BACnet unit table)
4. **`tsdb.objectType`** → the binary/analog consistency checks only (never the role)
5. the image **`ductPath`** of the point's equipment item (its own, else its base point's) from
   `equipment-inventory.json`, and the owning plant's class tags (a device point has no plant tags)

`semanticMeaning` is not read for the class. In a timeseries mapping, **`unmatched.tsdbObjectsNotInCsv`**
lists the TSDB objects with no point-list row (a BACnet mapping has no `unmatched` block). classify-all does
not read it: such an object becomes a point to classify only when the plant mapper synthesizes it (a meter
reading, "Output structure" above).
