/**
 * update-equipment.ts
 *
 * Manages equipment-inventory.json — equipment and sensors per zone/plant.
 * Captures what's installed where, extracted from BMS room and plant schematics.
 *
 * This is a focused file independent of building_model.json.
 * The TTL generator joins it with spatial-hierarchy.json, brick-assignments.json,
 * building-connections.json, and the point mapping files.
 *
 * Usage:
 *   # Add zone equipment (from room schematic images)
 *   echo '<json>' | npx ts-node tools/update-equipment.ts <buildingId> --type zone
 *
 *   # Add plant equipment (from plant schematic images)
 *   echo '<json>' | npx ts-node tools/update-equipment.ts <buildingId> --type plant
 *
 *   # Add zone metadata from rooms_overview images
 *   echo '<json>' | npx ts-node tools/update-equipment.ts <buildingId> --type zone-meta
 *
 *   # Write the point-list items for every plant and zone (no image needed; idempotent)
 *   npx ts-node tools/update-equipment.ts <buildingId> --bms
 *
 *   # Validate against spatial-hierarchy.json and brick-assignments.json
 *   npx ts-node tools/update-equipment.ts <buildingId> --validate
 *
 *   # Show summary
 *   npx ts-node tools/update-equipment.ts <buildingId> --summary
 *
 * Input JSON formats:
 *
 *   --type zone:
 *   {
 *     "zoneId": "Z_101",
 *     "zoneType": "VAV zone",
 *     "zoneFunction": "Office",
 *     "controller": "{controller}",
 *     "station": "{station}",
 *     "equipment": [
 *       {"id": "SD1", "type": "supply_diffuser"},
 *       {"id": "TR1", "type": "temperature_sensor"},
 *       {"id": "CO2_1", "type": "air_quality_sensor"},
 *       {"id": "OCC1", "type": "presence_sensor"},
 *       {"id": "HV1", "type": "heating_valve"}
 *     ],
 *     "sourceImage": "rooms/room_101.png",
 *     "confidence": "high"
 *   }
 *
 *   --type plant:
 *   {
 *     "plantId": "VE01",
 *     "plantName": "Air handling unit (office)",
 *     "controller": "{controller}",
 *     "station": "{station}",
 *     "ductOrientation": {"source": "human-confirmed", "referenceEquipment": "HX1", "legend": {"supply": "post-HX, room side", "return": "pre-HX, room side", "intake": "pre-HX, outside-air side", "exhaust": "post-HX, outside-air side"}},
 *     "equipment": [
 *       {"id": "SF1", "type": "supply_fan"},
 *       {"id": "RF1", "type": "return_fan"},
 *       {"id": "HX1", "type": "heat_exchanger"},
 *       {"id": "CC1", "type": "cooling_coil", "medium": "chilled"},
 *       {"id": "HTC1", "type": "heating_coil", "medium": "hot"}
 *     ],
 *     "sourceImage": "plants/ahu_01.png",
 *     "confidence": "high"
 *   }
 *   removeIds (optional, array of item ids; on --type plant and --type zone) removes those items from the
 *   entry before the merge -- used when
 *   an item written under a screen label is replaced by its point-list id (the new item carries
 *   "screenLabel"); an id not on the plant, or an id that is a point-list item of the plant (every write
 *   refills those from the point list), stops the write (exit 1, nothing written).
 *   ductOrientation is optional -- set once per plant, per HITL touchpoint 1 (human confirms
 *   orientation before equipment is enumerated). plantName/controller/station and each
 *   equipment item's medium are also optional -- see equipment-inventory/SKILL.md's equipment
 *   medium confirmation section for when/how to capture medium.
 *
 *   --type zone-meta (batch from rooms_overview):
 *   {
 *     "zones": [
 *       {"zoneId": "Z_101", "zoneFunction": "Office"},
 *       {"zoneId": "Z_102", "zoneFunction": "Meeting room"}
 *     ],
 *     "wingTab": "Level 1",
 *     "sourceImage": "rooms_overview/level_1.png",
 *     "confidence": "high"
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { loadProfile, compileRegex, dataRoot, BuildingProfile } from './lib/building-profile'
import { pointIdSeparator, isFlattenedChildPoint, pointGrammar, bmsDeviceBase, isSelfDevice, IdParts } from './lib/point-id'
import { idPartsFor } from './lib/point-parts'
import { loadPartsDictionary, NotEquipment, PartsDictionary } from './lib/point-dictionary'
import { equipmentWordTags } from './lib/tag-match'
import { waterSideWarnings } from './lib/water-sides'

// ─── Types ──────────────────────────────────────────────────────────────────

interface EquipmentItem {
  id: string
  type: string
  source?: 'image' | 'bms' | 'manual'
  description?: string
  // supply/return/exhaust/intake/preheat (air), water_supply/water_return (a plain or mixing loop), or an
  // interface side: primary_*, secondary_*, dhw_* (tools/lib/water-sides.ts; the skill's water positions)
  ductPath?: string | null
  medium?: 'hot' | 'chilled' | 'domestic' | 'cold' | 'condenser'
  // the screen's label when it differs from this item's point-list id (user-confirmed link)
  screenLabel?: string
}

interface ZoneEquipmentEntry {
  zoneId: string
  zoneType?: string
  zoneFunction?: string
  controller?: string
  station?: string
  equipment: EquipmentItem[]
  sourceImage: string
  confidence: 'high' | 'medium' | 'low'
  extractedAt: string
}

// Human-confirmed physical duct/pipe orientation legend for a plant (HITL touchpoint 1).
// classify-all.ts reads each equipment item's own ductPath and, for a point on an interface side
// (primary_/secondary_/dhw_) with no pump/valve on that side, this legend's referenceEquipment (the
// exchanger or tank that hosts the point). legend keys reuse ductPath's value vocabulary
// (supply/return/intake/exhaust/water_supply/water_return, or the interface sides primary_supply/
// secondary_return/dhw_supply/...) -- see the skill doc's water positions for the full list.
interface DuctOrientation {
  source: 'human-confirmed'
  referenceEquipment: string
  legend: Record<string, string>
}

interface PlantEquipmentEntry {
  plantId: string
  systemType?: 'heating' | 'cooling' | 'ventilation' | 'dhw' | 'chiller' | 'mixed'
  ductOrientation?: DuctOrientation
  plantName?: string
  controller?: string
  station?: string
  equipment: EquipmentItem[]
  sourceImage: string
  confidence: 'high' | 'medium' | 'low'
  extractedAt: string
}

interface EquipmentInventory {
  meta: {
    buildingId: string
    lastUpdated: string
    totalZoneEntries: number
    totalPlantEntries: number
    totalEquipmentItems: number
    bmsPass?: { at: string; mappingGeneratedAt: string | null }
  }
  zoneEquipment: ZoneEquipmentEntry[]
  plantEquipment: PlantEquipmentEntry[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function loadOrCreate(path: string, buildingId: string): EquipmentInventory {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'))
  }
  return {
    meta: {
      buildingId,
      lastUpdated: new Date().toISOString(),
      totalZoneEntries: 0,
      totalPlantEntries: 0,
      totalEquipmentItems: 0,
    },
    zoneEquipment: [],
    plantEquipment: [],
  }
}

function updateMeta(inv: EquipmentInventory): void {
  inv.meta.lastUpdated = new Date().toISOString()
  inv.meta.totalZoneEntries = inv.zoneEquipment.length
  inv.meta.totalPlantEntries = inv.plantEquipment.length
  inv.meta.totalEquipmentItems =
    inv.zoneEquipment.reduce((sum, z) => sum + z.equipment.length, 0) +
    inv.plantEquipment.reduce((sum, p) => sum + p.equipment.length, 0)
}

function save(path: string, inv: EquipmentInventory): void {
  updateMeta(inv)
  writeFileSync(path, JSON.stringify(inv, null, 2), 'utf-8')
}

// ─── BMS point mapping merge ────────────────────────────────────────────
// A point's token entry in the point dictionary (tokens.<context>, else tokens.any) names the
// equipment type of the item the point creates (equipmentType); a token without one creates no item.

interface PointMappingEntry {
  pointAbbreviation: string
  bmsPointId: string
  idParts?: IdParts
  semanticMeaning: string
}

interface ZonePointMapping {
  zones: Array<{
    zoneId: string
    pointCount: number
    points: PointMappingEntry[]
  }>
}

interface PlantPointMapping {
  plants: Array<{
    plantId: string
    pointCount: number
    points: PointMappingEntry[]
  }>
}

function loadZonePointMapping(dataDir: string): ZonePointMapping | null {
  const mappingPath = resolve(dataDir, 'inputs', 'zone-point-mapping.json')
  if (!existsSync(mappingPath)) return null
  return JSON.parse(readFileSync(mappingPath, 'utf-8'))
}

function loadPlantPointMapping(dataDir: string): PlantPointMapping | null {
  const mappingPath = resolve(dataDir, 'inputs', 'plant-point-mapping.json')
  if (!existsSync(mappingPath)) return null
  return JSON.parse(readFileSync(mappingPath, 'utf-8'))
}

// Dictionary tables, loaded once in main (point-dictionary.json, schemaVersion 3): the token entries,
// which abbreviations are not equipment, and the equipment-id rules used by normalizeEquipmentType.
let pointDict: PartsDictionary
let notEquipment: NotEquipment = { abbreviations: [], prefixes: [], source: '' }
interface CompiledIdRule { re: RegExp; type?: string; airDamper?: boolean; plantOnly?: boolean; dropIfSibling?: RegExp }
let equipmentIdRules: CompiledIdRule[] = []

function isNotEquipment(abbr: string): boolean {
  const ne = notEquipment
  return ne.abbreviations.includes(abbr) || ne.prefixes.some(p => abbr.startsWith(p))
}

// The equipmentType of the point's token entry: tokens.<context>, else tokens.any (the same
// fall-through as the point's parts). The token comes from the point's idParts.
function equipmentTypeOf(context: 'zone' | 'plant', groupId: string, pt: PointMappingEntry): string | undefined {
  const token = (pt.idParts ?? idPartsFor(pointGrammar(profile), groupId, pt.bmsPointId)).token
  for (const table of [pointDict.tokens[context], pointDict.tokens.any]) {
    if (table && Object.prototype.hasOwnProperty.call(table, token)) return table[token].equipmentType
  }
  return undefined
}

// The point-list items ("BMS floor") of one plant or zone, one rule for both routes: a point whose token
// entry has an equipmentType creates an item. The item id is the point's device base: for BACnet
// `{token}{number}` from its id parts, for timeseries the point abbreviation (a flattened suffix sub-row of
// another point is not its own device). An item whose id is the parent's own trailing device part is not
// created; its parent id goes into `selfDevice`.
function bmsEquipmentFor(context: 'zone' | 'plant', parentId: string, points: PointMappingEntry[], selfDevice?: string[]): EquipmentItem[] {
  const items: EquipmentItem[] = []
  const seen = new Set<string>()
  for (const pt of points) {
    const abbr = pt.pointAbbreviation
    if (isNotEquipment(abbr)) continue
    if (context === 'zone' && abbr.startsWith('_')) continue  // malformed

    let id: string | null
    if (profile.dataShape === 'bacnet') {
      id = bmsDeviceBase(pt.idParts ?? idPartsFor(pointGrammar(profile), parentId, pt.bmsPointId))
    } else {
      // flattened suffix sub-row of another point -- not its own physical equipment, just a
      // setpoint/fault/status field of an already-listed point. Real standalone points have
      // bmsPointId === `${parentId}${sep}${abbr}` exactly.
      id = isFlattenedChildPoint(pt.bmsPointId, parentId, abbr, pointIdSep) ? null : abbr
    }
    if (!id) continue
    const type = equipmentTypeOf(context, parentId, pt)
    if (!type) continue
    if (isSelfDevice(parentId, id, pointIdSep)) {
      if (selfDevice && !selfDevice.includes(parentId)) selfDevice.push(parentId)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    items.push({ id, type, source: 'bms' })
  }
  return items
}

function getBmsEquipmentForZone(mapping: ZonePointMapping | null, zoneId: string): EquipmentItem[] {
  const zone = mapping?.zones.find(z => z.zoneId === zoneId)
  return zone ? bmsEquipmentFor('zone', zoneId, zone.points) : []
}

function getBmsEquipmentForPlant(mapping: PlantPointMapping | null, plantId: string): EquipmentItem[] {
  const plant = mapping?.plants.find(p => p.plantId === plantId)
  return plant ? bmsEquipmentFor('plant', plantId, plant.points) : []
}

// ─── Equipment type normalization ────────────────────────────────────────────
// Corrects a mislabeled equipment `type` from the most reliable signals (ductPath,
// id, description word entries) regardless of how the entry was sourced, and DROPS
// non-device entries (returns null). Used both on upsert (image/bms merge) and by
// the `--normalize` command (re-derives `type` over the existing file — there is
// no from-scratch regen, the original image JSON isn't kept). Air-path dampers:
// Brick has no supply/return-only damper subclass, so the intake (outside-air)
// damper → outside_damper and the exhaust-to-atmosphere damper → exhaust_damper; only a
// genuine mixed-air box is mixing_damper.
function normalizeEquipmentType(eq: EquipmentItem, pointDesc = '', isPlant = false, siblingIds: string[] = []): string | null {
  const id = eq.id || ''
  const t = eq.type || ''
  const desc = eq.description || pointDesc || ''
  const dp = eq.ductPath || ''

  // Id rules come from the building's point dictionary (equipmentIdRules); first match wins.
  // Matched on the id, NOT the description. A rule either drops the item when a sibling id
  // matches its dropIfSibling, forces a type, or sends it into the air-damper direction block.
  let airDamperRule = false
  for (const rule of equipmentIdRules) {
    if (rule.plantOnly && !isPlant) continue
    if (!rule.re.test(id)) continue
    if (rule.dropIfSibling && siblingIds.some(sid => rule.dropIfSibling!.test(sid))) return null
    if (rule.type) return rule.type
    airDamperRule = !!rule.airDamper
    break
  }

  // Air-path damper direction is an AHU/PLANT concept (outside-air intake vs
  // atmosphere exhaust). ZONE supply/extract dampers are room VAVs, NOT
  // outside/exhaust — so only resolve direction for plant equipment; zone dampers
  // stay generic. Direction comes from ductPath then description (never id alone).
  // Only the air-path-ambiguous damper types (never fire_damper, which is already
  // specific and informative) — resolve their direction.
  // The description speaks through the building's equipment word entries' tags.
  const airDamperType = t === 'damper' || t === 'mixing_damper' || t === 'outside_damper' || t === 'exhaust_damper'
  if (isPlant && (airDamperType || airDamperRule)) {
    const words = equipmentWordTags(desc, pointDict.words)
    if (words.has('Fire')) return t // fire damper mislabeled as plain damper — leave as-is
    if (dp === 'intake' || words.has('Outside') || words.has('Intake')) return 'outside_damper'
    if (dp === 'exhaust' || words.has('Exhaust')) return 'exhaust_damper'
    if (words.has('Mixed')) return 'mixing_damper'
    return 'damper'
  }
  return t
}

// abbrev key "<parentId>|<abbr>" → point description, for enriching bms entries.
function buildPointDescMap(mapping: any): Map<string, string> {
  const m = new Map<string, string>()
  const parents = (mapping && (mapping.plants || mapping.zones)) || []
  for (const par of parents) {
    const pid = par.plantId || par.zoneId
    for (const pt of par.points || []) {
      m.set(`${pid}|${pt.pointAbbreviation}`, pt.danishDescription || '')
      for (const s of pt.subpoints || []) m.set(`${pid}|${s.pointAbbreviation || ''}`, s.danishDescription || '')
    }
  }
  return m
}

// Apply normalizeEquipmentType to a parent's equipment list (mutates types, drops nulls).
function normalizeEquipmentList(equipment: EquipmentItem[], parentId: string, descMap: Map<string, string>,
  isPlant: boolean, counters?: { changed: number; dropped: number }, siblingIds = equipment.map(e => e.id || '')): EquipmentItem[] {
  const kept: EquipmentItem[] = []
  for (const eq of equipment) {
    const nt = normalizeEquipmentType(eq, descMap.get(`${parentId}|${eq.id}`) || '', isPlant, siblingIds)
    if (nt === null) { if (counters) counters.dropped++; continue }
    if (nt !== eq.type) { if (counters) counters.changed++; eq.type = nt }
    kept.push(eq)
  }
  return kept
}

function normalizeInventory(inv: EquipmentInventory, plantMapping: any, zoneMapping: any): void {
  const pdesc = buildPointDescMap(plantMapping)
  const zdesc = buildPointDescMap(zoneMapping)
  const c = { changed: 0, dropped: 0 }
  for (const p of inv.plantEquipment || []) p.equipment = normalizeEquipmentList(p.equipment, p.plantId, pdesc, true, c)
  for (const z of inv.zoneEquipment || []) z.equipment = normalizeEquipmentList(z.equipment, z.zoneId, zdesc, false, c)
  console.log(`Normalized equipment types: ${c.changed} changed, ${c.dropped} dropped`)
}

// The one "fill only missing ids" rule: the items of `found` whose id is not already on the entry.
// An existing item (image fields included) is never touched or removed. The caller decides normalization:
// an image write normalizes the whole merged list (as always); the --bms pass normalizes only the items it
// adds, because it never alters an existing entry.
function addMissingItems(existing: EquipmentItem[], found: EquipmentItem[]): EquipmentItem[] {
  const have = new Set(existing.map(e => e.id))
  return found.filter(eq => !have.has(eq.id))
}


// ─── Commands ───────────────────────────────────────────────────────────────

// removeIds (plant and zone writes): items written under a screen label that is now replaced by its
// point-list id. Every id must be on the entry and none may be a point-list item (it would come straight
// back from the point list in this write, without its image fields); otherwise nothing is written.
function applyRemoveIds(kind: 'plant' | 'zone', parentId: string, current: { equipment: EquipmentItem[] } | undefined,
  removeIds: unknown, pointListItems: EquipmentItem[]): void {
  if (removeIds === undefined) return
  const ids = Array.isArray(removeIds) ? removeIds as string[] : null
  const missing = ids ? ids.filter(id => !current?.equipment.some(e => e.id === id)) : ['(removeIds must be an array)']
  if (missing.length > 0) {
    console.error(`removeIds not on ${kind} ${parentId}: ${missing.join(', ')} -- nothing written`)
    process.exit(1)
  }
  const pointListIds = new Set(pointListItems.map(e => e.id))
  const fromPointList = ids!.filter(id => pointListIds.has(id))
  if (fromPointList.length > 0) {
    console.error(`removeIds are point-list items of ${kind} ${parentId} and cannot be removed: ${fromPointList.join(', ')} -- nothing written`)
    process.exit(1)
  }
  if (current) current.equipment = current.equipment.filter(e => !ids!.includes(e.id))
}

function addZoneEquipment(inv: EquipmentInventory, data: any, bmsMapping: ZonePointMapping | null): void {
  const { zoneId, zoneType, zoneFunction, controller, station, equipment, sourceImage, confidence, removeIds } = data
  if (!zoneId || !Array.isArray(equipment)) {
    console.error('zone requires: zoneId, equipment[]')
    process.exit(1)
  }
  applyRemoveIds('zone', zoneId, inv.zoneEquipment.find(z => z.zoneId === zoneId), removeIds,
    getBmsEquipmentForZone(bmsMapping, zoneId))

  // Mark image-sourced equipment
  const imageEquipment: EquipmentItem[] = equipment.map((eq: any) => ({
    ...eq,
    source: eq.source || 'image',
  }))

  // Merge with BMS point mapping — BMS items are the floor, image adds extras
  const bmsEquipment = getBmsEquipmentForZone(bmsMapping, zoneId)
  const equipMap = new Map<string, EquipmentItem>()

  // BMS first (floor)
  for (const eq of bmsEquipment) {
    equipMap.set(eq.id, eq)
  }
  // Image overwrites — image-sourced items take precedence (richer type info)
  for (const eq of imageEquipment) {
    equipMap.set(eq.id, eq)
  }

  let mergedEquipment = [...equipMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  mergedEquipment = normalizeEquipmentList(mergedEquipment, zoneId, buildPointDescMap(bmsMapping), false)
  const bmsOnly = mergedEquipment.filter(e => e.source === 'bms').length

  // Upsert: if same zoneId exists, merge equipment and update metadata
  const existing = inv.zoneEquipment.find(z => z.zoneId === zoneId)
  if (existing) {
    // Merge policy: the payload's own equipment (imageEquipment) is this write's
    // authoritative update and always wins. The recomputed BMS floor (bmsEquipment) is
    // recomputed fresh on EVERY call for the whole zone regardless of what this write's
    // payload actually mentions, so it must only fill ids not already on file — it must
    // never clobber an existing (possibly image-enriched) entry just because this write's
    // payload happened not to repeat that id.
    const existMap = new Map([...existing.equipment, ...addMissingItems(existing.equipment, bmsEquipment)].map(e => [e.id, e]))
    for (const eq of imageEquipment) {
      existMap.set(eq.id, { ...existMap.get(eq.id), ...eq })
    }
    let merged = [...existMap.values()].sort((a, b) => a.id.localeCompare(b.id))
    merged = normalizeEquipmentList(merged, zoneId, buildPointDescMap(bmsMapping), false)
    existing.equipment = merged
    const bmsOnlyFinal = merged.filter(e => e.source === 'bms').length
    if (zoneType) existing.zoneType = zoneType
    if (zoneFunction) existing.zoneFunction = zoneFunction
    if (controller) existing.controller = controller
    if (station) existing.station = station
    existing.sourceImage = sourceImage || existing.sourceImage
    existing.confidence = confidence || existing.confidence
    existing.extractedAt = new Date().toISOString()
    console.log(`Updated zone: ${zoneId} -> ${existing.equipment.length} equipment items` +
      (bmsOnlyFinal > 0 ? ` (${bmsOnlyFinal} from BMS)` : ''))
  } else {
    inv.zoneEquipment.push({
      zoneId,
      zoneType: zoneType || undefined,
      zoneFunction: zoneFunction || undefined,
      controller: controller || undefined,
      station: station || undefined,
      equipment: mergedEquipment,
      sourceImage: sourceImage || '',
      confidence: confidence || 'high',
      extractedAt: new Date().toISOString(),
    })
    inv.zoneEquipment.sort((a, b) => a.zoneId.localeCompare(b.zoneId))
    console.log(`Added zone: ${zoneId} -> ${mergedEquipment.length} equipment items` +
      (bmsOnly > 0 ? ` (${bmsOnly} from BMS)` : ''))
  }
}

function addPlantEquipment(inv: EquipmentInventory, data: any, bmsMapping: PlantPointMapping | null): void {
  const { plantId, systemType, ductOrientation, plantName, controller, station, equipment, sourceImage, confidence, removeIds } = data
  if (!plantId || !Array.isArray(equipment)) {
    console.error('plant requires: plantId, equipment[]')
    process.exit(1)
  }
  applyRemoveIds('plant', plantId, inv.plantEquipment.find(p => p.plantId === plantId), removeIds,
    getBmsEquipmentForPlant(bmsMapping, plantId))

  // Mark image-sourced equipment
  const imageEquipment: EquipmentItem[] = equipment.map((eq: any) => ({
    ...eq,
    source: eq.source || 'image',
  }))

  // Merge with BMS point mapping
  const bmsEquipment = getBmsEquipmentForPlant(bmsMapping, plantId)
  const equipMap = new Map<string, EquipmentItem>()

  // BMS first (floor)
  for (const eq of bmsEquipment) {
    equipMap.set(eq.id, eq)
  }
  // Image overwrites
  for (const eq of imageEquipment) {
    equipMap.set(eq.id, eq)
  }

  let mergedEquipment = [...equipMap.values()].sort((a, b) => a.id.localeCompare(b.id))
  mergedEquipment = normalizeEquipmentList(mergedEquipment, plantId, buildPointDescMap(bmsMapping), true)
  const bmsOnly = mergedEquipment.filter(e => e.source === 'bms').length

  const existing = inv.plantEquipment.find(p => p.plantId === plantId)
  if (existing) {
    // Merge policy: the payload's own equipment (imageEquipment) is this write's
    // authoritative update and always wins. The recomputed BMS floor (bmsEquipment) is
    // recomputed fresh on EVERY call for the whole plant regardless of what this write's
    // payload actually mentions, so it must only fill ids not already on file — it must
    // never clobber an existing (possibly image-enriched) entry just because this write's
    // payload happened not to repeat that id.
    const existMap = new Map([...existing.equipment, ...addMissingItems(existing.equipment, bmsEquipment)].map(e => [e.id, e]))
    for (const eq of imageEquipment) {
      existMap.set(eq.id, { ...existMap.get(eq.id), ...eq })
    }
    let merged = [...existMap.values()].sort((a, b) => a.id.localeCompare(b.id))
    merged = normalizeEquipmentList(merged, plantId, buildPointDescMap(bmsMapping), true)
    existing.equipment = merged
    const bmsOnlyFinal = merged.filter(e => e.source === 'bms').length
    if (systemType) existing.systemType = systemType
    if (ductOrientation) existing.ductOrientation = ductOrientation
    if (plantName) existing.plantName = plantName
    if (controller) existing.controller = controller
    if (station) existing.station = station
    existing.sourceImage = sourceImage || existing.sourceImage
    existing.confidence = confidence || existing.confidence
    existing.extractedAt = new Date().toISOString()
    console.log(`Updated plant: ${plantId} -> ${existing.equipment.length} equipment items` +
      (bmsOnlyFinal > 0 ? ` (${bmsOnlyFinal} from BMS)` : ''))
  } else {
    inv.plantEquipment.push({
      plantId,
      systemType: systemType || undefined,
      ductOrientation: ductOrientation || undefined,
      plantName: plantName || undefined,
      controller: controller || undefined,
      station: station || undefined,
      equipment: mergedEquipment,
      sourceImage: sourceImage || '',
      confidence: confidence || 'high',
      extractedAt: new Date().toISOString(),
    })
    inv.plantEquipment.sort((a, b) => a.plantId.localeCompare(b.plantId))
    console.log(`Added plant: ${plantId} -> ${mergedEquipment.length} equipment items` +
      (bmsOnly > 0 ? ` (${bmsOnly} from BMS)` : ''))
  }
}

function addZoneMeta(inv: EquipmentInventory, data: any): void {
  const { zones, wingTab, sourceImage, confidence } = data
  if (!Array.isArray(zones)) {
    console.error('zone-meta requires: zones[]')
    process.exit(1)
  }

  let updated = 0
  let added = 0
  for (const z of zones) {
    const existing = inv.zoneEquipment.find(ze => ze.zoneId === z.zoneId)
    if (existing) {
      if (z.zoneFunction) existing.zoneFunction = z.zoneFunction
      existing.extractedAt = new Date().toISOString()
      updated++
    } else {
      inv.zoneEquipment.push({
        zoneId: z.zoneId,
        zoneFunction: z.zoneFunction || undefined,
        equipment: [],
        sourceImage: sourceImage || '',
        confidence: confidence || 'high',
        extractedAt: new Date().toISOString(),
      })
      added++
    }
  }
  inv.zoneEquipment.sort((a, b) => a.zoneId.localeCompare(b.zoneId))
  console.log(`Zone metadata from ${wingTab || 'overview'}: ${added} added, ${updated} updated (${zones.length} total)`)
}

// ─── --bms: point-list items for every plant and zone, independent of images ────

// One group kind (plants or zones) of the --bms pass: creates the entry only when it gets an item.
// Returns the number of items added.
function bmsFillGroup<E extends { equipment: EquipmentItem[] }>(
  entries: E[], groups: Array<{ points?: PointMappingEntry[] } & Record<string, any>>, idKey: 'plantId' | 'zoneId',
  mapping: unknown, selfDevice: string[], now: string,
): number {
  const isPlant = idKey === 'plantId'
  const descMap = buildPointDescMap(mapping)
  let count = 0
  for (const group of groups) {
    const id: string = group[idKey]
    const found = bmsEquipmentFor(isPlant ? 'plant' : 'zone', id, group.points ?? [], selfDevice)
    const entry = entries.find((e: any) => e[idKey] === id)
    const existing = entry?.equipment ?? []
    const siblings = [...existing.map(e => e.id), ...found.map(e => e.id)]
    const added = normalizeEquipmentList(addMissingItems(existing, found), id, descMap, isPlant, undefined, siblings)
    if (added.length === 0) continue
    if (entry) entry.equipment = [...existing, ...added].sort((a, b) => a.id.localeCompare(b.id))
    else entries.push({ [idKey]: id, equipment: added.sort((a, b) => a.id.localeCompare(b.id)), sourceImage: '', confidence: 'high', extractedAt: now } as unknown as E)
    count += added.length
  }
  return count
}

function bmsPass(inv: EquipmentInventory, plantMapping: PlantPointMapping | null, zoneMapping: ZonePointMapping | null): boolean {
  const selfDevice: string[] = []
  const now = new Date().toISOString()
  const plantItems = bmsFillGroup(inv.plantEquipment, plantMapping?.plants ?? [], 'plantId', plantMapping, selfDevice, now)
  const zoneItems = bmsFillGroup(inv.zoneEquipment, zoneMapping?.zones ?? [], 'zoneId', zoneMapping, selfDevice, now)
  let changed = plantItems + zoneItems > 0

  console.log(`plants +${plantItems} items, zones +${zoneItems} items, self-device skipped: ${selfDevice.length ? selfDevice.join(', ') : 'none'}`)
  // Record which mapping this pass covered (pipeline-status reads it); a no-op rerun stays a no-op once recorded.
  const mappingGeneratedAt = (plantMapping as { generatedAt?: string } | null)?.generatedAt ?? null
  if (inv.meta.bmsPass?.mappingGeneratedAt !== mappingGeneratedAt) changed = true
  if (changed) inv.meta.bmsPass = { at: now, mappingGeneratedAt }
  return changed
}

// ─── Validate ───────────────────────────────────────────────────────────────

function validate(dataDir: string, inv: EquipmentInventory): void {
  const issues: string[] = []

  // Load spatial hierarchy for zone validation
  const spatialPath = resolve(inputDir, 'spatial-hierarchy.json')
  let knownZoneIds: Set<string> = new Set()
  if (existsSync(spatialPath)) {
    const spatial = JSON.parse(readFileSync(spatialPath, 'utf-8'))
    knownZoneIds = new Set((Array.isArray(spatial.zones) ? spatial.zones : []).map((z: any) => z.id))
  } else {
    issues.push('WARN: spatial-hierarchy.json not found')
  }

  // Load brick assignments for plant validation
  const assignPath = resolve(dataDir, 'brick-assignments.json')
  let knownPlantIds: Set<string> = new Set()
  if (existsSync(assignPath)) {
    const assignments = JSON.parse(readFileSync(assignPath, 'utf-8'))
    knownPlantIds = new Set(Object.keys(assignments.plants || {}))
  } else {
    issues.push('WARN: brick-assignments.json not found')
  }

  // Validate zone entries
  for (const z of inv.zoneEquipment) {
    if (knownZoneIds.size > 0 && !knownZoneIds.has(z.zoneId)) {
      issues.push(`ZONE: unknown zone "${z.zoneId}"`)
    }
    if (z.equipment.length === 0 && !z.zoneFunction) {
      issues.push(`ZONE: ${z.zoneId} has no equipment and no metadata`)
    }
    // Check for duplicate equipment IDs within a zone
    const eqIds = z.equipment.map(e => e.id)
    const dupes = eqIds.filter((id, i) => eqIds.indexOf(id) !== i)
    if (dupes.length > 0) {
      issues.push(`ZONE: ${z.zoneId} has duplicate equipment: ${dupes.join(', ')}`)
    }
  }

  // Validate plant entries
  for (const p of inv.plantEquipment) {
    if (knownPlantIds.size > 0 && !knownPlantIds.has(p.plantId)) {
      issues.push(`PLANT: unknown plant "${p.plantId}"`)
    }
    const eqIds = p.equipment.map(e => e.id)
    const dupes = eqIds.filter((id, i) => eqIds.indexOf(id) !== i)
    if (dupes.length > 0) {
      issues.push(`PLANT: ${p.plantId} has duplicate equipment: ${dupes.join(', ')}`)
    }
  }

  // Coverage check
  if (knownZoneIds.size > 0) {
    const inventoryZones = new Set(inv.zoneEquipment.map(z => z.zoneId))
    const missing = [...knownZoneIds].filter(z => !inventoryZones.has(z))
    if (missing.length > 0) {
      issues.push(`COVERAGE: ${missing.length} zones in spatial-hierarchy.json have no equipment entry: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`)
    }
  }

  // Low-confidence entries
  const lowConf = [
    ...inv.zoneEquipment.filter(z => z.confidence === 'low'),
    ...inv.plantEquipment.filter(p => p.confidence === 'low'),
  ]
  if (lowConf.length > 0) {
    issues.push(`INFO: ${lowConf.length} low-confidence entries need review`)
  }

  // Touchpoint 1 rollout tracking: plants with ductPath-tagged equipment but no
  // human-confirmed ductOrientation yet.
  const needsOrientation = inv.plantEquipment.filter(p =>
    p.equipment.some(e => e.ductPath) && !p.ductOrientation
  )
  if (needsOrientation.length > 0) {
    issues.push(`INFO: ${needsOrientation.length} plant(s) have ductPath-tagged equipment but no human-confirmed ductOrientation: ${needsOrientation.map(p => p.plantId).slice(0, 10).join(', ')}${needsOrientation.length > 10 ? '...' : ''}`)
  }

  // Water interface sides the classifier cannot use (tools/lib/water-sides.ts).
  issues.push(...waterSideWarnings(inv.plantEquipment))

  if (issues.length === 0) {
    console.log('Validation passed: all equipment entries are consistent')
  } else {
    console.log(`Validation found ${issues.length} issue(s):`)
    for (const issue of issues) {
      console.log(`  - ${issue}`)
    }
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

function showSummary(inv: EquipmentInventory): void {
  console.log(`Equipment Inventory: ${inv.meta.buildingId}`)
  console.log(`  Last updated: ${inv.meta.lastUpdated}`)
  console.log(`  Zone entries:     ${inv.zoneEquipment.length}`)
  console.log(`  Plant entries:    ${inv.plantEquipment.length}`)
  console.log(`  Total equipment:  ${inv.meta.totalEquipmentItems}`)

  // Zone function breakdown
  const functions = new Map<string, number>()
  for (const z of inv.zoneEquipment) {
    const fn = z.zoneFunction || '(unknown)'
    functions.set(fn, (functions.get(fn) || 0) + 1)
  }
  if (functions.size > 0) {
    console.log('  Zone functions:')
    for (const [fn, count] of [...functions.entries()].sort()) {
      console.log(`    ${fn}: ${count}`)
    }
  }

  // Zone type breakdown
  const types = new Map<string, number>()
  for (const z of inv.zoneEquipment) {
    const t = z.zoneType || '(no type)'
    types.set(t, (types.get(t) || 0) + 1)
  }
  if (types.size > 0) {
    console.log('  Zone types:')
    for (const [t, count] of [...types.entries()].sort()) {
      console.log(`    ${t}: ${count}`)
    }
  }

  // Equipment type breakdown
  const eqTypes = new Map<string, number>()
  for (const z of inv.zoneEquipment) {
    for (const eq of z.equipment) {
      eqTypes.set(eq.type, (eqTypes.get(eq.type) || 0) + 1)
    }
  }
  for (const p of inv.plantEquipment) {
    for (const eq of p.equipment) {
      eqTypes.set(eq.type, (eqTypes.get(eq.type) || 0) + 1)
    }
  }
  if (eqTypes.size > 0) {
    console.log('  Equipment types:')
    for (const [t, count] of [...eqTypes.entries()].sort()) {
      console.log(`    ${t}: ${count}`)
    }
  }

  // Source images
  const images = new Set([
    ...inv.zoneEquipment.map(z => z.sourceImage),
    ...inv.plantEquipment.map(p => p.sourceImage),
  ].filter(Boolean))
  console.log(`  Source images: ${images.size}`)

  // Confidence breakdown
  const confCounts = { high: 0, medium: 0, low: 0 }
  for (const e of [...inv.zoneEquipment, ...inv.plantEquipment]) {
    confCounts[e.confidence] = (confCounts[e.confidence] || 0) + 1
  }
  console.log(`  Confidence: ${confCounts.high} high, ${confCounts.medium} medium, ${confCounts.low} low`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const buildingId = args[0]

if (!buildingId) {
  console.error('Usage: npx ts-node tools/update-equipment.ts <buildingId> --type <zone|plant|zone-meta> | --bms | --validate | --summary')
  process.exit(1)
}

let profile: BuildingProfile
let pointIdSep = '_'
try {
  profile = loadProfile(buildingId)
  const sepInfo = pointIdSeparator(profile)
  pointIdSep = sepInfo.separator
  if (sepInfo.note) console.log(sepInfo.note)
  pointDict = loadPartsDictionary(buildingId)
  if (pointDict.notEquipment) notEquipment = pointDict.notEquipment
  equipmentIdRules = (pointDict.equipmentIdRules ?? []).map(r => ({
    re: compileRegex(r), type: r.type, airDamper: r.airDamper, plantOnly: r.plantOnly,
    dropIfSibling: r.dropIfSibling ? compileRegex(r.dropIfSibling) : undefined,
  }))
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const dataDir = resolve(dataRoot(), buildingId)
const inputDir = resolve(dataDir, 'inputs')
const invPath = resolve(inputDir, 'equipment-inventory.json')
const inv = loadOrCreate(invPath, buildingId)

if (hasFlag(args, '--validate')) {
  validate(dataDir, inv)
} else if (hasFlag(args, '--summary')) {
  showSummary(inv)
} else if (hasFlag(args, '--bms')) {
  // Point-list items for every plant and zone in the mapping files (no image needed).
  if (bmsPass(inv, loadPlantPointMapping(dataDir), loadZonePointMapping(dataDir))) save(invPath, inv)
} else if (hasFlag(args, '--normalize')) {
  // Re-derive equipment `type` over the existing inventory (no re-extraction).
  normalizeInventory(inv, loadPlantPointMapping(dataDir), loadZonePointMapping(dataDir))
  save(invPath, inv)
} else {
  const type = getArg(args, '--type')
  if (!type) {
    console.error('Specify --type zone|plant|zone-meta, or --validate, or --summary')
    process.exit(1)
  }

  // Read data from stdin
  const stdinData = readFileSync(0, 'utf-8').trim()
  const data = JSON.parse(stdinData)

  // Load BMS point mappings for merge
  const zoneMapping = loadZonePointMapping(dataDir)
  const plantMapping = loadPlantPointMapping(dataDir)

  switch (type) {
    case 'zone':
      addZoneEquipment(inv, data, zoneMapping)
      break
    case 'plant':
      addPlantEquipment(inv, data, plantMapping)
      break
    case 'zone-meta':
      addZoneMeta(inv, data)
      break
    default:
      console.error(`Unknown type: ${type}. Use zone, plant, or zone-meta.`)
      process.exit(1)
  }

  save(invPath, inv)
}
