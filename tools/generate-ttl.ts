/**
 * generate-ttl.ts
 *
 * Generates a Brick (nightly) TTL (Turtle) file from classified building data.
 * Reads all source JSON files and produces data/{buildingId}/outputs/building.ttl
 * for import into GraphDB.
 *
 * Usage:
 *   npx ts-node tools/generate-ttl.ts <buildingId>
 *   npx ts-node tools/generate-ttl.ts <buildingId> --steps 1,2,3
 *   npx ts-node tools/generate-ttl.ts <buildingId> --entity {plantId}
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { loadProfile, inputPath, dataRoot, BuildingProfile } from './lib/building-profile'
import { unitUri, unmappedUnits } from './lib/units'
import { pointIdSeparator, composePointId, matchPointOwner, collidingEntityIds as findCollidingEntityIds } from './lib/point-id'

const args = process.argv.slice(2)
const buildingId = args[0]
if (!buildingId) { console.error('Usage: npx ts-node tools/generate-ttl.ts <buildingId>'); process.exit(1) }

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

const stepsArg = args.indexOf('--steps') !== -1 ? args[args.indexOf('--steps') + 1] : null
const entityArg = args.indexOf('--entity') !== -1 ? args[args.indexOf('--entity') + 1] : null
// Non-destructive testing: write to an alternate filename in outputs/ instead of
// building.ttl, so a structural experiment can be reviewed without touching the live file.
const outArg = args.indexOf('--out') !== -1 ? args[args.indexOf('--out') + 1] : null
const enabledSteps = stepsArg ? new Set(stepsArg.split(',').map(Number)) : new Set([1, 2, 3, 4, 5])

// ─── Load files ───────────────────────────────────────────────────────────────

const dataDir = resolve(dataRoot(), buildingId)
const inputDir = resolve(dataDir, 'inputs')

function load(path: string): any {
  if (!existsSync(path)) { console.error(`Missing: ${path}`); process.exit(1) }
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function loadOptional(path: string, fallback: any): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : fallback
}

const plantPm = load(resolve(inputDir, 'plant-point-mapping.json'))
const zonePm = load(resolve(inputDir, 'zone-point-mapping.json'))
// Controller-wide points (BACnet mapper's top-level `devices`), hosted by the device's controller node.
const devicePm: any[] = Array.isArray(plantPm.devices) ? plantPm.devices : []
function deviceHostId(dev: any, pt: any): string { return pt.pointHost?.hostId ?? `${dev.deviceInstance}|${dev.deviceName}` }
const spatial = load(resolve(inputDir, 'spatial-hierarchy.json'))
const brickIdx = load(resolve(__dirname, '..', 'ontologies', 'brick-classification-index.json'))

// Optional image-derived inputs. BACnet buildings (mapped from a BACnet scrape) may
// have no equipment inventory or topology connections; every access below is
// guarded with ?./|| [], so default to empty structures.
const equipInv = loadOptional(resolve(inputDir, 'equipment-inventory.json'), {})
const connections = loadOptional(resolve(inputDir, 'building-connections.json'), {})

// ─── BACnet devices (BACnet buildings — from the profile's inputs.devices) ───

interface BacnetDevice {
  deviceId: string
  deviceName: string
  deviceInstance: number
  ipAddress: string | null
  gateway: string | null
}

const bacnetDevices: BacnetDevice[] = []
let primaryDeviceUri: string | null = null
// deviceInstance → device URI, so each point's BACnet object links to the actual
// controller that hosts it (via tsdb.deviceInstance), not a single global gateway.
const instanceToDeviceUri = new Map<number, string>()

// Quote-aware CSV line splitter — fields may contain commas inside double quotes
// (e.g. a vendor name such as "Example Controls, Inc.").
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ } // escaped quote
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}

if (profile.dataShape === 'bacnet') {
  const devicesCsvPath = inputPath(profile, 'devices')
  if (!existsSync(devicesCsvPath)) { console.error(`Missing: ${devicesCsvPath}`); process.exit(1) }
  const raw = readFileSync(devicesCsvPath, 'utf-8')
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  // Resolve columns by header name so the parser is robust to column order.
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const iInstance = col('instance')
  const iAddress = col('address')
  const iName = col('object-name')
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line)
    const instanceStr = iInstance !== -1 ? f[iInstance] : f[0]
    const name = iName !== -1 ? f[iName] : ''
    const address = iAddress !== -1 ? f[iAddress] : null
    const instance = parseInt(instanceStr, 10)
    if (isNaN(instance)) continue
    // Use the BACnet object-name as the stable device id/URI; fall back to instance.
    const deviceId = name || String(instance)
    bacnetDevices.push({
      deviceId,
      deviceName: name || String(instance),
      deviceInstance: instance,
      ipAddress: address || null,
      gateway: null,
    })
    instanceToDeviceUri.set(instance, deviceUri(deviceId))
  }
  if (bacnetDevices.length === 0) {
    console.error(`${buildingId}: dataShape is bacnet but no devices were parsed from ${devicesCsvPath}`)
    process.exit(1)
  }
  primaryDeviceUri = deviceUri(bacnetDevices[0].deviceId)
}

const useBacnetRefs = profile.dataShape === 'bacnet'

// ─── URI helpers ──────────────────────────────────────────────────────────────

function sanitizeUri(id: string): string {
  return id.replace(/\./g, '_').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_æøåÆØÅ]/g, '_')
}
function roomUri(roomId: string): string { return `bldg:room_${sanitizeUri(roomId)}` }
function floorUri(floorId: string): string { return `bldg:${sanitizeUri(floorId)}` }
function plantUri(plantId: string): string { return `bldg:${sanitizeUri(plantId)}` }
function zoneUri(zoneId: string): string { return `bldg:${sanitizeUri(zoneId)}` }
// project URI convention: fixed "_" (not the building's naming)
function equipUri(parentId: string, equipId: string): string { return `bldg:${sanitizeUri(parentId)}_${sanitizeUri(equipId)}` }
function pointUri(bmsPointId: string): string { return `bldg:${sanitizeUri(bmsPointId)}` }
// Devices get a `dev_` prefix: keeps the full BACnet object-name but avoids
// collisions with plant/zone URIs (e.g. a device and a plant that share a name).
function deviceUri(deviceId: string): string { return `bldg:dev_${sanitizeUri(deviceId)}` }

// spatial-hierarchy.json is zone-centred: spatial.zones[] = { id, status, roomIds, floorId, name? }.
// zoneId -> zone record, and zoneId -> the distinct room ids it covers (unlinked zones have none).
const spatialZoneById = new Map<string, any>((Array.isArray(spatial.zones) ? spatial.zones : []).map((z: any) => [z.id, z]))
function zoneRoomIds(zid: string): string[] {
  const ids = spatialZoneById.get(zid)?.roomIds
  return Array.isArray(ids) ? [...new Set<string>(ids)] : []
}
// Zone ids that have this room among their rooms (subgraph selection).
function roomHasZone(roomId: string, zoneIdSet: Set<string>): boolean {
  for (const zid of zoneIdSet) if (zoneRoomIds(zid).includes(roomId)) return true
  return false
}

// floorId -> label -- reused to bucket Zones by floor the same
// way Rooms are already bucketed (see the "Rooms on {floor}" sub-banners), and to order
// those buckets by the floor's own rec:levelNumber, not alphabetically.
const floorLabelById = new Map<string, string>((spatial.floors || []).map((f: any) => [f.id, f.name || f.id]))
const floorLevelById = new Map<string, number>((spatial.floors || []).map((f: any) => [f.id, f.levelNumber ?? 0]))
const floorLevelByLabel = new Map<string, number>(
  (spatial.floors || []).map((f: any) => [f.name || f.id, f.levelNumber ?? 0])
)
// Zone sub-banner order: real floors low-to-high, 'Unassigned' (no room resolved) last.
const ZONE_FLOOR_GROUP_ORDER = [...(spatial.floors || [])]
  .sort((a: any, b: any) => (a.levelNumber ?? 0) - (b.levelNumber ?? 0))
  .map((f: any) => f.name || f.id)
  .concat(['Unassigned'])

// Plants grouped into human-scannable buckets, mirroring a BMS's own plant-overview tab
// layout (ventilation/heating/cooling/water/miscellaneous/fire dampers) plus a Meters bucket
// for the standalone sub-meters this project's own sessions added. Structural brickClass signals
// (Fire_Safety_Equipment, Lighting_Equipment, *Meter*) are checked first since they're
// unambiguous; the plant's own captured systemType (equipment-inventory.json) is a better
// signal than brickClass alone for the rest (e.g. a cooling plant classed Exhaust_Fan --
// a pre-existing classification quirk, not something this reorder is fixing -- but its
// captured systemType: 'cooling' still places it correctly in the Cooling bucket).
const PLANT_CATEGORY_ORDER = ['Ventilation', 'Heating', 'Cooling', 'Water', 'Meters', 'Lighting & Controls', 'Fire Safety', 'Weather', 'Other']
function plantCategory(plant: any): string {
  const cls = plant.brickClass || ''
  if (cls === 'Fire_Safety_Equipment') return 'Fire Safety'
  if (cls === 'Lighting_Equipment') return 'Lighting & Controls'
  if (/Meter$/.test(cls)) return 'Meters'
  if (cls === 'Weather_Station') return 'Weather'
  const sys = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)?.systemType
  if (sys === 'cooling' || sys === 'chiller') return 'Cooling'
  if (sys === 'heating' || sys === 'dhw') return 'Heating'
  if (sys === 'ventilation') return 'Ventilation'
  if (sys === 'domesticWater') return 'Water'
  if (cls === 'Air_Handling_Unit' || cls === 'Exhaust_Fan') return 'Ventilation'
  if (cls === 'Hot_Water_System' || cls === 'Domestic_Hot_Water_System' || cls === 'Hot_Water_Valve') return 'Heating'
  if (cls === 'Chiller' || cls === 'Chilled_Water_System') return 'Cooling'
  // BACnet-route-specific (found auditing a BACnet building's own class list before first
  // applying this reorder there, 2026-08-27): Rule 0's vendor-valve family plants have no
  // systemType captured on the BACnet route (equipment-inventory.json is optional there) and
  // Chilled_Water_System previously only reached 'Cooling' via a captured systemType, not this
  // brickClass fallback -- both fixed above. Bare 'Valve' (BACnet route only; the timeseries
  // route's own valve-typed EQUIPMENT items are a different, unrelated code path) is specifically
  // the ventilation-context vendor valve per Rule 0's own
  // `st === 'ventilation' ? 'Valve' : 'Hot_Water_Valve'` split -- not ambiguous,
  // route it to Ventilation rather than Other.
  if (cls === 'Valve') return 'Ventilation'
  return 'Other'
}

// Dotted-decimal IPv4 → uppercase hex string (BACnet xsd:hexBinary form), e.g.
// "192.168.1.10" → "C0A8010A". Returns null if the address isn't dotted IPv4.
function ipv4ToHex(ip: string): string | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map(p => parseInt(p, 10))
  if (bytes.some(b => isNaN(b) || b < 0 || b > 255)) return null
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

// ─── Class resolution ─────────────────────────────────────────────────────────

function resolveClass(brickClass: string): string {
  if (!brickClass) return 'brick:Point'
  if (brickClass.startsWith('rec:')) return brickClass
  if (brickClass.startsWith('brick:')) return brickClass
  if (brickIdx.classes['brick:' + brickClass]) return 'brick:' + brickClass
  if (brickIdx.classes['rec:' + brickClass]) return 'rec:' + brickClass
  if (brickIdx.classes[brickClass]) return brickClass
  return 'brick:' + brickClass
}

function isEquipmentClass(brickClass: string): boolean {
  if (!brickClass) return false
  const key = brickClass.startsWith('brick:') || brickClass.startsWith('rec:')
    ? brickClass
    : 'brick:' + brickClass
  const entry = brickIdx.classes[key]
  return entry?.category === 'Equipment'
}

function isSystemClass(brickClass: string): boolean {
  if (!brickClass) return false
  const key = brickClass.startsWith('brick:') || brickClass.startsWith('rec:') ? brickClass : 'brick:' + brickClass
  return (brickIdx.classes[key] as any)?.category === 'System'
}

// Controller hostId is "<deviceInstance>|<deviceName>" (from classify-all.ts's
// pointHost). One Controller node per unique pair, shared across every plant
// that references it — never one per plant.
function controllerUri(hostId: string): string {
  const [, deviceName] = hostId.split('|')
  return `bldg:ctrl_${sanitizeUri(deviceName)}`
}

// Human-readable plant title, e.g. "Main Heat Exchanger" (from equipment-inventory.json's
// plantName: "<systemType> / <title>" -- only the title half; the systemType half is
// often "-" (uncaptured) or duplicates the plant id/title. Bare plant id stays the rdfs:label's anchor (uniqueness,
// existing convention) -- this appends the title in parens, never replaces it.
function plantTitle(plantId: string): string | null {
  const raw = equipInv.plantEquipment?.find((p: any) => p.plantId === plantId)?.plantName
  if (!raw) return null
  const slash = raw.indexOf('/')
  const title = (slash >= 0 ? raw.slice(slash + 1) : raw).trim()
  return title || null
}

// ─── Equipment/Point collision detection (Option E1) ─────────────────────────
//
// When an equipment-inventory entry has the same id as a point in
// plant-point-mapping (e.g. fire dampers, fans, valves), Brick says they can't
// be the same URI: Point and Equipment are disjoint. We resolve by letting the
// Point win — the entity stays a Point, attached to the parent plant via
// brick:hasPoint, and the equipment-inventory entry is dropped (not emitted as
// a separate Equipment URI, no brick:hasPart triple).
//
// The equipment's classification info (Damper, Fan, etc.) is informational here
// and would inform Point class refinement (e.g. Damper_Position_Status) in
// classify-all.ts — out of scope for this generator.

// Members are composed with the building's point-id separator (compared with bmsPointIds).
const collidingEntityIds = new Set<string>()
{
  const plantPointIds = new Set<string>()
  for (const plant of plantPm.plants) {
    for (const pt of plant.points) plantPointIds.add(pt.bmsPointId)
  }
  const zonePointIds = new Set<string>()
  for (const zone of zonePm.zones) {
    for (const pt of zone.points) zonePointIds.add(pt.bmsPointId)
  }
  const plantOwners = (equipInv.plantEquipment || []).map((pe: any) => ({ parentId: pe.plantId, equipment: pe.equipment || [] }))
  const zoneOwners = (equipInv.zoneEquipment || []).map((ze: any) => ({ parentId: ze.zoneId, equipment: ze.equipment || [] }))
  for (const id of findCollidingEntityIds(plantOwners, plantPointIds, pointIdSep)) collidingEntityIds.add(id)
  for (const id of findCollidingEntityIds(zoneOwners, zonePointIds, pointIdSep)) collidingEntityIds.add(id)
}

function isCollidingEquipment(parentId: string, equipId: string): boolean {
  return collidingEntityIds.has(composePointId(pointIdSep, parentId, equipId))
}

// ─── Points-on-equipment routing ──────────────────────────────────────────────
//
// Canonically, brick:hasPoint runs Equipment/Location → Point. Without this
// routing every point would attach to its parent plant/zone, so a device's own
// telemetry (e.g. the SPI1 damper's SPI1_POS / SPI1_FLOW) would hang off the zone
// rather than off the SPI1 damper node that equipment-inventory already supplies
// and links via brick:hasPart. For every building we instead route a device's
// telemetry onto the device node (device brick:hasPoint point), matching the
// canonical chain  zone hasPart device ; device hasPoint point.
//
// Two cases of device ownership:
//  - NON-colliding equipment (e.g. a zone damper "SPI1" with no bare "SPI1" point):
//    the equipment-inventory node already exists at its natural URI; its telemetry
//    (SPI1_POS, SPI1_FLOW, …) routes onto it.
//  - COLLIDING equipment ("revive"): the device id equals a bare point id (e.g.
//    "VA07_P1" is both a Hot_Water_Pump and a Pump_On_Off_Status point).
//    A node can't be both Equipment and Point, so we MINT a separate device URI
//    (`${id}_eq`, Strategy 1 — the bare point keeps its natural URI + TSDB ref),
//    emit `parent hasPart {id}_eq`, and route the bare point + its subpoints onto
//    it. Revive requires a SPECIFIC equipment class (not the generic
//    `HVAC_Equipment` fallback) AND a bare point that is a *Point* class (if the
//    bare point is already equipment-classed it serves as the device — Point wins).

interface Owner { eqId: string; uri: string; revived: boolean }
interface RevivedDevice { parentId: string; isPlant: boolean; parentUri: string; barePointId: string; uri: string; brickClass: string; label: string; order: number }
const deviceOwners = new Map<string, Owner[]>() // parentId → owners, longest eqId first
const revivedDevices: RevivedDevice[] = []

{ // block scope only (formerly a per-building gate) -- always runs
  // Top-level point class lookup (revive needs the bare point's class).
  const topPointClass = new Map<string, string>()
  for (const plant of plantPm.plants) for (const pt of plant.points) topPointClass.set(pt.bmsPointId, pt.brickClass || '')
  for (const zone of zonePm.zones) for (const pt of zone.points) topPointClass.set(pt.bmsPointId, pt.brickClass || '')

  // Every URI that will already exist — guards minted device URIs against clashes.
  const existingUris = new Set<string>()
  const addPts = (ps: any[]) => { for (const pt of ps) existingUris.add(pointUri(pt.bmsPointId)) }
  for (const plant of plantPm.plants) addPts(plant.points)
  for (const zone of zonePm.zones) addPts(zone.points)
  for (const dev of devicePm) addPts(dev.points || [])
  for (const pe of equipInv.plantEquipment || []) for (const eq of pe.equipment || []) existingUris.add(equipUri(pe.plantId, eq.id))
  for (const ze of equipInv.zoneEquipment || []) for (const eq of ze.equipment || []) existingUris.add(equipUri(ze.zoneId, eq.id))
  const mintedTaken = new Set<string>()
  const mintDeviceUri = (parentId: string, eqId: string): string => {
    // project URI convention: fixed "_" (not the building's naming)
    const base = `${equipUri(parentId, eqId)}_eq`
    let uri = base, n = 2
    while (existingUris.has(uri) || mintedTaken.has(uri)) uri = `${base}${n++}`
    mintedTaken.add(uri)
    return uri
  }

  const addOwners = (list: any[] | undefined, parentKey: string) => {
    const isPlant = parentKey === 'plantId'
    for (const pe of list || []) {
      const parentId = pe[parentKey]
      const parentUriStr = isPlant ? plantUri(parentId) : zoneUri(parentId)
      const arr: Owner[] = []
      ;(pe.equipment || []).forEach((eq: any, i: number) => {
        const cls = eq.brickClass || 'HVAC_Equipment'
        if (!isEquipmentClass(cls)) return // sensors etc. are points, never a device here
        if (!isCollidingEquipment(parentId, eq.id)) {
          arr.push({ eqId: eq.id, uri: equipUri(parentId, eq.id), revived: false }) // existing inventory node
          return
        }
        // Colliding → revive only if a specific class AND the bare point is a Point.
        if (cls === 'HVAC_Equipment') return // generic fallback — not a real device, keep Point-wins
        const bareId = composePointId(pointIdSep, parentId, eq.id) // looked up in topPointClass (keyed by bmsPointId)
        const bareCls = topPointClass.get(bareId)
        if (bareCls === undefined) return
        if (isEquipmentClass(bareCls)) {
          // The bare point is already classed as the equipment itself (e.g. a heat
          // wheel's own AnalogInput matched straight to Heat_Wheel, not demoted to a
          // generic Point) — no second URI needed, the point IS the device. But it
          // still needs an owner entry at its own (unminted) URI so siblings/subpoints
          // (fault status, etc.) resolve onto it instead of falling through to the
          // parent plant/zone.
          arr.push({ eqId: eq.id, uri: equipUri(parentId, eq.id), revived: false })
          return
        }
        const uri = mintDeviceUri(parentId, eq.id)
        arr.push({ eqId: eq.id, uri, revived: true })
        revivedDevices.push({
          parentId, isPlant, parentUri: parentUriStr, barePointId: bareId, uri, brickClass: cls,
          label: eq.description?.trim() || `${eq.type || 'Equipment'} ${eq.id}`,
          order: i,
        })
      })
      if (arr.length) { arr.sort((a, b) => b.eqId.length - a.eqId.length); deviceOwners.set(parentId, arr) }
    }
  }
  addOwners(equipInv.plantEquipment, 'plantId')
  addOwners(equipInv.zoneEquipment, 'zoneId')
}

// Image-only sensors: equipment-inventory entries marked `imageOnly: true` (human-confirmed:
// seen in a BMS image, but with no BMS point or TSDB object of their own) that Brick classes
// as a Point (sensor, alarm, status...). Without this they'd vanish from the graph
// (Point-classed entries are never emitted as equipment). Emitted as plain Points on their
// zone/plant with no timeseries reference. Explicit flag, not inferred: an image entry's id
// often differs from its real point's id (e.g. image "CO2" vs point "Z_201_CO2_1"), so
// "no matching point id" can't tell an image-only sensor from a duplicate. A *_System parent
// can't host a Point, so those are skipped with a warning, not silently.
interface ImageOnlySensor { parentId: string; isPlant: boolean; eqId: string; uri: string; brickClass: string; label: string; order: number }
const imageOnlySensors: ImageOnlySensor[] = []
{
  const knownParents = new Set<string>([
    ...plantPm.plants.map((p: any) => p.plantId),
    ...zonePm.zones.map((z: any) => z.zoneId),
  ])
  const skippedOnSystem: string[] = []
  const collect = (list: any[] | undefined, parentKey: string) => {
    const isPlant = parentKey === 'plantId'
    for (const pe of list || []) {
      const parentId = pe[parentKey]
      if (!knownParents.has(parentId)) continue // parent not in the point mapping -> not emitted at all
      ;(pe.equipment || []).forEach((eq: any, i: number) => {
        if (eq.imageOnly !== true) return
        const cls = eq.brickClass
        if (!cls || isEquipmentClass(cls)) return
        if (isCollidingEquipment(parentId, eq.id)) return
        if (isPlant && isSystemClass(plantPm.plants.find((p: any) => p.plantId === parentId)?.brickClass)) {
          skippedOnSystem.push(`${parentId}/${eq.id}`)
          return
        }
        imageOnlySensors.push({
          parentId, isPlant, eqId: eq.id, uri: equipUri(parentId, eq.id), brickClass: cls,
          label: eq.description?.trim() || `${eq.type || 'Sensor'} ${eq.id}`, order: i,
        })
      })
    }
  }
  collect(equipInv.plantEquipment, 'plantId')
  collect(equipInv.zoneEquipment, 'zoneId')
  if (skippedOnSystem.length) {
    console.warn(`WARN: ${skippedOnSystem.length} image-only sensor(s) on *_System plants not emitted (a System can't host a Point): ${skippedOnSystem.join(', ')}`)
  }
}

// The owning-device URI for a point, else null to keep it on its parent plant/zone.
// For a revived device the bare point (suffix === eqId) resolves to the minted URI
// (≠ the point URI, so `device hasPoint point` is non-degenerate); siblings/subpoints
// match via the `${eqId}_` prefix. Non-colliding owners use their natural URI. An
// "already-equipment-classed bare point" owner (see addOwners above) uses the SAME
// URI as its own bare point — that owner entry exists only so its siblings resolve
// onto it; the bare point itself must not become its own owner (`X hasPart/hasPoint X`),
// so that exact self-match is skipped here.
function pointOwnerUri(parentId: string, bmsPointId: string): string | null {
  const arr = deviceOwners.get(parentId)
  if (!arr) return null
  // Decomposes a bmsPointId by the building's separator (lib/point-id.ts matchPointOwner):
  // separator-delimited sibling/subpoint ("SPI1_POS_SP"), or the permissive bare-lowercase-suffix
  // form correlateEquipment() uses plant-side ("V1c").
  const o = matchPointOwner(bmsPointId, parentId, arr, pointIdSep,
    (own) => own.uri === pointUri(bmsPointId)) // self-match — the bare point can't own itself
  return o ? o.uri : null
}

// ─── Block-based collector ───────────────────────────────────────────────────

type SectionId = 'building' | 'floors' | 'rooms' | 'bacnet' | 'plants' | 'zones'
type GroupId = 'header' | 'equipment' | 'points'

interface BlockMeta {
  section: SectionId
  primaryOrder: number
  secondaryOrder: number
  parentSubject?: string
  group?: GroupId
  // For floor-grouped rooms: track which floor each room belongs to
  floorKey?: string
  // For plants (grouped by system category) and zones (grouped by floor): the
  // sub-banner bucket this header belongs to. See emitNestedSection's groupBy option.
  groupKey?: string
}

interface Block {
  subject: string
  meta: BlockMeta
  // Insertion-ordered map of predicate -> objects
  preds: Map<string, string[]>
  externalRef?: { type: string; props: Array<[string, string]> }
  bacnetPortFields?: Array<[string, string]>
  // Section-banner override (only set on the first block of a banner group)
  sectionBanner?: string
  subBanner?: string
}

const blocks = new Map<string, Block>()
const stats = { entities: 0, spatial: 0, hierarchy: 0, connections: 0, tsdb: 0, units: 0 }

function block(subject: string): Block {
  let b = blocks.get(subject)
  if (!b) {
    b = { subject, meta: { section: 'building', primaryOrder: 0, secondaryOrder: 0 }, preds: new Map() }
    blocks.set(subject, b)
  }
  return b
}

// Tracks whether a block's meta has been intentionally set (vs default-init)
const registered = new Set<string>()

function register(subject: string, meta: BlockMeta): Block {
  const b = block(subject)
  // First call wins (mirrors emit() first-type-wins for `a`).
  // This ensures an entity emitted as a Point in the points-pass stays in the
  // 'points' group even if it also appears in equipment-inventory.
  if (registered.has(subject)) return b
  registered.add(subject)
  b.meta = meta
  return b
}

function pushPred(b: Block, p: string, o: string): void {
  if (!b.preds.has(p)) b.preds.set(p, [])
  b.preds.get(p)!.push(o)
}

function emit(s: string, p: string, o: string): void {
  const b = block(s)
  if (p === 'a') {
    if (b.preds.has('a')) return // first type wins
  }
  pushPred(b, p, o)
}

function emitLabel(s: string, label: string): void {
  const b = block(s)
  if (b.preds.has('rdfs:label')) return // one label per subject
  const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  pushPred(b, 'rdfs:label', `"${escaped}"`)
}

function emitLiteral(s: string, p: string, literal: string): void {
  pushPred(block(s), p, literal)
}

function emitBacnetRef(subjectUri: string, tsdb: { id: string; objectType: string; objectInstance: number; deviceInstance?: number }): void {
  const objType = tsdb.objectType.replace(/([A-Z])/g, (m, c, i) => i ? `-${c}` : c).toLowerCase()
  const props: Array<[string, string]> = []
  // Link to the controller that actually hosts this object; fall back to the
  // primary device only if the point's deviceInstance is unknown.
  const hostUri = (tsdb.deviceInstance != null && instanceToDeviceUri.get(tsdb.deviceInstance)) || primaryDeviceUri
  if (hostUri) props.push(['bacnet:objectOf', hostUri])
  props.push(['bacnet:object-name', `"${tsdb.id}"`])
  props.push(['bacnet:object-identifier', `"${objType},${tsdb.objectInstance}"`])
  props.push(['bacnet:object-type', `"${objType}"`])
  block(subjectUri).externalRef = { type: 'ref:BACnetReference', props }
}

function emitTimeseriesRef(subjectUri: string, tsdbId: string): void {
  block(subjectUri).externalRef = {
    type: 'ref:TimeseriesReference',
    props: [['ref:hasTimeseriesId', `"${tsdbId}"`]],
  }
}

function emitExternalRefs(subjectUri: string, tsdb: { id: string; objectType: string; objectInstance: number; deviceInstance?: number }): void {
  if (useBacnetRefs) emitBacnetRef(subjectUri, tsdb)
  else emitTimeseriesRef(subjectUri, tsdb.id)
}

// ─── Subgraph filtering ──────────────────────────────────────────────────────

let subgraphEntities: Set<string> | null = null

if (entityArg) {
  // Equipment keys below (`${parent}_${eq.id}`) are only compared with other keys built the same way
  // (inSubgraph at the equipment emit sites): project URI convention: fixed "_" (not the building's naming)
  subgraphEntities = new Set<string>()
  const plant = plantPm.plants.find((p: any) => p.plantId === entityArg)
  const zone = zonePm.zones.find((z: any) => z.zoneId === entityArg)

  if (plant) {
    subgraphEntities.add(entityArg)
    const pe = equipInv.plantEquipment?.find((e: any) => e.plantId === entityArg)
    pe?.equipment?.forEach((eq: any) => subgraphEntities!.add(`${entityArg}_${eq.id}`))
    plant.points.forEach((pt: any) => {
      subgraphEntities!.add(pt.bmsPointId)    })
    const feedsEntry = connections.plantFeedsZone?.find((f: any) => f.plantId === entityArg)
    feedsEntry?.zoneIds?.forEach((zId: string) => {
      subgraphEntities!.add(zId)
      const z = zonePm.zones.find((zz: any) => zz.zoneId === zId)
      z?.points?.forEach((pt: any) => {
        subgraphEntities!.add(pt.bmsPointId)      })
      const ze = equipInv.zoneEquipment?.find((e: any) => e.zoneId === zId)
      ze?.equipment?.forEach((eq: any) => subgraphEntities!.add(`${zId}_${eq.id}`))
    })
    const feedZoneSet = new Set(feedsEntry?.zoneIds || [])
    spatial.rooms?.forEach((r: any) => {
      if (roomHasZone(r.id, feedZoneSet as Set<string>)) {
        subgraphEntities!.add(`room_${r.id}`)
        subgraphEntities!.add(r.floorId)
      }
    })
    connections.plantServesPlant?.forEach((s: any) => {
      if (s.servesPlantIds?.includes(entityArg)) {
        subgraphEntities!.add(s.plantId)
        const servPe = equipInv.plantEquipment?.find((e: any) => e.plantId === s.plantId)
        servPe?.equipment?.forEach((eq: any) => subgraphEntities!.add(`${s.plantId}_${eq.id}`))
        const servPlant = plantPm.plants.find((p: any) => p.plantId === s.plantId)
        servPlant?.points?.forEach((pt: any) => {
          subgraphEntities!.add(pt.bmsPointId)        })
      }
    })
    connections.plantHierarchy?.forEach((h: any) => {
      if (h.parentPlantId === entityArg) {
        subgraphEntities!.add(h.plantId)
        const childPe = equipInv.plantEquipment?.find((e: any) => e.plantId === h.plantId)
        childPe?.equipment?.forEach((eq: any) => subgraphEntities!.add(`${h.plantId}_${eq.id}`))
        const childPlant = plantPm.plants.find((p: any) => p.plantId === h.plantId)
        childPlant?.points?.forEach((pt: any) => {
          subgraphEntities!.add(pt.bmsPointId)        })
      }
    })
    subgraphEntities.add('Building')
  } else if (zone) {
    subgraphEntities.add(entityArg)
    zone.points.forEach((pt: any) => {
      subgraphEntities!.add(pt.bmsPointId)    })
    const ze = equipInv.zoneEquipment?.find((e: any) => e.zoneId === entityArg)
    ze?.equipment?.forEach((eq: any) => subgraphEntities!.add(`${entityArg}_${eq.id}`))
    spatial.rooms?.forEach((r: any) => {
      if (zoneRoomIds(entityArg).includes(r.id)) {
        subgraphEntities!.add(`room_${r.id}`)
        subgraphEntities!.add(r.floorId)
      }
    })
    connections.plantFeedsZone?.forEach((f: any) => {
      if (f.zoneIds?.includes(entityArg)) subgraphEntities!.add(f.plantId)
    })
    subgraphEntities.add('Building')
  } else {
    console.error(`Entity not found: ${entityArg}`)
    process.exit(1)
  }
}

function inSubgraph(id: string): boolean {
  if (!subgraphEntities) return true
  return subgraphEntities.has(id)
}

// Natural-sort key for room IDs like "1.01", "1.02"
function naturalKey(s: string): string {
  return s.replace(/\d+/g, n => n.padStart(8, '0'))
}

// ─── Step 1: Entity declarations ─────────────────────────────────────────────

if (enabledSteps.has(1)) {
  // Building
  emit('bldg:Building', 'a', 'rec:Building')
  emitLabel('bldg:Building', spatial.building?.name || buildingId)
  register('bldg:Building', { section: 'building', primaryOrder: 0, secondaryOrder: 0 })
  stats.entities++

  // Floors
  for (const floor of spatial.floors || []) {
    if (!inSubgraph(floor.id)) continue
    const uri = floorUri(floor.id)
    emit(uri, 'a', resolveClass(floor.brickClass || 'rec:Level'))
    if (floor.name) emitLabel(uri, floor.name)
    if (floor.levelNumber != null) emitLiteral(uri, 'rec:levelNumber', String(floor.levelNumber))
    register(uri, {
      section: 'floors',
      primaryOrder: floor.levelNumber ?? 0,
      secondaryOrder: 0,
    })
    stats.entities++
  }

  // Rooms (deduplicate)
  const emittedRooms = new Set<string>()
  const floorOrder = new Map<string, number>(
    (spatial.floors || []).map((f: any) => [f.id, f.levelNumber ?? 0])
  )
  for (const room of spatial.rooms || []) {
    if (!inSubgraph(`room_${room.id}`)) continue
    const uri = roomUri(room.id)
    if (emittedRooms.has(uri)) continue
    emittedRooms.add(uri)
    emit(uri, 'a', resolveClass(room.brickClass || 'rec:Room'))
    const label = room.name ? `${room.name} ${room.id}` : room.id
    emitLabel(uri, label)
    register(uri, {
      section: 'rooms',
      primaryOrder: floorOrder.get(room.floorId) ?? 999,
      secondaryOrder: 0,
      floorKey: room.floorId,
    })
    // Embed natural-sort id into preds-insertion via separate sort key below
    block(uri).meta = {
      ...block(uri).meta,
      primaryOrder: floorOrder.get(room.floorId) ?? 999,
    }
    ;(block(uri).meta as any).naturalSortKey = naturalKey(room.id)
    stats.entities++
  }

  // Plants
  plantPm.plants.forEach((plant: any, idx: number) => {
    if (!inSubgraph(plant.plantId)) return
    const uri = plantUri(plant.plantId)
    emit(uri, 'a', resolveClass(plant.brickClass || 'HVAC_Equipment'))
    const title = plantTitle(plant.plantId)
    emitLabel(uri, title ? `${plant.plantId} (${title})` : plant.plantId)
    register(uri, { section: 'plants', primaryOrder: idx, secondaryOrder: 0, group: 'header', groupKey: plantCategory(plant) })
    stats.entities++
  })

  // Zones
  zonePm.zones.forEach((zone: any, idx: number) => {
    if (!inSubgraph(zone.zoneId)) return
    const uri = zoneUri(zone.zoneId)
    emit(uri, 'a', resolveClass(zone.brickClass || 'rec:HVACZone'))
    const sz = spatialZoneById.get(zone.zoneId)
    emitLabel(uri, sz?.name ? `${zone.zoneId} ${sz.name}` : zone.zoneId)
    const floorLabel = sz?.floorId ? (floorLabelById.get(sz.floorId) || 'Unassigned') : 'Unassigned'
    register(uri, { section: 'zones', primaryOrder: idx, secondaryOrder: 0, group: 'header', groupKey: floorLabel })
    stats.entities++
  })

  function pointLabel(pt: any): string {
    const danish = pt.danishDescription?.trim()
    const english = pt.semanticMeaning?.trim() || pt.suffixMeaning?.trim()
    if (danish && english) return `${danish} (${english})`
    return danish || english || ''
  }

  // Every point tag through brick:hasTag (one object list, sorted), so tags no class holds are kept.
  function emitTags(uri: string, tags: unknown): void {
    if (!Array.isArray(tags) || tags.length === 0 || block(uri).preds.has('brick:hasTag')) return
    pushPred(block(uri), 'brick:hasTag', [...new Set<string>(tags)].sort().map(t => `tag:${t}`).join(', '))
  }

  // Plant points
  plantPm.plants.forEach((plant: any, pIdx: number) => {
    if (!inSubgraph(plant.plantId)) return
    const parentUri = plantUri(plant.plantId)
    plant.points.forEach((pt: any, ptIdx: number) => {
      if (!inSubgraph(pt.bmsPointId)) return
      const uri = pointUri(pt.bmsPointId)
      emit(uri, 'a', resolveClass(pt.brickClass || 'Point'))
      const lbl = pointLabel(pt)
      if (lbl) emitLabel(uri, lbl)
      emitTags(uri, pt.tags)
      register(uri, {
        section: 'plants',
        primaryOrder: pIdx,
        secondaryOrder: ptIdx * 1000,
        parentSubject: parentUri,
        group: 'points',
      })
      stats.entities++
    })
  })

  // Zone points
  zonePm.zones.forEach((zone: any, zIdx: number) => {
    if (!inSubgraph(zone.zoneId)) return
    const parentUri = zoneUri(zone.zoneId)
    zone.points.forEach((pt: any, ptIdx: number) => {
      if (!inSubgraph(pt.bmsPointId)) return
      const uri = pointUri(pt.bmsPointId)
      emit(uri, 'a', resolveClass(pt.brickClass || 'Point'))
      const lbl = pointLabel(pt)
      if (lbl) emitLabel(uri, lbl)
      emitTags(uri, pt.tags)
      register(uri, {
        section: 'zones',
        primaryOrder: zIdx,
        secondaryOrder: ptIdx * 1000,
        parentSubject: parentUri,
        group: 'points',
      })
      stats.entities++
    })
  })

  // Device points (controller-wide; no plant or zone): listed in the controllers section.
  devicePm.forEach((dev: any, dIdx: number) => {
    ;(dev.points || []).forEach((pt: any, ptIdx: number) => {
      if (!inSubgraph(pt.bmsPointId)) return
      const uri = pointUri(pt.bmsPointId)
      emit(uri, 'a', resolveClass(pt.brickClass || 'Point'))
      const lbl = pointLabel(pt)
      if (lbl) emitLabel(uri, lbl)
      emitTags(uri, pt.tags)
      register(uri, { section: 'bacnet', primaryOrder: 1000000 + dIdx, secondaryOrder: ptIdx })
      stats.entities++
    })
  })

  // Plant equipment (with labels). Skip collisions — those entities are Points,
  // not Equipment, and attach to the plant via brick:hasPoint instead.
  const plantOrder = new Map<string, number>(
    plantPm.plants.map((p: any, i: number) => [p.plantId, i])
  )
  for (const pe of equipInv.plantEquipment || []) {
    const pIdx = plantOrder.get(pe.plantId)
    if (pIdx === undefined) continue
    const parentUri = plantUri(pe.plantId)
    ;(pe.equipment || []).forEach((eq: any, eqIdx: number) => {
      if (!isEquipmentClass(eq.brickClass || 'HVAC_Equipment')) return
      if (isCollidingEquipment(pe.plantId, eq.id)) return
      const id = `${pe.plantId}_${eq.id}` // project URI convention: fixed "_" (not the building's naming); subgraph key
      if (!inSubgraph(id)) return
      const uri = equipUri(pe.plantId, eq.id)
      emit(uri, 'a', resolveClass(eq.brickClass || 'HVAC_Equipment'))
      const eqLabel = eq.description?.trim() || `${eq.type || 'Equipment'} ${eq.id}`
      emitLabel(uri, eqLabel)
      register(uri, {
        section: 'plants',
        primaryOrder: pIdx,
        secondaryOrder: -1000 + eqIdx, // equipment sorts before points within a plant
        parentSubject: parentUri,
        group: 'equipment',
      })
      stats.entities++
    })
  }

  // Zone equipment (with labels). Same collision skip as for plant equipment.
  const zoneOrder = new Map<string, number>(
    zonePm.zones.map((z: any, i: number) => [z.zoneId, i])
  )
  for (const ze of equipInv.zoneEquipment || []) {
    const zIdx = zoneOrder.get(ze.zoneId)
    if (zIdx === undefined) continue
    const parentUri = zoneUri(ze.zoneId)
    ;(ze.equipment || []).forEach((eq: any, eqIdx: number) => {
      if (!isEquipmentClass(eq.brickClass || 'HVAC_Equipment')) return
      if (isCollidingEquipment(ze.zoneId, eq.id)) return
      const id = `${ze.zoneId}_${eq.id}` // project URI convention: fixed "_" (not the building's naming); subgraph key
      if (!inSubgraph(id)) return
      const uri = equipUri(ze.zoneId, eq.id)
      emit(uri, 'a', resolveClass(eq.brickClass || 'HVAC_Equipment'))
      const eqLabel = eq.description?.trim() || `${eq.type || 'Equipment'} ${eq.id}`
      emitLabel(uri, eqLabel)
      register(uri, {
        section: 'zones',
        primaryOrder: zIdx,
        secondaryOrder: -1000 + eqIdx,
        parentSubject: parentUri,
        group: 'equipment',
      })
      stats.entities++
    })
  }

  // Image-only sensors (see imageOnlySensors above): declared as Points.
  for (const s of imageOnlySensors) {
    if (!inSubgraph(`${s.parentId}_${s.eqId}`)) continue // project URI convention: fixed "_" (not the building's naming); subgraph key
    emit(s.uri, 'a', resolveClass(s.brickClass))
    emitLabel(s.uri, s.label)
    register(s.uri, {
      section: s.isPlant ? 'plants' : 'zones',
      primaryOrder: (s.isPlant ? plantOrder.get(s.parentId) : zoneOrder.get(s.parentId)) ?? 0,
      secondaryOrder: 900000 + s.order, // after the parent's BMS points
      parentSubject: s.isPlant ? plantUri(s.parentId) : zoneUri(s.parentId),
      group: 'points',
    })
    stats.entities++
  }

  // Revived colliding devices (points-on-equipment): minted Equipment nodes whose
  // id collided with a bare point. The bare point + its telemetry route onto this
  // node via brick:hasPoint (Step 3); here we emit the device type/label.
  for (const d of revivedDevices) {
    if (!inSubgraph(d.barePointId)) continue
    emit(d.uri, 'a', resolveClass(d.brickClass))
    emitLabel(d.uri, d.label)
    register(d.uri, {
      section: d.isPlant ? 'plants' : 'zones',
      primaryOrder: (d.isPlant ? plantOrder.get(d.parentId) : zoneOrder.get(d.parentId)) ?? 0,
      secondaryOrder: -1000 + d.order,
      parentSubject: d.parentUri,
      group: 'equipment',
    })
    stats.entities++
  }
}

// ─── Step 2: Spatial hierarchy ───────────────────────────────────────────────

if (enabledSteps.has(2)) {
  for (const floor of spatial.floors || []) {
    if (!inSubgraph(floor.id)) continue
    emit(floorUri(floor.id), 'rec:isPartOf', 'bldg:Building')
    stats.spatial++
  }

  const emittedRoomSpatial = new Set<string>()
  for (const room of spatial.rooms || []) {
    if (!inSubgraph(`room_${room.id}`)) continue
    const uri = roomUri(room.id)
    if (emittedRoomSpatial.has(uri)) continue
    emittedRoomSpatial.add(uri)
    if (room.floorId) {
      emit(uri, 'rec:isPartOf', floorUri(room.floorId))
      stats.spatial++
    }
  }
}

// Zone/equipment relation fix.
// A rec:HVACZone's hasPart object must be a Location/Space (Brick_nightly.ttl's rec:Space
// NodeShape) -- equipment is never zone hasPart equipment. Instead: a specific (non-generic)
// Equipment-category class feeds the zone (brick:Equipment's own NodeShape explicitly allows
// rec:Space as a brick:feeds object) plus hasLocation to the zone's room when one is resolved;
// the generic "HVAC_Equipment" fallback (unclassified) gets hasLocation only -- we don't know
// what it does, so asserting feeds would be a guess brick:feeds' own definition doesn't support
// ("some media is passed between them").
// Equipment types that extract from the zone rather than supply it -- located in the
// room, but never brick:feeds the zone (user, 2026-10-25: fume-hood dampers).
const NON_FEEDING_ZONE_TYPES = new Set(['fume_hood_damper'])

function emitEquipmentZoneRelation(zid: string, uri: string, brickClass: string, type?: string): void {
  if (brickClass !== 'HVAC_Equipment' && !(type && NON_FEEDING_ZONE_TYPES.has(type))) {
    emit(uri, 'brick:feeds', zoneUri(zid))
    stats.connections++
  }
  // Located in the room only when the zone resolves to exactly one; with several rooms the equipment's
  // own room is not known, so no room is guessed.
  const roomIds = zoneRoomIds(zid)
  if (roomIds.length === 1) {
    emit(uri, 'brick:hasLocation', roomUri(roomIds[0]))
    stats.connections++
  }
}

// ─── Step 3: Equipment & Point hierarchy ─────────────────────────────────────

if (enabledSteps.has(3)) {
  // Revived colliding devices → parent hasPart/rec:includes device (the inverse
  // of the default collision drop; the device's telemetry routes onto it via
  // pointOwnerUri below). Same rec:includes-vs-hasPart branch as the normal
  // Plant → Equipment emission below — a *_System plant's revived device is
  // still subject to nightly's sh:Warning against hasPart-on-System.
  for (const d of revivedDevices) {
    if (!inSubgraph(d.barePointId)) continue
    if (d.isPlant) {
      const parentBrickClass = plantPm.plants.find((p: any) => p.plantId === d.parentId)?.brickClass
      const rel = isSystemClass(parentBrickClass) ? 'rec:includes' : 'brick:hasPart'
      emit(d.parentUri, rel, d.uri)
      stats.hierarchy++
    } else {
      emitEquipmentZoneRelation(d.parentId, d.uri, d.brickClass)
    }
  }

  // Plant → Equipment. rec:includes for *_System plants (nightly's sh:Warning
  // on brick:hasPart-on-System) — brick:hasPart everywhere else, unchanged.
  // Skip collisions; they're Points, not Equipment.
  for (const pe of equipInv.plantEquipment || []) {
    if (!inSubgraph(pe.plantId)) continue
    const plant = plantPm.plants.find((p: any) => p.plantId === pe.plantId)
    const rel = isSystemClass(plant?.brickClass) ? 'rec:includes' : 'brick:hasPart'
    for (const eq of pe.equipment || []) {
      if (!isEquipmentClass(eq.brickClass || 'HVAC_Equipment')) continue
      if (isCollidingEquipment(pe.plantId, eq.id)) continue
      emit(plantUri(pe.plantId), rel, equipUri(pe.plantId, eq.id))
      stats.hierarchy++
    }
  }

  // Plant → Points → Subpoints. Points route to their resolved pointHost
  // (an equipment id or a Controller) when classify-all.ts resolved one —
  // never to a *_System plant directly. Points with no
  // pointHost (classify-all.ts resolved none for them)
  // keep the pre-existing plant-attachment behavior unchanged.
  for (const plant of plantPm.plants) {
    if (!inSubgraph(plant.plantId)) continue
    for (const pt of plant.points) {
      if (!inSubgraph(pt.bmsPointId)) continue
      let rel = isEquipmentClass(pt.brickClass) ? 'brick:hasPart' : 'brick:hasPoint'
      const explicitOwner = pointOwnerUri(plant.plantId, pt.bmsPointId)
      let owner = explicitOwner
      if (!owner && pt.pointHost) {
        if (pt.pointHost.hostType === 'controller') {
          owner = controllerUri(pt.pointHost.hostId)
        } else if (pt.pointHost.hostId === plant.plantId) {
          owner = null
        } else {
          // classify-all.ts's equipment correlation matches ANY captured
          // equipment-inventory entry, including sensor-location markers
          // (e.g. a "TS1" temperature_sensor captured only for its ductPath)
          // that never get emitted as their own Equipment entity — hasPoint
          // must not dangle on one. Fall back to this plant's Controller
          // (never bare plantUri — that's the fault ① this routing exists
          // to fix) when the resolved host isn't a real, emitted Equipment.
          const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)
          const eq = peq?.equipment?.find((e: any) => e.id === pt.pointHost.hostId)
          const targetCollides = isCollidingEquipment(plant.plantId, pt.pointHost.hostId)
          const isRealEquipment = eq && isEquipmentClass(eq.brickClass || 'HVAC_Equipment') && !targetCollides
          // A colliding target may still have a revived device URI (minted when its class is
          // specific, not the generic HVAC_Equipment fallback) -- check deviceOwners before
          // giving up to the Controller/plantUri fallback.
          const revivedOwner = targetCollides
            ? deviceOwners.get(plant.plantId)?.find(o => o.eqId === pt.pointHost.hostId && o.revived)
            : undefined
          // The colliding target may be this very point, already equipment-classed ("the
          // point IS the device", the non-revived owner addOwners() computes for it) -- then
          // it belongs on the plant itself, same as the hostId === plantId shortcut above,
          // not on the Controller (that fallback is for hosts that are never emitted at all).
          const isSelfDevice = targetCollides && deviceOwners.get(plant.plantId)
            ?.some(o => o.eqId === pt.pointHost.hostId && !o.revived && o.uri === pointUri(pt.bmsPointId))
          const fallbackCtrlId = plant.deviceInstance != null && plant.deviceName
            ? `${plant.deviceInstance}|${plant.deviceName}`
            : (peq?.station && peq?.controller ? `${peq.station}|${peq.controller}` : null)
          owner = isRealEquipment
            ? equipUri(plant.plantId, pt.pointHost.hostId)
            : revivedOwner
              ? revivedOwner.uri
              : isSelfDevice
                ? null
                : (fallbackCtrlId ? controllerUri(fallbackCtrlId) : null)
        }
      }
      // An equipment-classed point attached to a *_System plant is a System member:
      // rec:includes, mirroring the Plant → Equipment loop's rel choice above.
      if (!owner && rel === 'brick:hasPart' && isSystemClass(plant.brickClass)) rel = 'rec:includes'
      emit(owner ?? plantUri(plant.plantId), rel, pointUri(pt.bmsPointId))
      stats.hierarchy++
    }
  }

  // Device points → their controller node (hasPoint; the node also hosts them, below).
  for (const dev of devicePm) {
    for (const pt of dev.points || []) {
      if (!inSubgraph(pt.bmsPointId)) continue
      emit(controllerUri(deviceHostId(dev, pt)), isEquipmentClass(pt.brickClass) ? 'brick:hasPart' : 'brick:hasPoint', pointUri(pt.bmsPointId))
      stats.hierarchy++
    }
  }

  // Zone → Equipment (feeds + hasLocation) — skip collisions; they're routed as revived
  // devices above instead. See emitEquipmentZoneRelation for the relation-choice rule.
  const knownZoneIdsStep3 = new Set(zonePm.zones.map((z: any) => z.zoneId))
  for (const ze of equipInv.zoneEquipment || []) {
    if (!inSubgraph(ze.zoneId)) continue
    if (!knownZoneIdsStep3.has(ze.zoneId)) continue
    for (const eq of ze.equipment || []) {
      const cls = eq.brickClass || 'HVAC_Equipment'
      if (!isEquipmentClass(cls)) continue
      if (isCollidingEquipment(ze.zoneId, eq.id)) continue
      emitEquipmentZoneRelation(ze.zoneId, equipUri(ze.zoneId, eq.id), cls, eq.type)
    }
  }

  // Image-only sensors → their zone/plant (hasPoint; no timeseries reference exists).
  for (const s of imageOnlySensors) {
    if (!inSubgraph(`${s.parentId}_${s.eqId}`)) continue // project URI convention: fixed "_" (not the building's naming); subgraph key
    emit(s.isPlant ? plantUri(s.parentId) : zoneUri(s.parentId), 'brick:hasPoint', s.uri)
    stats.hierarchy++
  }

  // Zone → Points → Subpoints
  for (const zone of zonePm.zones) {
    if (!inSubgraph(zone.zoneId)) continue
    for (const pt of zone.points) {
      if (!inSubgraph(pt.bmsPointId)) continue
      const rel = isEquipmentClass(pt.brickClass) ? 'brick:hasPart' : 'brick:hasPoint'
      const owner = pointOwnerUri(zone.zoneId, pt.bmsPointId)
      emit(owner ?? zoneUri(zone.zoneId), rel, pointUri(pt.bmsPointId))
      stats.hierarchy++
    }
  }

  // Controller nodes: one per unique (deviceInstance, deviceName) referenced by
  // any point's pointHost, shared across every plant that references it.
  const controllersSeen = new Map<string, { deviceInstance: string; deviceName: string; controlledEquipIds: Set<string>; plantIds: Set<string> }>()
  for (const plant of plantPm.plants) {
    if (!inSubgraph(plant.plantId)) continue
    for (const pt of plant.points) {
      if (!inSubgraph(pt.bmsPointId)) continue
      if (pt.pointHost?.hostType !== 'controller') continue
      const [deviceInstance, deviceName] = pt.pointHost.hostId.split('|')
      const uri = controllerUri(pt.pointHost.hostId)
      if (!controllersSeen.has(uri)) controllersSeen.set(uri, { deviceInstance, deviceName, controlledEquipIds: new Set(), plantIds: new Set() })
      controllersSeen.get(uri)!.plantIds.add(plant.plantId)
    }
    // Equipment this plant's Controller (if any) controls: every equipment-hosted
    // point on a *_System plant implies its host is under this plant's Controller,
    // if the plant also has any Controller-fallback points (same physical device).
    // Only equipment actually emitted as an entity qualifies (mirrors the same
    // isEquipmentClass/isCollidingEquipment filter the "Plant → Equipment" block
    // above applies) — pointHost.hostId can also be a captured sensor-location
    // marker (e.g. ductPath-only "TS1"/"TS2" entries with a Point-category
    // brickClass) that was never emitted, and brick:controls must not dangle.
    if (isSystemClass(plant.brickClass)) {
      const peq = equipInv.plantEquipment?.find((p: any) => p.plantId === plant.plantId)
      const controllerHostIds = new Set<string>(plant.points.filter((p: any) => p.pointHost?.hostType === 'controller').map((p: any) => p.pointHost.hostId))
      for (const hid of controllerHostIds) {
        const uri = controllerUri(hid)
        const entry = controllersSeen.get(uri)
        if (!entry) continue
        for (const pt of plant.points) {
          if (pt.pointHost?.hostType !== 'equipment' || pt.pointHost.hostId === plant.plantId) continue
          const eq = peq?.equipment?.find((e: any) => e.id === pt.pointHost.hostId)
          if (!eq || !isEquipmentClass(eq.brickClass || 'HVAC_Equipment')) continue
          // A colliding target may still have a revived device URI (mirrors the owner-resolution
          // fallback a few dozen lines above) -- don't drop it just because its natural equipUri
          // collides with a Point; only skip when neither a natural node nor a revived one exists.
          // Also keep a self-device (the colliding point IS the equipment, see owner resolution
          // above) -- it's emitted, at the point's own URI, so brick:controls doesn't dangle.
          if (isCollidingEquipment(plant.plantId, eq.id)
            && !deviceOwners.get(plant.plantId)?.find(o => o.eqId === eq.id && (o.revived || o.uri === pointUri(pt.bmsPointId)))) continue
          entry.controlledEquipIds.add(`${plant.plantId}::${pt.pointHost.hostId}`)
        }
      }
    }
  }
  // A device whose only points are device points still gets its controller node.
  for (const dev of devicePm) {
    for (const pt of dev.points || []) {
      if (!inSubgraph(pt.bmsPointId)) continue
      const hostId = deviceHostId(dev, pt)
      const uri = controllerUri(hostId)
      if (!controllersSeen.has(uri)) controllersSeen.set(uri, { deviceInstance: String(dev.deviceInstance), deviceName: dev.deviceName, controlledEquipIds: new Set(), plantIds: new Set() })
    }
  }
  for (const [ctrlUri, info] of controllersSeen) {
    // A numeric deviceInstance means a real BACnet device (BACnet-shaped); a station/panel
    // string identity (timeseries-shaped) is not BACnet -- use the generic brick:Controller class
    // rather than misrepresenting the protocol.
    const isBacnetShaped = /^\d+$/.test(info.deviceInstance)
    emit(ctrlUri, 'a', isBacnetShaped ? 'brick:BACnet_Controller' : 'brick:Controller')
    emitLabel(ctrlUri, info.deviceName)
    register(ctrlUri, { section: 'bacnet', primaryOrder: 1000 + [...controllersSeen.keys()].indexOf(ctrlUri), secondaryOrder: 0 })
    for (const key of info.controlledEquipIds) {
      const [pid, eid] = key.split('::')
      const revivedOwner = deviceOwners.get(pid)?.find(o => o.eqId === eid && o.revived)
      emit(ctrlUri, 'brick:controls', revivedOwner ? revivedOwner.uri : equipUri(pid, eid))
    }
    // hasPoint: fallback-routed points already got this via Step 2's owner routing
    // (owner = controllerUri(...) for Controller-hosted points) — nothing new here.
    // hosts: network-exposure fact for EVERY point on EVERY plant this Controller
    // backs, regardless of hasPoint target — additive, not exclusive with hasPoint.
    for (const pid of info.plantIds) {
      const plant = plantPm.plants.find((p: any) => p.plantId === pid)
      for (const pt of plant?.points || []) {
        if (!inSubgraph(pt.bmsPointId)) continue
        if (pt.tsdb?.deviceInstance != null && String(pt.tsdb.deviceInstance) === info.deviceInstance) {
          emit(ctrlUri, 'brick:hosts', pointUri(pt.bmsPointId))
        }
      }
    }
    // Device points: hosted by the device's own controller node.
    for (const dev of devicePm) {
      for (const pt of dev.points || []) {
        if (!inSubgraph(pt.bmsPointId)) continue
        if (controllerUri(deviceHostId(dev, pt)) === ctrlUri) emit(ctrlUri, 'brick:hosts', pointUri(pt.bmsPointId))
      }
    }
  }

  // *_System plants' Controller membership: rec:includes (not hasPart, per the
  // same nightly sh:Warning as the equipment block above).
  for (const plant of plantPm.plants) {
    if (!inSubgraph(plant.plantId) || !isSystemClass(plant.brickClass)) continue
    const controllerHostIds = new Set<string>(plant.points.filter((p: any) => p.pointHost?.hostType === 'controller').map((p: any) => p.pointHost.hostId))
    for (const hid of controllerHostIds) emit(plantUri(plant.plantId), 'rec:includes', controllerUri(hid))
  }
}

// ─── Step 4: Cross-cutting relationships ─────────────────────────────────────

if (enabledSteps.has(4)) {
  const knownZoneIds = new Set(zonePm.zones.map((z: any) => z.zoneId))

  for (const f of connections.plantFeedsZone || []) {
    if (!inSubgraph(f.plantId)) continue
    for (const zId of f.zoneIds || []) {
      if (!inSubgraph(zId)) continue
      if (!knownZoneIds.has(zId)) continue
      emit(plantUri(f.plantId), 'brick:feeds', zoneUri(zId))
      stats.connections++
    }
  }

  for (const s of connections.plantServesPlant || []) {
    for (const targetId of s.servesPlantIds || []) {
      if (!inSubgraph(s.plantId) && !inSubgraph(targetId)) continue
      emit(plantUri(s.plantId), 'brick:feeds', plantUri(targetId))
      stats.connections++
    }
  }

  for (const h of connections.plantHierarchy || []) {
    if (!inSubgraph(h.plantId) && !inSubgraph(h.parentPlantId)) continue
    emit(plantUri(h.plantId), 'brick:isPartOf', plantUri(h.parentPlantId))
    stats.connections++
  }

  // Equipment-classed root plants get hasLocation, not isPartOf (Brick's Equipment NodeShape
  // restricts isPartOf's object to System/Equipment/rec:Collection -- Building isn't one; the
  // generic hasLocation shape does allow Building, since bldg:Building is rec:Architecture).
  // System-classed root plants keep isPartOf -- not a shape violation for System (checked
  // brick:System's and rec:Collection's own NodeShapes directly, neither constrains isPartOf),
  // and nothing else anchors them to the spatial graph today (see design doc).
  const childPlantIds = new Set((connections.plantHierarchy || []).map((h: any) => h.plantId))
  for (const plant of plantPm.plants) {
    if (!inSubgraph(plant.plantId)) continue
    if (childPlantIds.has(plant.plantId)) continue
    const rel = isEquipmentClass(plant.brickClass) ? 'brick:hasLocation' : 'brick:isPartOf'
    emit(plantUri(plant.plantId), rel, 'bldg:Building')
    stats.connections++
  }

  // Zone hasLocation Room (a zone may cover several rooms; duplicate room ids collapse to one link)
  for (const sz of spatial.zones || []) {
    if (!inSubgraph(sz.id)) continue
    for (const roomId of zoneRoomIds(sz.id)) {
      emit(zoneUri(sz.id), 'brick:hasLocation', roomUri(roomId))
      stats.connections++
    }
  }
}

// ─── Step 5: BACnet devices, TSDB references, units ──────────────────────────

const seenUnits: string[] = []

if (enabledSteps.has(5)) {
  // BACnet devices
  bacnetDevices.forEach((dev, idx) => {
    const devUri = deviceUri(dev.deviceId)
    emit(devUri, 'a', 'bacnet:BACnetDevice')
    emitLabel(devUri, dev.deviceName)
    emitLiteral(devUri, 'bacnet:device-instance', String(dev.deviceInstance))
    register(devUri, { section: 'bacnet', primaryOrder: idx, secondaryOrder: 0 })
    if (dev.ipAddress) {
      const hex = ipv4ToHex(dev.ipAddress)
      block(devUri).bacnetPortFields = [
        ['a', 'bacnet:Port'],
        ['bacnet:network-type', 'bacnet:NetworkType.ipv4'],
        // Match the reference's xsd:hexBinary IP encoding when the address is dotted IPv4.
        ['bacnet:ip-address', hex ? `"${hex}"^^xsd:hexBinary` : `"${dev.ipAddress}"`],
      ]
    }
  })

  function emitRefsForPoints(points: any[]): void {
    for (const pt of points) {
      if (!inSubgraph(pt.bmsPointId)) continue
      if (pt.tsdb?.units) seenUnits.push(pt.tsdb.units)
      if (pt.tsdb?.id) { emitExternalRefs(pointUri(pt.bmsPointId), pt.tsdb); stats.tsdb++ }
      const uri = pt.tsdb?.units ? unitUri(pt.tsdb.units) : undefined
      if (uri) {
        emit(pointUri(pt.bmsPointId), 'brick:hasUnit', uri)
        stats.units++
      }
    }
  }

  for (const plant of plantPm.plants) {
    if (!inSubgraph(plant.plantId)) continue
    emitRefsForPoints(plant.points)
  }
  for (const zone of zonePm.zones) {
    if (!inSubgraph(zone.zoneId)) continue
    emitRefsForPoints(zone.points)
  }
  for (const dev of devicePm) emitRefsForPoints(dev.points || [])
}

// ─── Writer: format blocks into nested Turtle ─────────────────────────────────

const PREDICATE_ORDER = [
  'a',
  'rdfs:label',
  'rdfs:comment',
  'rec:levelNumber',
  'rec:isPartOf',
  'brick:isPartOf',
  'brick:hasPart',
  'brick:hasPoint',
  'brick:feeds',
  'brick:hasLocation',
  'brick:hasUnit',
  'bacnet:device-instance',
  'bacnet:hasPort',
]

function sortPredicates(preds: Map<string, string[]>): Array<[string, string[]]> {
  const entries = [...preds.entries()]
  return entries.sort(([a], [b]) => {
    const ai = PREDICATE_ORDER.indexOf(a)
    const bi = PREDICATE_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function formatBlock(b: Block): string {
  const sorted = sortPredicates(b.preds)
  // Append externalRef and bacnetPort as pseudo-predicates (handled separately at emit time)
  const hasExtras = !!b.externalRef || !!b.bacnetPortFields
  const lines: string[] = []

  // Total emission units = sorted predicates + extras
  const total = sorted.length + (b.externalRef ? 1 : 0) + (b.bacnetPortFields ? 1 : 0)
  let emitted = 0

  for (const [pred, objs] of sorted) {
    emitted++
    const isLast = emitted === total
    const term = isLast ? ' .' : ' ;'
    const prefix = emitted === 1 ? `${b.subject} ${pred}` : `    ${pred}`

    if (objs.length === 1) {
      lines.push(`${prefix} ${objs[0]}${term}`)
    } else {
      // Multi-object: comma-separated, indented continuation
      const indent = ' '.repeat(prefix.length + 1)
      lines.push(`${prefix} ${objs[0]} ,`)
      for (let i = 1; i < objs.length - 1; i++) {
        lines.push(`${indent}${objs[i]} ,`)
      }
      lines.push(`${indent}${objs[objs.length - 1]}${term}`)
    }
  }

  if (b.bacnetPortFields) {
    emitted++
    const isLast = emitted === total
    const term = isLast ? ' .' : ' ;'
    lines.push(`    bacnet:hasPort [`)
    b.bacnetPortFields.forEach(([p, o], i) => {
      const inner = i === b.bacnetPortFields!.length - 1 ? '' : ' ;'
      lines.push(`        ${p} ${o}${inner}`)
    })
    lines.push(`    ]${term}`)
  }

  if (b.externalRef) {
    emitted++
    const isLast = emitted === total
    const term = isLast ? ' .' : ' ;'
    lines.push(`    ref:hasExternalReference [`)
    lines.push(`        a ${b.externalRef.type} ;`)
    b.externalRef.props.forEach(([p, o], i) => {
      const inner = i === b.externalRef!.props.length - 1 ? '' : ' ;'
      lines.push(`        ${p} ${o}${inner}`)
    })
    lines.push(`    ]${term}`)
  }

  // Edge case: zero predicates + extras only — unusual but handle gracefully
  if (lines.length === 0 && !hasExtras) {
    lines.push(`${b.subject} a brick:Entity .`)
  }

  return lines.join('\n')
}

// ─── Section banner helpers ──────────────────────────────────────────────────

// Shared total line width for every banner tier (section/category/plant), so their right
// edges all land on the same column when scanning down the file -- categoryBanner and the
// per-plant divider both used to target a different width than this and each other (found
// by the user comparing a category banner directly against the plant divider right below
// it), fixed 2026-08-27 by having all three compute off this one constant instead of their
// own separate magic numbers.
const BANNER_WIDTH = 78 // '# ' + 76 fill characters
function banner(text: string): string {
  const line = '# ' + '='.repeat(BANNER_WIDTH - 2)
  return `${line}\n# ${text}\n${line}`
}
function subBanner(text: string): string {
  return `# ---- ${text} ----`
}
// Short (not full-width), but using the plant/zone divider's own '─' character/bookend
// instead of subBanner's '-'/4 -- specifically for the plant-level "Points" marker, per user
// request 2026-08-27 (after trying full-width dashed, full-width '─', and short '─' didn't
// land right either the first two times): "# ──── Points ────", same short shape as
// "# ---- Points ----" just with the divider's own character. Bookend is 4, matching the
// plant/zone divider's own bookend (also bumped to 4, from 3, same request).
function subBannerLine(text: string): string {
  return `# ──── ${text} ────`
}
// Entity divider, one tier below categoryBanner -- used for both the plant/zone divider
// ('─', bookend 3) and the equipment divider one level deeper ('-', bookend 4, no indent --
// tried indented 2026-08-27, user asked to remove it). The equipment one deliberately reuses
// subBanner's own '----' character/count (also 2026-08-27, replacing first a '┄' box-drawing
// glyph, then a '#' fill -- neither was liked; the user asked for the exact same style as the
// plain '---- Points ----' marker, just extended out to the full banner width instead of
// staying short) so it reads as the *same* visual language as the Equipment/Points markers,
// just a wider variant, distinguished from the plant divider by character/bookend alone now.
// Both still target BANNER_WIDTH's right edge.
function entityDivider(label: string, indent: string, ch: string, bookend: number): string {
  const prefix = `${indent}# ${ch.repeat(bookend)} `
  const fill = Math.max(3, BANNER_WIDTH - prefix.length - label.length - 1)
  return `${prefix}${label} ${ch.repeat(fill)}`
}
// Mid-tier banner for a category group (Plants by system, Zones by floor, Rooms by floor)
// -- visually distinct from both the full-width '====' top-level section banner and the
// plain '---- X ----' per-plant Equipment/Points sub-banner one level below it, so a group
// like "Ventilation" doesn't get lost among all the plant names and their own Equipment/
// Points headers under it. Added 2026-08-27 per user request after the first reorder pass.
function categoryBanner(text: string, count: number, noun: string): string {
  const line = '# ' + '-'.repeat(BANNER_WIDTH - 2)
  const label = `${text.toUpperCase()} (${count} ${noun}${count === 1 ? '' : 's'})`
  return `${line}\n# ${label}\n${line}`
}

// ─── Assemble output by section ──────────────────────────────────────────────

const allBlocks = [...blocks.values()]

function blocksFor(section: SectionId): Block[] {
  return allBlocks.filter(b => b.meta.section === section)
}

const out: string[] = []

const prefixes = [
  `@prefix brick:  <https://brickschema.org/schema/Brick#> .`,
  `@prefix tag:    <https://brickschema.org/schema/BrickTag#> .`,
  `@prefix rec:    <https://w3id.org/rec#> .`,
  `@prefix ref:    <https://brickschema.org/schema/Brick/ref#> .`,
  `@prefix bacnet: <http://data.ashrae.org/bacnet/2020#> .`,
  `@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .`,
  `@prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .`,
  `@prefix unit:   <http://qudt.org/vocab/unit/> .`,
  `@prefix bldg:   <urn:${buildingId}/> .`,
]
out.push(prefixes.join('\n'))
out.push('')

// --- Building & Spatial section ---
const buildingBlocks = blocksFor('building')
const floorBlocks = blocksFor('floors').sort((a, b) => a.meta.primaryOrder - b.meta.primaryOrder)
const roomBlocks = blocksFor('rooms').sort((a, b) => {
  if (a.meta.primaryOrder !== b.meta.primaryOrder) return a.meta.primaryOrder - b.meta.primaryOrder
  const ak = (a.meta as any).naturalSortKey || a.subject
  const bk = (b.meta as any).naturalSortKey || b.subject
  return ak.localeCompare(bk)
})

if (buildingBlocks.length || floorBlocks.length || roomBlocks.length) {
  out.push(banner('Building & Spatial'))
  out.push('')
  for (const b of buildingBlocks) { out.push(formatBlock(b)); out.push('') }
  for (const b of floorBlocks) { out.push(formatBlock(b)); out.push('') }

  // Group rooms under sub-banners per floor
  const roomsByFloor = new Map<string, Block[]>()
  for (const rb of roomBlocks) {
    const key = (rb.meta as any).floorKey || 'unknown'
    if (!roomsByFloor.has(key)) roomsByFloor.set(key, [])
    roomsByFloor.get(key)!.push(rb)
  }
  const orderedFloorKeys = [...roomsByFloor.keys()].sort((a, b) => {
    const af = floorBlocks.find(f => f.subject === floorUri(a))
    const bf = floorBlocks.find(f => f.subject === floorUri(b))
    return (af?.meta.primaryOrder ?? 999) - (bf?.meta.primaryOrder ?? 999)
  })
  for (const fkey of orderedFloorKeys) {
    const floorBlock = blocks.get(floorUri(fkey))
    const floorLabel = floorBlock?.preds.get('rdfs:label')?.[0]?.replace(/^"|"$/g, '') || fkey
    const roomsHere = roomsByFloor.get(fkey)!
    // Same tier-2 category-banner treatment as Plants (by system) and Zones (by floor) --
    // added 2026-08-27 for consistency, same request as those.
    out.push(categoryBanner(`Rooms on ${floorLabel}`, roomsHere.length, 'room'))
    out.push('')
    for (const rb of roomsHere) { out.push(formatBlock(rb)); out.push('') }
  }
}

// --- Plants/Zones section: grouped per plant/zone with sub-banners, optionally bucketed
// into a further layer of category sub-banners (groupOrder) -- Plants by system category
// (mirroring a BMS's own plant-overview tabs), Zones by floor (mirroring Rooms).
function emitNestedSection(sectionId: SectionId, title: string, groupOrder?: string[], groupNoun = 'item'): void {
  const items = blocksFor(sectionId)
  if (items.length === 0) return
  const headers = items.filter(b => b.meta.group === 'header')
    .sort((a, b) => a.meta.primaryOrder - b.meta.primaryOrder)
  if (headers.length === 0) return

  out.push(banner(title))
  out.push('')

  function emitHeader(h: Block): void {
    // Per-plant/zone divider, distinct from both the category banner above (tier 2, '----'
    // boxed) and the Equipment divider below (tier 4, indented '┄') -- added 2026-08-27 per
    // user request: without it, a plant's last Point block and the next plant's header line
    // looked identical in weight (both just `bldg:X a ...` at column 0).
    const cls = (h.preds.get('a')?.[0] || '').replace(/^(brick|rec):/, '')
    const plantLabel = cls ? `${h.subject.replace(/^bldg:/, '')} (${cls})` : h.subject.replace(/^bldg:/, '')
    out.push(entityDivider(plantLabel, '', '─', 4))
    out.push('')
    // Plant/zone header itself
    out.push(formatBlock(h))
    out.push('')

    // Children (equipment + points) sharing this parent. Bucketed by each entity's own
    // RESOLVED brickClass category (Equipment vs. Point), not by b.meta.group (which JSON
    // source file it was extracted from) -- fixed 2026-08-27, found by the user: a "revived
    // device" point (e.g. VA07_P1, a bare point whose own id collided with what would be
    // an equipment id) is genuinely brick:Hot_Water_Pump, Equipment-category, and is already
    // correctly related via the plant's own brick:hasPart (not hasPoint) -- the real model
    // was always right. isEquipmentClass already gates every 'equipment'-group registration to
    // Equipment-category-only, so re-deriving the split this way is a no-op for every entity
    // that was already correctly bucketed -- it only moves entities like P1 into the bucket
    // its own model relationship already puts it in (and, as a side effect, into the per-
    // equipment loop below, so it now gets its own divider + its own hosted points too --
    // no separate "revived device" handling needed here any more).
    const children = items.filter(b => b.meta.parentSubject === h.subject)
    const equipment = children.filter(b => isEquipmentClass(b.preds.get('a')?.[0] || ''))
      .sort((a, b) => a.meta.secondaryOrder - b.meta.secondaryOrder)
    const points = children.filter(b => !isEquipmentClass(b.preds.get('a')?.[0] || ''))
      .sort((a, b) => a.meta.secondaryOrder - b.meta.secondaryOrder)
    const pointsByUri = new Map(points.map(p => [p.subject, p]))

    // Restructured 2026-08-27 per user request: the plant/zone's OWN directly-hosted points
    // (no specific equipment owner) print first, right after the header -- the plant and its own
    // points -- before any equipment. Each equipment item then gets its own divider (one
    // tier below the plant's, visually distinct: indented, '┄' instead of '─') followed by
    // just that equipment's own points, instead of one blanket 'Equipment' banner covering
    // every item with all points deferred to a separate flat section afterward.
    const claimed = new Set<string>()
    for (const e of equipment) {
      for (const uri of e.preds.get('brick:hasPoint') || []) {
        if (uri !== e.subject) claimed.add(uri)
      }
    }
    const plantLevelPoints = points.filter(p => !claimed.has(p.subject))
    if (plantLevelPoints.length) {
      // Short, plant-divider character: "# ─── Points ───" -- see subBannerLine's own comment.
      out.push(subBannerLine('Points'))
      out.push('')
      for (const p of plantLevelPoints) { out.push(formatBlock(p)); out.push('') }
    }

    // Printed-once guard: a `hasPoint` list can itself contain the same URI more than once
    // (found 2026-08-27 -- pushPred() never deduplicates a predicate's
    // own object list) -- the earlier flat layout silently absorbed this via its own `claimed`
    // Set; this rewrite needs the same protection or a duplicate hasPoint entry prints the
    // same point's full definition twice (caught by validate-ttl's own "N type triples"
    // duplicate-subject warning before this could have shipped).
    const printed = new Set<string>()
    for (const e of equipment) {
      const eCls = (e.preds.get('a')?.[0] || '').replace(/^(brick|rec):/, '')
      const eLabel = eCls ? `${e.subject.replace(/^bldg:/, '')} (${eCls})` : e.subject.replace(/^bldg:/, '')
      out.push(entityDivider(eLabel, '', '-', 4))
      out.push('')
      out.push(formatBlock(e))
      out.push('')
      const owned: Block[] = []
      for (const uri of e.preds.get('brick:hasPoint') || []) {
        if (uri === e.subject || printed.has(uri)) continue
        const p = pointsByUri.get(uri)
        if (!p) continue
        printed.add(uri)
        owned.push(p)
      }
      if (owned.length) {
        out.push(subBanner('Points'))
        out.push('')
        for (const p of owned) { out.push(formatBlock(p)); out.push('') }
      }
    }
  }

  if (!groupOrder) {
    for (const h of headers) emitHeader(h)
    return
  }

  const byGroup = new Map<string, Block[]>()
  for (const h of headers) {
    const key = h.meta.groupKey || 'Other'
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key)!.push(h)
  }
  const known = groupOrder.filter(g => byGroup.has(g))
  const rest = [...byGroup.keys()].filter(g => !known.includes(g)).sort((a, b) => a.localeCompare(b))
  for (const gkey of [...known, ...rest]) {
    const members = byGroup.get(gkey)!
    out.push(categoryBanner(gkey, members.length, groupNoun))
    out.push('')
    for (const h of members) emitHeader(h)
  }
}

emitNestedSection('plants', 'Plants', PLANT_CATEGORY_ORDER, 'plant')
emitNestedSection('zones', 'Zones', ZONE_FLOOR_GROUP_ORDER, 'zone')

// --- Controllers & BACnet Devices (moved to the end, 2026-08-26 -- a cross-cutting device
// index, not part of the primary Building -> Plants -> Zones narrative a human reads
// top-to-bottom; previously sat second, forcing readers through large forward-referencing
// hasPoint lists for plants/zones not introduced yet) ---
const bacnetBlocks = blocksFor('bacnet').sort((a, b) => a.meta.primaryOrder - b.meta.primaryOrder)
if (bacnetBlocks.length) {
  out.push(banner('Controllers & BACnet Devices'))
  out.push('')
  for (const b of bacnetBlocks) { out.push(formatBlock(b)); out.push('') }
}

// --- Any leftover blocks (shouldn't normally happen) ---
const sectionsCovered = new Set<SectionId>(['building', 'floors', 'rooms', 'bacnet', 'plants', 'zones'])
const leftover = allBlocks.filter(b => !sectionsCovered.has(b.meta.section))
if (leftover.length) {
  out.push(banner('Other'))
  out.push('')
  for (const b of leftover) { out.push(formatBlock(b)); out.push('') }
}

const output = out.join('\n')
const outputDir = resolve(dataDir, 'outputs')
mkdirSync(outputDir, { recursive: true })
const outPath = resolve(outputDir, outArg || (entityArg ? `${entityArg}.ttl` : 'building.ttl'))
writeFileSync(outPath, output, 'utf-8')

console.log(`TTL generated: ${outPath}`)
console.log(`  Entities:    ${stats.entities}`)
console.log(`  Spatial:     ${stats.spatial}`)
console.log(`  Hierarchy:   ${stats.hierarchy}`)
console.log(`  Connections: ${stats.connections}`)
console.log(`  TSDB refs:   ${stats.tsdb}`)
console.log(`  Units:       ${stats.units}`)
console.log(`  Total lines: ${output.split('\n').length}`)
const unmapped = Object.entries(unmappedUnits(seenUnits))
console.log(!enabledSteps.has(5)
  ? 'unmapped units: not checked (step 5 not run)'
  : unmapped.length
    ? `unmapped units: ${unmapped.length} distinct (${unmapped.map(([u, n]) => `${u}×${n}`).join(', ')})`
    : 'unmapped units: none')
