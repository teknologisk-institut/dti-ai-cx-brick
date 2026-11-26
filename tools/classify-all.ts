/**
 * classify-all.ts
 *
 * Programmatic Brick (nightly) classification for all building entities.
 * Reads source data files, applies mapping rules, writes brickClass
 * directly into each file. Flags ambiguous cases as confidence: "low".
 *
 * Usage:
 *   npx ts-node tools/classify-all.ts <buildingId> [--dry-run] [--only plants|equipment|spatial|zones|points]
 *
 * --dry-run: report what would be classified without writing
 * --only:    run only one section (for incremental use)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { loadPointClasses, loadPlantClasses, combineParts, matchPointClass, classTags, PART_TAGS, isBinarySensorMismatch, isNonBinaryCommandMismatch, isUngroundedBinaryClaim, dropContradicting, loadEquipmentClasses, deriveEquipmentTags, matchEquipmentClass, equipmentWordTags, refineMarkerClass } from './lib/tag-match'
import { loadProfile, dataRoot, BuildingProfile } from './lib/building-profile'
import { pointIdSeparator, correlateEquipmentId, plantTokenOf } from './lib/point-id'
import { classifyPlant } from './lib/plant-class'
import { loadPartsDictionary, PartsDictionary } from './lib/point-dictionary'
import { collectContributions, pointInputsFromMapping } from './lib/point-parts'
import { unitQuantity } from './lib/units'
import { roomClass, storeyClass } from './lib/room-class'
import { getPlantSystem } from './lib/plant-system'
import { isInterfaceSide, sideRole } from './lib/water-sides'

const args = process.argv.slice(2)
const buildingId = args[0]
if (!buildingId) { console.error('Usage: npx ts-node tools/classify-all.ts <buildingId>'); process.exit(1) }

let profile: BuildingProfile
try {
  profile = loadProfile(buildingId)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
let pointIdSep: string
try {
  const sepInfo = pointIdSeparator(profile)
  pointIdSep = sepInfo.separator
  if (sepInfo.note) console.log(sepInfo.note)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const dryRun = args.includes('--dry-run')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null

const inputDir = resolve(dataRoot(), buildingId, 'inputs')
const dataDir  = resolve(dataRoot(), buildingId)

// The building's point dictionary (one shape, schemaVersion 3): the per-part sources for plants and
// points, and the equipment description words.
let pointDict: PartsDictionary | null = null
if (!only || only === 'points' || only === 'plants' || only === 'equipment' || only === 'spatial') {
  try {
    pointDict = loadPartsDictionary(buildingId)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}

// ─── Load files ───────────────────────────────────────────────────────────────

function load(path: string) {
  if (!existsSync(path)) { console.error(`Missing: ${path}`); process.exit(1) }
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const plantPm  = load(resolve(inputDir, 'plant-point-mapping.json'))
const zonePm   = load(resolve(inputDir, 'zone-point-mapping.json'))
const spatial  = load(resolve(inputDir, 'spatial-hierarchy.json'))
const brickIdx = load(resolve(__dirname, '..', 'ontologies', 'brick-classification-index.json'))

// Optional: equipment-inventory.json (image-derived). Buildings without image
// extraction (e.g. a BACnet scrape) have no equipment inventory; every
// access below is guarded with ?./|| [], so default to an empty structure.
const equipPath = resolve(inputDir, 'equipment-inventory.json')
const equipInv = existsSync(equipPath) ? JSON.parse(readFileSync(equipPath, 'utf-8')) : {}

// Optional: building-connections.json for plantServesPlant chain
const connPath = resolve(inputDir, 'building-connections.json')
const connections = existsSync(connPath) ? JSON.parse(readFileSync(connPath, 'utf-8')) : null

// Build serving-plant lookup: plantId → ids of the plants that serve it
// e.g. if VA07 (Hot_Water_System) serves VE01, then servingSystemFor['VE01'] includes 'VA07',
// whose class gives 'heating' (getWaterContext step 3)
const servingSystemFor = new Map<string, Set<string>>()
if (connections?.plantServesPlant) {
  for (const rel of connections.plantServesPlant) {
    for (const targetId of rel.servesPlantIds || []) {
      if (!servingSystemFor.has(targetId)) servingSystemFor.set(targetId, new Set())
      servingSystemFor.get(targetId)!.add(rel.plantId)
    }
  }
}

// Build equipment ductPath lookup: plantId+pointAbbr → ductPath
const equipDuctPath = new Map<string, string>()
const plantSystemType = new Map<string, string>()
for (const pe of equipInv.plantEquipment || []) {
  if (pe.systemType) plantSystemType.set(pe.plantId, pe.systemType)
  for (const eq of pe.equipment || []) {
    if (eq.ductPath) {
      equipDuctPath.set(`${pe.plantId}:${eq.id}`, eq.ductPath)
    }
  }
}

// deviceInstance → deviceName, built from every plant's own device fields — used
// by resolvePointHost()'s Controller fallback to route a point onto ITS OWN
// physical device when that differs from its containing plant's (e.g. a shared/
// cross-referenced reading actually read from a different AS controller).
const deviceNameByInstance = new Map<number, string>()
for (const plant of plantPm.plants) {
  if (plant.deviceInstance != null && plant.deviceName) deviceNameByInstance.set(plant.deviceInstance, plant.deviceName)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classExists(name: string): boolean {
  if (brickIdx.classes[name]) return true
  if (brickIdx.classes['brick:' + name]) return true
  if (brickIdx.classes['rec:' + name]) return true
  return false
}

function resolveClass(name: string): string {
  // Store without prefix for consistency in our files
  // But verify it exists with prefix
  if (brickIdx.classes['brick:' + name]) return name
  if (brickIdx.classes['rec:' + name]) return 'rec:' + name
  if (brickIdx.classes[name]) return name
  return name // return as-is, will be flagged
}

function isSystemClass(brickClass: string): boolean {
  if (!brickClass) return false
  const key = brickClass.startsWith('brick:') || brickClass.startsWith('rec:') ? brickClass : 'brick:' + brickClass
  return (brickIdx.classes[key] as any)?.category === 'System'
}

// A sensor-location marker in equipment-inventory.json (e.g. "TS1" carrying a Point-family
// class like Water_Temperature_Sensor) can never be a valid hasPoint host -- Brick's
// isPointOfShape requires Equipment/Location/Space. Routing must not self-correlate a sensor's
// own reading point to its own marker entry; it must fall through to a real captured Equipment.
function isEquipmentClass(brickClass: string): boolean {
  if (!brickClass) return false
  const key = brickClass.startsWith('brick:') || brickClass.startsWith('rec:') ? brickClass : 'brick:' + brickClass
  return (brickIdx.classes[key] as any)?.category === 'Equipment'
}

// ─── Points from parts ─────────────────────────────────────────────────────────
//
// Every point is classified by one mechanism: its contributions from the building's point
// dictionary (override, image ductPath, id suffix, description words, id token, unit/state
// texts, plant class) are combined per part (tools/lib/tag-match.ts combineParts) and Brick's
// own class tags pick the class (matchPointClass). The water Leaving/Entering/District frame
// comes from the host routing below, unchanged.

// Tagged Brick Point classes, indexed once for the point matcher.
const libPointClasses = loadPointClasses(brickIdx)

// Tagged Brick Equipment and System classes, indexed once for the plant matcher.
const plantClasses = loadPlantClasses(brickIdx)

// Tagged Brick Equipment classes, indexed once for the matcher-first equipment classifier.
const equipmentClasses = loadEquipmentClasses(brickIdx)

const stats = {
  plants: { total: 0, classified: 0, low: 0 },
  equipment: { total: 0, classified: 0, low: 0 },
  floors: { total: 0, classified: 0, low: 0 },
  rooms: { total: 0, classified: 0, low: 0 },
  zones: { total: 0, classified: 0, low: 0 },
  points: { total: 0, classified: 0, medium: 0, low: 0 },
  subpoints: { total: 0, classified: 0, low: 0 },
  flags: {} as Record<string, number>,          // point classification flags, by kind
  unknownUnits: { points: 0, strings: new Set<string>() },
}

const flagged: string[] = []

// ─── PLANTS ───────────────────────────────────────────────────────────────────
//
// Every unreviewed plant from its parts (tools/lib/plant-class.ts): the plant override, else the
// plant-token entry + the plant's own name words + the parent plant's medium, matched against
// Brick's Equipment and System classes; the image equipment composition decides when there is no
// token entry and is the check when there is one. The parent is the longest other plant id this
// plant's id starts with (then the separator), so plants are classified shortest id first.

function classifyPlants() {
  const dict = pointDict as PartsDictionary
  const ordered = [...plantPm.plants].sort((a: any, b: any) => a.plantId.length - b.plantId.length)
  for (const plant of ordered) {
    stats.plants.total++
    if (plant.reviewedManually) { stats.plants.classified++; continue }
    const pid = plant.plantId

    const parent = plantPm.plants
      .filter((p: any) => p !== plant && pid.startsWith(p.plantId + pointIdSep))
      .sort((a: any, b: any) => b.plantId.length - a.plantId.length)[0]
    const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === pid)
    const r = classifyPlant(dict, plant, {
      token: plantTokenOf(profile, pid),
      plantName: peq?.plantName || '',
      parentTags: parent?.brickClass ? plantClassTags(parent.brickClass) : [],
      equipmentTypes: peq?.equipment?.map((e: any) => e.type) || [],
    }, plantClasses)

    plant.brickClass = resolveClass(r.brickClass)
    plant.tags = r.tags
    plant.partSources = r.sources
    if (r.flags.length > 0) plant.classFlags = r.flags
    else delete plant.classFlags
    delete plant.brickNote
    for (const f of r.flags) flagged.push(`Plant ${pid}: ${f.kind} (${f.detail})`)
    if (r.flags.length > 0) stats.plants.low++
    else stats.plants.classified++
  }
}

// ─── EQUIPMENT ────────────────────────────────────────────────────────────────

// A plant's water kind from its Brick class tags: Domestic + Hot → dhw (plain domestic water, e.g.
// Domestic_Water_Loop, is none of the three), Chilled → chilled, Hot → heating.
function classWaterContext(brickClass: string): 'heating' | 'chilled' | 'dhw' | null {
  const tags = classTags(brickIdx, brickClass)
  if (tags.has('Domestic') && tags.has('Hot')) return 'dhw'
  if (tags.has('Chilled')) return 'chilled'
  if (tags.has('Hot')) return 'heating'
  return null
}

// Determine water system type for a specific point on a plant,
// using: 1) ductPath from equipment-inventory, 2) plant's own image systemType, 3) serving plant
// chain, 4) the plant's Brick class tags
function getWaterContext(plantId: string, pointAbbr: string, plantBrickClass: string): 'heating' | 'chilled' | 'dhw' | null {
  // 1) ductPath from equipment-inventory (most reliable — from plant image)
  const dp = equipDuctPath.get(`${plantId}:${pointAbbr}`)
  if (dp === 'water_supply' || dp === 'water_return') {
    // Check which coil this is on by looking at equipment near this point
    // If the plant has a cooling_coil and this point is associated with it → chilled
    const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plantId)
    const eqTypes = new Set((peq?.equipment || []).map((e: any) => e.type))
    // If plant has both heating and cooling coils, check point description or nearby equipment
    if (eqTypes.has('cooling_coil') && eqTypes.has('heating_coil')) {
      // Ambiguous — fall through to serving plant chain
    } else if (eqTypes.has('cooling_coil')) {
      return 'chilled'
    } else if (eqTypes.has('heating_coil')) {
      return 'heating'
    }
  }

  // 2) Plant's own systemType from equipment-inventory -- authoritative for THIS plant's own
  // water context. Checked before the serving-plant chain (step 3): a plant fed BY another
  // plant (e.g. a Domestic_Hot_Water_System heated via a heating plant's primary loop) is still its
  // own distinct water system when it has a confirmed one of its own -- its points describe
  // its own DHW context, not the heating plant's Hot_Water_System, even though that plant supplies
  // it energy. Found when a heating plant genuinely `servesPlantIds` a DHW plant in
  // building-connections.json, which was silently overriding every DHW point's medium from 'dhw' to
  // 'heating' when this check ran second, before the DHW plant's own captured systemType ever got
  // consulted.
  const st = plantSystemType.get(plantId)
  if (st === 'cooling' || st === 'chiller') return 'chilled'
  if (st === 'heating') return 'heating'
  if (st === 'dhw') return 'dhw'

  // 3) Serving plant chain from building-connections.json -- fallback for a plant with no
  // specific water context of its own (e.g. a ventilation plant fed by a separate heating/
  // chilled water plant for its coil, where step 2 above found nothing plant-specific).
  const servingPlantIds = servingSystemFor.get(plantId)
  if (servingPlantIds) {
    // Look up each serving plant's brickClass to determine its system type
    for (const spId of Array.from(servingPlantIds)) {
      const sp = plantPm.plants.find((p: any) => p.plantId === spId)
      if (!sp?.brickClass) continue
      const spSys = classWaterContext(sp.brickClass)
      if (spSys) return spSys
    }
  }

  // 4) Fallback to the plant's own Brick class tags
  return classWaterContext(plantBrickClass)
}

// Pass 1 step 1: correlate a point's abbreviation against the plant's
// captured sub-equipment by ID prefix. Longest eqId first, so "V1" doesn't
// shadow a longer id that happens to share a prefix. A match requires either an
// exact id match, or the point's abbreviation to start with the equipment id
// followed only by lowercase letters/digits/underscores (e.g. "V1y"→"V1",
// "P1a"/"P1c"→"P1") — never a match against an unrelated abbreviation that
// merely shares a short prefix.
//
// bmsPointId fallback (2026-08-25): the mappers' suffix rules flatten a suffix sub-row's own
// pointAbbreviation down to its bare suffix (e.g. "SP"), discarding the
// base equipment id that made it correlatable in the first place — only
// bmsPointId still carries it (`${plantId}_${eqId}_${suffix}`). Without this,
// correlateEquipment can never ID-match ANY flattened subpoint (the bare suffix
// never starts with a real equipment id), so every one of them fell through to
// the much weaker Pass 1 step 2 same-direction fallback in resolvePointHost,
// which just grabs the first equipment on the matching side — confirmed via a
// full-data audit to misroute the majority of flattened setpoints onto an
// unrelated pump/valve instead of their own base sensor's equipment (a sensor's
// setpoint sub-row routing to a pump instead of to that sensor).
// Exact-match only, deliberately no fuzzy regex: bmsPointId is machine-composed
// by the mappers' suffix rules, not free text, so there is nothing to fuzz against — either
// it equals the composed id exactly, or the point isn't that subpoint.
function correlateEquipment(plantId: string, pointAbbreviation: string, bmsPointId?: string): string | null {
  const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plantId)
  if (!peq) return null
  const ids: string[] = (peq.equipment || [])
    .filter((e: any) => isEquipmentClass(e.brickClass || 'HVAC_Equipment'))
    .map((e: any) => e.id)
    .sort((a: string, b: string) => b.length - a.length)
  // The id-matching logic lives in lib/point-id.ts (pure, tested with both separators).
  return correlateEquipmentId(ids, plantId, pointAbbreviation, bmsPointId, pointIdSep)
}

// Boundary/exchanger-interface plants (equipment-inventory/SKILL.md's "Boundary/exchanger
// interface" ductOrientation shape) capture a richer position vocabulary than the plain
// water_supply/water_return pair -- e.g. a heat-exchanger plant's primary_supply/primary_return/
// secondary_supply/secondary_return, a DHW plant's primary_supply/primary_return/dhw_supply/
// dhw_makeup/dhw_circulation_return. Direction is the value's own suffix regardless of prefix; the prefix
// itself is a SEPARATE signal (see isBoundarySideDuctPath below) -- conflating the two was the
// original bug (values were being force-collapsed to canonical form, discarding the prefix).
// dhw_makeup is deliberately excluded: it's the cold-water main feed into a DHW system (per a
// DHW plant's own legend), not a hot-water supply/return direction at all -- no direction to derive.
function extendedRawDirection(dp: string | undefined): 'supply' | 'return' | '' {
  if (!dp || dp.endsWith('makeup')) return ''
  if (dp === 'water_supply' || dp === 'supply' || dp === 'preheat' || dp.endsWith('_supply')) return 'supply'
  if (dp === 'water_return' || dp === 'return' || dp.endsWith('_return')) return 'return'
  return ''
}

// A ductPath prefixed 'primary_' names the district/boundary side of a boundary/exchanger
// interface (equipment-inventory/SKILL.md's worked example) -- true regardless of the hosting
// equipment's own Brick class (a valve or pump on the primary side is still boundary-side; its
// class alone can't say so, see BOUNDARY_EQUIPMENT_CLASS_RE below for the class-based signal this
// complements). Plain water_ prefixes (no confirmed exchanger interface captured) are the plant's
// own loop side.
function isBoundarySideDuctPath(dp: string | undefined): boolean {
  return !!dp && dp.startsWith('primary_')
}

// A ductPath prefixed 'secondary_' names the OTHER side of the same confirmed boundary/exchanger
// interface -- the building's own downstream port, where water genuinely leaves the exchanger
// toward the load (2026-08-25: previously treated identically to plain loop equipment, losing
// this signal entirely -- found via a heat-exchanger plant's own legend, whose secondary_supply is
// where water exits after the heat exchanger, the same physical claim as plain 'boundary' role's own
// definition below). Same (non-reversed) polarity as a class-detected boundary device's own
// downstream port -- NOT the same as 'primary_', which is the opposite (upstream/district-facing)
// port and has inverted polarity (see hostRole/waterDirectionTag). Deliberately narrower than
// "any non-primary_ side of a confirmed-interface plant": 'dhw_'-prefixed equipment (a DHW plant's
// own vocabulary for its downstream side) already reaches the identical Entering_/Leaving_ answer via
// the separate DHW-medium override in waterDirectionTag, so leaving it out here avoids two
// mechanisms asserting the same thing through different evidence -- generalize this check only if
// a future building's downstream-side vocabulary doesn't fit either existing mechanism.
function isSecondarySideDuctPath(dp: string | undefined): boolean {
  return !!dp && dp.startsWith('secondary_')
}

// Pass 1 step 1/2: the point's raw supply/return signal — the linked
// equipment item's ductPath first, then the point's own item's ductPath (a sensor
// item: image-verified, ranked above text), Danish description fallback last. This is the same regex tag-match.ts's
// removed Water branch used, relocated here since Pass 1 now owns it.
function resolveRawDirection(plantId: string, point: any, correlatedEqId: string | null, ownDuctPath?: string): 'supply' | 'return' | '' {
  if (correlatedEqId) {
    const dp = equipDuctPath.get(`${plantId}:${correlatedEqId}`)
    const extended = extendedRawDirection(dp)
    if (extended) return extended
  }
  const own = extendedRawDirection(ownDuctPath)
  if (own) return own
  // a makeup feed (cold water into a DHW exchanger or tank) has no direction; its side settles that, so
  // no description word may give it one
  if (ownDuctPath?.endsWith('makeup')) return ''
  const desc = (point.danishDescription || '').toLowerCase()
  const dm = desc + ' ' + (point.semanticMeaning || '').toLowerCase()
  if (/fremløb|(^|\W)frem(\W|$)|supply/.test(dm)) return 'supply'
  if (/returløb|retur|(^|\W)return/.test(dm)) return 'return'
  return ''
}

type PointHost = { hostType: 'equipment' | 'controller'; hostId: string }

function sameSide(eqDuctPath: string | undefined, rawDirection: 'supply' | 'return' | '', pointOwnDuctPath?: string): boolean {
  if (!eqDuctPath || !rawDirection) return false
  if (extendedRawDirection(eqDuctPath) !== rawDirection) return false
  // Same raw direction isn't enough on its own for a boundary/exchanger-interface plant: a
  // temperature sensor on secondary_return (the building's own loop return) and a valve on
  // primary_return (the district side) are both "return" but on opposite sides of the heat
  // exchanger -- routing the sensor to the valve would misclassify it as boundary-side. When the
  // point itself has a captured ductPath with a definitive boundary-side signal, require the candidate to be on the same side.
  if (pointOwnDuctPath !== undefined && isBoundarySideDuctPath(pointOwnDuctPath) !== isBoundarySideDuctPath(eqDuctPath)) return false
  return true
}

// Pass 1 of the two-pass resolution: resolve where a point attaches.
// Returns null only when the plant is *_System-classified, no equipment
// correlation or directional match exists, AND the building fails the
// Controller-granularity precondition — the
// caller must treat that as genuinely unresolved, not substitute a guess.
// baseId: the point's base point id (token + number); a flattened suffix point's own abbreviation is
// the bare suffix, so its image ductPath is found under the base point's id.
function resolvePointHost(plant: any, point: any, correlatedEqId: string | null, rawDirection: 'supply' | 'return' | '', baseId: string): PointHost | null {
  if (!isSystemClass(plant.brickClass)) {
    // Not a System plant — no routing fault (hasPoint on Equipment is already
    // legal). Self-referential host so Pass 2 can still look up a role.
    return { hostType: 'equipment', hostId: plant.plantId }
  }
  // Routing step 1: ID-prefix match.
  if (correlatedEqId) return { hostType: 'equipment', hostId: correlatedEqId }
  // Routing step 2: directional role match — no ID correlation, but some
  // captured equipment on this plant has a ductPath on the same side as this
  // point's raw signal (generalizes beyond pump+valve to whatever equipment
  // shape the plant actually has, per the routing-algorithm review finding).
  if (rawDirection) {
    const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)
    const pointOwnDuctPath = equipDuctPath.get(`${plant.plantId}:${point.pointAbbreviation}`) ?? equipDuctPath.get(`${plant.plantId}:${baseId}`)
    const sideMatch = (peq?.equipment || []).find((e: any) => isEquipmentClass(e.brickClass || 'HVAC_Equipment') && sameSide(e.ductPath, rawDirection, pointOwnDuctPath))
    if (sideMatch) return { hostType: 'equipment', hostId: sideMatch.id }
    // Routing step 2b: a point on an interface side (primary_/secondary_/dhw_) with no pump or valve
    // on that side is hosted on the plant's confirmed reference device -- the exchanger or tank the
    // water passes through -- when that device is an Equipment-class item (2026-11-21 water-side
    // design). Otherwise on to the Controller fallback; update-equipment --validate reports it.
    if (isInterfaceSide(pointOwnDuctPath)) {
      const ref = peq?.ductOrientation?.referenceEquipment
      const refItem = ref ? (peq?.equipment || []).find((e: any) => e.id === ref) : undefined
      if (refItem && isEquipmentClass(refItem.brickClass || '')) return { hostType: 'equipment', hostId: ref }
    }
  }
  // Routing step 3: Controller fallback — gated on the granularity precondition.
  // Prefer the POINT's own device over the plant's when they disagree (a real,
  // if rare, shared/cross-referenced reading — e.g. a flow reading whose own
  // tsdb.deviceInstance is a different physical controller than its plant's
  // plant-level device) — falls back to the plant's device when the point's own
  // instance is absent or its deviceName can't be resolved from any other plant.
  const pointDeviceInstance = point.tsdb?.deviceInstance
  if (pointDeviceInstance != null && pointDeviceInstance !== plant.deviceInstance) {
    const pointDeviceName = deviceNameByInstance.get(pointDeviceInstance)
    if (pointDeviceName) return { hostType: 'controller', hostId: `${pointDeviceInstance}|${pointDeviceName}` }
  }
  if (plant.deviceInstance != null && plant.deviceName) {
    return { hostType: 'controller', hostId: `${plant.deviceInstance}|${plant.deviceName}` }
  }
  // A timeseries building has no per-point BACnet deviceInstance, but its plant schematics can show
  // a real station/panel automation identity -- use that as an alternate, non-BACnet Controller
  // key when captured in equipment-inventory.json.
  const peqForCtrl = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)
  if (peqForCtrl?.station && peqForCtrl?.controller) {
    return { hostType: 'controller', hostId: `${peqForCtrl.station}|${peqForCtrl.controller}` }
  }
  return null   // building can't resolve a Controller — deferred, not guessed
}

// Pass 2: what role does the point's resolved host play?
// Boundary equipment: sits between two distinct water circuits. Beyond
// literally-named Heat_Exchanger/Meter, a Chiller's evaporator and an AHU's own
// water-side coil are the same kind of interface (Brick nightly's Entering_/
// Leaving_ definition is generic — "a piece of equipment or system", not
// heat-exchanger-specific) -- found via a sanity check, where a
// self-referential Chiller/AHU host was defaulting to 'loop' with no explicit
// check, misclassifying loop-equipment-only Supply_/Return_ onto equipment that
// isn't a loop's own pump/valve.
const BOUNDARY_EQUIPMENT_CLASS_RE = /Heat_Exchanger|Chiller|Air_Handling_Unit|Meter/

type WaterRole = 'loop' | 'boundary' | 'boundary-primary' | 'controller' | null

function hostRole(plant: any, pointHost: PointHost | null, ownDuctPath?: string): WaterRole {
  if (!pointHost) return null
  if (pointHost.hostType === 'controller') return 'controller'
  if (pointHost.hostId === plant.plantId && BOUNDARY_EQUIPMENT_CLASS_RE.test(plant.brickClass || '')) return 'boundary'   // self-referential boundary-class host
  const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)
  // Hosted on the confirmed reference device (routing step 2b): the device has several ports, so the
  // point's own side names the port -- primary_ the district-facing one (inverted polarity), secondary_
  // and dhw_ the downstream one.
  if (pointHost.hostId === peq?.ductOrientation?.referenceEquipment) {
    const role = sideRole(ownDuctPath)
    if (role) return role
  }
  const eq = peq?.equipment?.find((e: any) => e.id === pointHost.hostId)
  const eqClass = eq?.brickClass || ''
  // primary_-prefixed ductPath (see isBoundarySideDuctPath) names the district-facing side of a
  // boundary/exchanger interface directly from the human-confirmed legend -- checked before the
  // class guess below, since it's the only signal that can correctly place an ancillary device
  // (valve, pump, sensor) that sits on that side without itself being a boundary-classed device
  // (Heat_Exchanger/Chiller/AHU/Meter). A valve's or pump's own class never encodes which side of
  // an interface it's on. Distinguished from plain 'boundary' (class-detected, e.g. a Meter or
  // Chiller's own downstream-facing supply/return) because the two have OPPOSITE polarity: water
  // "leaving" a downstream-facing boundary flows toward the load, but water "leaving" the
  // district-facing (primary) side flows back out to the district -- see waterDirectionTag.
  if (isBoundarySideDuctPath(eq?.ductPath)) return 'boundary-primary'
  // secondary_-prefixed ductPath (see isSecondarySideDuctPath) names the OTHER, downstream side of
  // the same confirmed interface -- same (non-reversed) polarity as plain 'boundary', so it maps
  // there directly rather than to a third role value.
  if (isSecondarySideDuctPath(eq?.ductPath)) return 'boundary'
  if (BOUNDARY_EQUIPMENT_CLASS_RE.test(eqClass)) return 'boundary'
  return 'loop'
}

// Pass 2: the final direction tag, from role + Pass 1's raw signal.
// Controller-hosted points get no directional tag at all (return '').
//
// Entering/Leaving is relative to the boundary device's own ports, not "us vs. the district" --
// confirmed against a real four-position interface (a heating and a DHW plant's heat exchangers): water flowing
// from the exchanger to the downstream/secondary side is Leaving; from the district/primary side
// into the exchanger is Entering; from the exchanger back out to the district is Leaving; from the
// downstream side back into the exchanger is Entering. A 'boundary' (class-detected, e.g. a plain
// Meter/Chiller/AHU with no primary/secondary split captured) reading describes the downstream-
// facing port, where supply/fremløb genuinely leaves the device toward the load -- supply=Leaving,
// return=Entering. A 'boundary-primary' (primary_-prefixed ductPath) reading describes the
// district-facing port instead, which is the opposite port of the same device -- so the polarity
// inverts: primary_supply (Fremløb, hot water arriving from the district) is water entering the
// device; primary_return (Returløb, cooled water) is water leaving it back to the district.
function waterDirectionTag(role: WaterRole, rawDirection: 'supply' | 'return' | '', isDhw = false): string {
  if (!role || role === 'controller' || !rawDirection) return ''
  if (role === 'boundary-primary') return rawDirection === 'supply' ? 'Entering' : 'Leaving'
  // DHW has no Supply_/Return_ variant at all (only Entering_/Leaving_), even for loop-hosted
  // points (skill-00-context.md's water-convention rule) -- the medium alone forces this axis,
  // independent of role. Standard (non-reversed) polarity: this isn't a primary-side reading.
  if (role === 'boundary' || (role === 'loop' && isDhw)) return rawDirection === 'supply' ? 'Leaving' : 'Entering'
  return rawDirection === 'supply' ? 'Supply' : 'Return'
}

function classifyEquipmentItem(eq: any, parentBrickClass: string, parentId: string): void {
  stats.equipment.total++
  if (eq.reviewedManually) { stats.equipment.classified++; return }
  const t = eq.type || ''
  const sys = getPlantSystem(parentBrickClass)

  const { tags, anchor } = deriveEquipmentTags(t, eq.description || '', sys, eq.medium || null, (pointDict as PartsDictionary).words)
  const matcherPick = matchEquipmentClass(tags, anchor, equipmentClasses)

  let brickClass: string | null = matcherPick
  let brickNote: string | undefined

  if (!brickClass) {
  // Direct type mappings
  const typeMap: Record<string, string> = {
    'supply_fan': 'Supply_Fan',
    'return_fan': 'Return_Fan',
    'exhaust_fan': 'Exhaust_Fan',
    'heating_coil': 'Heating_Coil',
    'cooling_coil': 'Cooling_Coil',
    'filter': 'Filter',
    'fire_damper': 'Damper',
    'air_quality_sensor': 'CO2_Sensor',
    'presence_sensor': 'Occupancy_Sensor',
    'occupancy': 'Occupancy_Sensor',
    'humidity_sensor': 'Humidity_Sensor',
    'diff_pressure_sensor': 'Differential_Pressure_Sensor',
    'mixing_damper': 'Mixed_Damper',
    'outside_damper': 'Outside_Damper',   // AHU outside-air intake damper (normalized type)
    'exhaust_damper': 'Exhaust_Damper',   // AHU exhaust-to-atmosphere damper (normalized type)
    'chiller_compressor': 'Chiller',
    'cooling_unit': 'Chiller',
    'energy_meter': 'Energy_Sensor',
    'flow_meter': 'Water_Flow_Sensor',
    'temperature_setpoint': 'Temperature_Setpoint',
    'storage_tank': 'Hot_Water_Storage_Tank',
    'meter': 'Building_Water_Meter',
    // Real devices
    'compressor': 'Compressor',
    'fan_coil_unit': 'Fan_Coil_Unit',
    'blind': 'Blind',
    'fume_hood_damper': 'Damper',          // no fume-hood-specific damper class in Brick nightly
    // Sensors / alarms / commands are Points in Brick, never Equipment -- same treatment
    // 'temperature_sensor' already gets below. generate-ttl never emits a Point-classed
    // inventory entry as equipment; the real BMS point carries the telemetry.
    'temperature': 'Temperature_Sensor',
    'cold_draft_sensor': 'Temperature_Sensor',
    'pressure': 'Pressure_Sensor',
    'pressure_sensor': 'Pressure_Sensor',
    'light_sensor': 'Illuminance_Sensor',
    'leak_sensor': 'Leak_Alarm',
    'leak_alarm': 'Leak_Alarm',
    'alarm': 'Alarm',
    'command': 'Command',
    'digital_input': 'Status',
    'timer_button': 'Command',
  }

  if (typeMap[t]) {
    brickClass = typeMap[t]
  }

  // Context-dependent types. Pump, valve, damper, wheel and exchanger types always find a class
  // through the matcher above (their anchor class has no other tags), so they need no branch here.
  if (!brickClass) {
    if (t === 'temperature_sensor') {
      // The description refines the marker's class through the building's equipment word entries.
      brickClass = refineMarkerClass('Temperature_Sensor', equipmentWordTags(eq.description || '', (pointDict as PartsDictionary).words), libPointClasses)
    }
    else if (t === 'other') {
      brickClass = 'HVAC_Equipment'
      brickNote = 'Unclassified equipment type'
      flagged.push(`Equipment ${parentId}/${eq.id}: type=other`)
    }
  }
  } // end if (!brickClass) — legacy fallback chain

  if (!brickClass) {
    brickClass = 'HVAC_Equipment'
    brickNote = `Unknown equipment type: ${t}`
    flagged.push(`Equipment ${parentId}/${eq.id}: unknown type ${t}`)
  }

  eq.brickClass = resolveClass(brickClass)
  if (matcherPick && !brickNote) eq.confidence = 'high'
  else delete eq.confidence
  if (brickNote) eq.brickNote = brickNote
  if (brickNote) stats.equipment.low++
  else stats.equipment.classified++
}

function classifyEquipment() {
  // Plant equipment
  for (const pe of equipInv.plantEquipment || []) {
    const plant = plantPm.plants.find((p: any) => p.plantId === pe.plantId)
    const plantClass = plant?.brickClass || 'HVAC_Equipment'
    for (const eq of pe.equipment || []) {
      classifyEquipmentItem(eq, plantClass, pe.plantId)
    }
  }
  // Zone equipment
  for (const ze of equipInv.zoneEquipment || []) {
    for (const eq of ze.equipment || []) {
      classifyEquipmentItem(eq, 'HVAC_Zone', ze.zoneId)
    }
  }
}

// ─── SPATIAL ──────────────────────────────────────────────────────────────────
// Floors are already numbered by match-zone-rooms; this only classifies. The class words live in the
// building's dictionary (lib/room-class.ts); a name with no matching word stays rec:Room / rec:Level.

function classifyFloors() {
  const dict = pointDict as PartsDictionary
  for (const floor of spatial.floors || []) {
    stats.floors.total++
    if (floor.reviewedManually) { stats.floors.classified++; continue }
    floor.brickClass = storeyClass(floor.name || '', floor.elevation_mm ?? null, dict)
    stats.floors.classified++
  }
}

function classifyRooms() {
  const dict = pointDict as PartsDictionary
  for (const room of spatial.rooms || []) {
    stats.rooms.total++
    if (room.reviewedManually) { stats.rooms.classified++; continue }
    room.brickClass = roomClass(room.name ?? null, dict).recClass
    if (room.brickClass === 'rec:Room') stats.rooms.low++
    else stats.rooms.classified++
  }
}

// ─── ZONES ────────────────────────────────────────────────────────────────────

function classifyZones() {
  for (const zone of zonePm.zones) {
    stats.zones.total++
    if (zone.reviewedManually) { stats.zones.classified++; continue }
    zone.brickClass = 'rec:HVACZone'
    stats.zones.classified++
  }
}

// ─── POINTS ───────────────────────────────────────────────────────────────────

const WC2HC: Record<string, string> = { heating: 'Hot', chilled: 'Chilled', dhw: 'Dhw' }

// The medium tags (Air, Water, Hot, Chilled, Domestic) of a plant's Brick class: the plant level's
// contribution to its points.
const PLANT_MEDIUM_TAGS = new Set([...PART_TAGS.medium, ...PART_TAGS.waterKind])
function plantClassTags(brickClass: string): string[] {
  return Array.from(classTags(brickIdx, brickClass)).filter(t => PLANT_MEDIUM_TAGS.has(t))
}

type PointInput = ReturnType<typeof pointInputsFromMapping>[number]

// A point's contributions → combined parts (and whether its unit was known).
function combinePoint(input: PointInput, hostFrame: string[], isZone: boolean) {
  const dict = pointDict as PartsDictionary
  const uq = unitQuantity(input.units, dict.units)
  const combined = combineParts(collectContributions(dict, input), { hostFrame, isZone, unitTags: uq.tags, objectType: input.objectType })
  return { combined, unitKnown: uq.known }
}

// The part → "<level>:<entry>" that decided it, without the parts whose every tag is in `dropped`.
function partSourcesOf(combined: ReturnType<typeof combineParts>, dropped: string[] = []): Record<string, string> {
  const partSources: Record<string, string> = {}
  for (const [part, d] of Object.entries(combined.decidedBy)) {
    const had = PART_TAGS[part].filter(t => combined.tags.includes(t))
    if (d && !(had.length > 0 && had.every(t => dropped.includes(t)))) partSources[part] = `${d.level}:${d.entry}`
  }
  return partSources
}

// A class's tags for the contradiction test: an alias takes its equivalent's tags, as in the matcher.
const pointClassByKey = new Map(libPointClasses.map(c => [c.key, c.tags]))
const reviewedClassTags = (brickClass: string) => pointClassByKey.get(brickClass) ?? classTags(brickIdx, brickClass)

// A reviewed point keeps its class, confidence, notes and flags. It gets its combined tags (so they
// reach the TTL) minus the tags that contradict a part its reviewed class decides, and the sources
// of the parts it keeps.
function tagReviewedPoint(point: any, input: PointInput, hostFrame: string[], isZone: boolean): void {
  const { combined } = combinePoint(input, hostFrame, isZone)
  const all = combined.tags.filter(t => t !== 'Point')
  const tags = dropContradicting(all, reviewedClassTags(point.brickClass))
  point.tags = tags
  point.partSources = partSourcesOf(combined, all.filter(t => !tags.includes(t)))
}

// One unreviewed point: contributions → combined parts → Brick class, written onto the point.
// lowSignal: the host routing's direction came from the description fallback (sets needsReview only; confidence stays as matched).
function classifyPointFromParts(point: any, input: PointInput, hostFrame: string[], isZone: boolean, lowSignal: boolean): string {
  const { combined, unitKnown } = combinePoint(input, hostFrame, isZone)
  if (!unitKnown) { stats.unknownUnits.points++; stats.unknownUnits.strings.add(input.units.trim()) }
  const m = matchPointClass(combined, libPointClasses)

  let brickClass = resolveClass(m.brickClass)
  let confidence: string = m.confidence
  if (isBinarySensorMismatch(point.tsdb?.objectType, brickClass)) {
    point.brickNote = `demoted: binary objectType conflicts with continuous Sensor class ${brickClass}`
    brickClass = 'Point'
    confidence = 'low'
  } else if (isNonBinaryCommandMismatch(point.tsdb?.objectType, brickClass)) {
    point.brickNote = `demoted: non-binary objectType (${point.tsdb?.objectType}) conflicts with binary-implying class ${brickClass}`
    brickClass = 'Point'
    confidence = 'low'
  } else if (isUngroundedBinaryClaim(point.tsdb?.objectType, brickClass)) {
    point.brickNote = `low confidence: no objectType data to confirm binary-implying class ${brickClass}`
    confidence = 'low'
  } else {
    delete point.brickNote
  }

  point.brickClass = brickClass
  point.confidence = confidence
  point.tags = combined.tags.filter(t => t !== 'Point')
  point.partSources = partSourcesOf(combined)
  if (m.flags.length > 0) point.classFlags = m.flags
  else delete point.classFlags
  if (m.alternatives.length > 0) point.classificationAlternatives = m.alternatives
  else delete point.classificationAlternatives
  // A trade-off alone is a flag, not a review reason (it stays in classFlags).
  if (lowSignal || m.flags.some(f => f.kind !== 'trade-off') || confidence === 'low') point.needsReview = true
  else delete point.needsReview

  for (const f of m.flags) stats.flags[f.kind] = (stats.flags[f.kind] ?? 0) + 1
  if (confidence === 'high') stats.points.classified++
  else if (confidence === 'medium') stats.points.medium++
  else stats.points.low++
  return brickClass
}

function countReviewed(point: any): void {
  if (point.confidence === 'high') stats.points.classified++
  else if (point.confidence === 'medium') stats.points.medium++
  else stats.points.low++
}

function classifyPoints() {
  // One input per point: plant points, then zone points, then device points (the order walked below).
  const inputs = pointInputsFromMapping(profile, plantPm, zonePm, equipInv, plantClassTags)
  let next = 0
  const inputFor = (point: any) => {
    const input = inputs[next++]
    if (input?.id !== point.bmsPointId) { console.error(`Point input ${input?.id} does not pair with point ${point.bmsPointId}`); process.exit(1) }
    return input
  }

  // Plant points
  for (const plant of plantPm.plants) {
    const plantClass = plant.brickClass || 'HVAC_Equipment'
    const plantIsDistrict = Array.isArray(plant.tags) && plant.tags.includes('District')
    for (const point of plant.points) {
      const input = inputFor(point)
      stats.points.total++

      // pointHost is pure structure -- an equipment/Controller correlation, never a human
      // judgment call -- so it must always be recomputed, even for a reviewedManually point.
      // Otherwise a point reviewed before its plant's equipment-inventory data (ductPath,
      // station/controller) was complete stays permanently stuck on whatever host (or lack of
      // one) existed at review time, silently, even after the missing data later arrives.
      // brickClass/confidence (below) are the actual judgment call and stay frozen as before.
      const correlatedEqId = correlateEquipment(plant.plantId, point.pointAbbreviation, point.bmsPointId)
      const baseId = `${input.parts.token}${input.parts.number}`
      // the point's own item's ductPath (a sensor item; a flattened suffix point uses its base point's)
      const ownDuctPath = equipDuctPath.get(`${plant.plantId}:${point.pointAbbreviation}`) ?? equipDuctPath.get(`${plant.plantId}:${baseId}`)
      const rawDirection = resolveRawDirection(plant.plantId, point, correlatedEqId, ownDuctPath)
      const pointHost = resolvePointHost(plant, point, correlatedEqId, rawDirection, baseId)
      if (pointHost) point.pointHost = pointHost
      else delete point.pointHost

      const dp = equipDuctPath.get(`${plant.plantId}:${point.pointAbbreviation}`)
      const wc = getWaterContext(plant.plantId, point.pointAbbreviation, plantClass)
      const hc = (wc && WC2HC[wc]) || ''     // ductPath/serving-chain ctx, else the plant's Brick class tags
      const role = hostRole(plant, pointHost, ownDuctPath)
      const usedFallbackSignal = !correlatedEqId && !dp && !!rawDirection   // Pass 1 step 2 (description fallback) -- but not truly "fallback" when this point's own abbreviation carries real image-verified ductPath (dp), even though isEquipmentClass correctly excludes it as a hasPoint host
      // The host frame: today's routing result as tags. District (a plant tag) only alongside the
      // Entering/Leaving boundary tags Brick defines District_ variants for.
      const dirTag = waterDirectionTag(role, rawDirection, hc === 'Dhw')
      const hostFrame = dirTag ? [dirTag] : []
      if (plantIsDistrict && (dirTag === 'Leaving' || dirTag === 'Entering')) hostFrame.push('District')
      // DHW is the plant's own downstream medium -- a boundary-primary point describes the
      // upstream/district side of the interface, which hasn't reached that medium yet (e.g. a DHW
      // plant's primary_supply is still district heat arriving at the exchanger). The plant's
      // Domestic tag is not carried to that side.
      const pointInput = role === 'boundary-primary' && hc === 'Dhw' ? { ...input, plantTags: input.plantTags.filter(t => t !== 'Domestic') } : input
      if (point.reviewedManually) { tagReviewedPoint(point, pointInput, hostFrame, false); countReviewed(point); continue }
      const brickClass = classifyPointFromParts(point, pointInput, hostFrame, false, usedFallbackSignal)
      if (brickClass === 'Point') flagged.push(`Plant point ${plant.plantId}_${point.pointAbbreviation}: unclassified`)
    }
  }

  // Zone points (no plant water-context / ductPath)
  for (const zone of zonePm.zones) {
    for (const point of zone.points) {
      const input = inputFor(point)
      stats.points.total++
      if (point.reviewedManually) { tagReviewedPoint(point, input, [], true); countReviewed(point); continue }
      classifyPointFromParts(point, input, [], true, false)
    }
  }

  // Device points (controller-wide, no plant): hosted on the controller itself, no equipment
  // correlation and no water host frame.
  for (const device of plantPm.devices ?? []) {
    for (const point of device.points ?? []) {
      const input = inputFor(point)
      stats.points.total++
      point.pointHost = { hostType: 'controller', hostId: `${device.deviceInstance}|${device.deviceName}` }
      if (point.reviewedManually) { tagReviewedPoint(point, input, [], false); countReviewed(point); continue }
      const brickClass = classifyPointFromParts(point, input, [], false, false)
      if (brickClass === 'Point') flagged.push(`Device point ${device.deviceName}_${point.pointAbbreviation}: unclassified`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!only || only === 'plants') classifyPlants()
if (!only || only === 'equipment') classifyEquipment()
if (!only || only === 'spatial') { classifyFloors(); classifyRooms() }
if (!only || only === 'zones') classifyZones()
if (!only || only === 'points') classifyPoints()

// ─── Write ────────────────────────────────────────────────────────────────────

if (!dryRun) {
  writeFileSync(resolve(inputDir, 'plant-point-mapping.json'), JSON.stringify(plantPm, null, 2), 'utf-8')
  writeFileSync(resolve(inputDir, 'zone-point-mapping.json'), JSON.stringify(zonePm, null, 2), 'utf-8')
  // Only write equipment-inventory back if it actually exists — never create an empty one.
  if (existsSync(equipPath)) writeFileSync(equipPath, JSON.stringify(equipInv, null, 2), 'utf-8')
  writeFileSync(resolve(inputDir, 'spatial-hierarchy.json'), JSON.stringify(spatial, null, 2), 'utf-8')
  console.log(dryRun ? '\n[DRY RUN — no files written]' : '\nFiles written.')
}

// ─── Report ───────────────────────────────────────────────────────────────────

console.log(`\nBrick classification for ${buildingId}:`)
console.log(`  Plants:    ${stats.plants.classified} high / ${stats.plants.low} low / ${stats.plants.total} total`)
console.log(`  Equipment: ${stats.equipment.classified} high / ${stats.equipment.low} low / ${stats.equipment.total} total`)
console.log(`  Floors:    ${stats.floors.classified} high / ${stats.floors.low} low / ${stats.floors.total} total`)
console.log(`  Rooms:     ${stats.rooms.classified} high / ${stats.rooms.low} low / ${stats.rooms.total} total`)
console.log(`  Zones:     ${stats.zones.classified} high / ${stats.zones.low} low / ${stats.zones.total} total`)
console.log(`  Points:    ${stats.points.classified} high / ${stats.points.medium} medium / ${stats.points.low} low / ${stats.points.total} total`)
console.log(`  Subpoints: ${stats.subpoints.classified} high / ${stats.subpoints.low} low / ${stats.subpoints.total} total`)
const flagKinds = Object.keys(stats.flags).sort()
if (flagKinds.length > 0) {
  console.log(`  Point flags by kind:`)
  for (const k of flagKinds) console.log(`    ${k.padEnd(16)} ${stats.flags[k]}`)
}
if (stats.unknownUnits.points > 0) {
  console.log(`  Unknown units: ${stats.unknownUnits.points} point(s), ${Array.from(stats.unknownUnits.strings).sort().map(u => JSON.stringify(u)).join(', ')} (classified without a unit quantity)`)
}

const totalHigh = stats.plants.classified + stats.equipment.classified + stats.floors.classified +
  stats.rooms.classified + stats.zones.classified + stats.points.classified + stats.points.medium + stats.subpoints.classified
const totalAll = stats.plants.total + stats.equipment.total + stats.floors.total +
  stats.rooms.total + stats.zones.total + stats.points.total + stats.subpoints.total
console.log(`\n  Overall: ${totalHigh}/${totalAll} high+medium confidence (${(100*totalHigh/totalAll).toFixed(1)}%)`)

if (flagged.length > 0) {
  console.log(`\nFlagged for review (${flagged.length}):`)
  for (const f of flagged) console.log(`  - ${f}`)
}
