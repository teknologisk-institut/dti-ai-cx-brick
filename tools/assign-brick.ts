/**
 * assign-brick.ts
 *
 * Writes Brick (nightly) class assignments directly into source data files.
 * Each entity's brickClass lives next to its data — no separate assignments file.
 *
 * Target files by entity type:
 *   --type plant       → plant-point-mapping.json  (adds brickClass to plant entry)
 *   --type plant-point → plant-point-mapping.json  (adds brickClass to point or subpoint)
 *   --type zone        → zone-point-mapping.json   (adds brickClass to zone entry)
 *   --type zone-point  → zone-point-mapping.json   (adds brickClass to point or subpoint)
 *   --type equipment   → equipment-inventory.json   (adds brickClass to equipment item)
 *   --type floor       → spatial_data.json          (adds brickClass to floor entry)
 *   --type room        → spatial_data.json          (adds brickClass to room entry)
 *
 * Single-entity mode:
 *   npx ts-node tools/assign-brick.ts {buildingId} --type plant --id VE01 --class "Air_Handling_Unit"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type plant --id BSP01 --class "Fire_Safety_Equipment" --note "Fire-damper group"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type plant-point --plant VA07 --point TF1 --class "Leaving_Hot_Water_Temperature_Sensor"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type plant-point --plant VA07 --point TF1 --subpoint SP --class "Max_Temperature_Setpoint_Limit"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type zone --id Z_101 --class "rec:HVACZone"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type zone-point --zone Z_101 --point TR1 --class "Zone_Air_Temperature_Sensor"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type zone-point --zone Z_101 --point TR1 --subpoint SP --class "Target_Zone_Air_Temperature_Setpoint"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type equipment --parent VE01 --id SF1 --class "Supply_Fan"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type equipment --parent Z_101 --id V1 --class "Heating_Valve"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type floor --id level-1 --class "rec:Level"
 *   npx ts-node tools/assign-brick.ts {buildingId} --type room --id "1.01" --class "rec:Room"
 *
 * Batch mode (reads JSON from stdin):
 *   echo '[{"plant":"VA07","point":"TF1","class":"Leaving_Hot_Water_Temperature_Sensor"},...]' | npx ts-node tools/assign-brick.ts {buildingId} --type plant-point --batch
 *   echo '[{"zone":"Z_101","point":"TR1","class":"Zone_Air_Temperature_Sensor"},...]' | npx ts-node tools/assign-brick.ts {buildingId} --type zone-point --batch
 *   echo '[{"parent":"VE01","id":"SF1","class":"Supply_Fan"},...]' | npx ts-node tools/assign-brick.ts {buildingId} --type equipment --batch
 *
 * plant-point / zone-point batch entries accept an optional "bmsPointId" (the full compound id,
 * e.g. "Z_101_V1_SP") to disambiguate "point" -- flattened points' pointAbbreviation is only
 * the bare suffix (e.g. "SP", "AL", "ADJ"), which routinely collides across different base points
 * within the same plant/zone (e.g. a plant can have three "SP" points: TF1_SP, TF2_SP, TF3_SP). Without
 * bmsPointId, a batch entry is only applied if its "point" abbreviation is unique within that
 * plant/zone -- an ambiguous one is skipped with a loud error rather than silently guessed.
 *
 * Confidence (optional, points only):
 *   --confidence high|low   (defaults to "high")
 *
 * All writes use upsert semantics — existing brickClass is overwritten. Every write also sets
 * reviewedManually: true, which classify-all.ts checks and skips on any future rerun — a manual
 * assignment here is never silently reset by re-running the classifier.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { isBinarySensorMismatch } from './lib/tag-match'

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const buildingId = args[0]

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(name: string): boolean {
  return args.includes(name)
}

if (!buildingId) {
  console.error('Usage: npx ts-node tools/assign-brick.ts <buildingId> --type <type> ...')
  process.exit(1)
}

const type       = getArg('--type')
const id         = getArg('--id')
const plantId    = getArg('--plant')
const zoneId     = getArg('--zone')
const parentId   = getArg('--parent')
const pointId    = getArg('--point')
const subpointId = getArg('--subpoint')
const brickClass = getArg('--class')
const brickNote  = getArg('--note')
const confidence = getArg('--confidence') || 'high'
const batchMode  = hasFlag('--batch')

if (!type) {
  console.error('--type is required: plant | plant-point | zone | zone-point | equipment | floor | room')
  process.exit(1)
}

// ─── File paths ───────────────────────────────────────────────────────────────

const inputDir    = resolve(__dirname, '..', 'data', buildingId, 'inputs')
const dataDir     = resolve(__dirname, '..', 'data', buildingId)
const plantPmPath = resolve(inputDir, 'plant-point-mapping.json')
const zonePmPath  = resolve(inputDir, 'zone-point-mapping.json')
const equipPath   = resolve(inputDir, 'equipment-inventory.json')
const spatialPath = resolve(inputDir, 'spatial-hierarchy.json')

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJson(path: string): any {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function saveJson(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

// classify-all.ts's reviewedManually guard runs BEFORE its binary/Sensor mismatch check
// (tools/lib/tag-match.ts's isBinarySensorMismatch), so a manually-reviewed point is never
// re-checked against it on any future rerun. This is the only remaining place that can ever
// catch a reviewer accidentally reintroducing that mismatch -- warn loudly but still apply the
// write, since a human has already made this call and should see the warning, not have it
// silently overridden.
function checkBinarySensorMismatch(id: string, target: any, cls: string): void {
  const objectType = target?.tsdb?.objectType
  if (isBinarySensorMismatch(objectType, cls)) {
    console.error(`  WARNING: ${id} -> ${cls} looks like a binary/Sensor mismatch (objectType=${objectType}) -- double-check before trusting this`)
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => data += chunk)
    process.stdin.on('end', () => resolve(data))
  })
}

// ─── Plant classification ─────────────────────────────────────────────────────

if (type === 'plant') {
  if (!id || !brickClass) {
    console.error('--type plant requires --id and --class')
    process.exit(1)
  }
  const data = loadJson(plantPmPath)
  const plant = data.plants.find((p: any) => p.plantId === id)
  if (!plant) {
    console.error(`Plant not found: ${id}`)
    process.exit(1)
  }
  plant.brickClass = brickClass
  plant.reviewedManually = true
  if (brickNote) plant.brickNote = brickNote
  saveJson(plantPmPath, data)
  console.log(`+ Plant ${id} -> ${brickClass}${brickNote ? ' (' + brickNote + ')' : ''}`)

// ─── Plant point classification ───────────────────────────────────────────────

} else if (type === 'plant-point') {
  const data = loadJson(plantPmPath)

  if (batchMode) {
    readStdin().then((input) => {
      const assignments: Array<{ plant: string; point: string; bmsPointId?: string; subpoint?: string; class: string; confidence?: string; note?: string }> = JSON.parse(input)
      let count = 0
      for (const a of assignments) {
        const plant = data.plants.find((p: any) => p.plantId === a.plant)
        if (!plant) { console.error(`  Plant not found: ${a.plant}`); continue }
        // Points are flat (no subpoints for most entries) and their pointAbbreviation is only
        // the bare suffix (e.g. "SP", "AL", "ADJ") -- these collide across different base points
        // within the same plant. Disambiguate with bmsPointId when given; otherwise require the
        // abbreviation to be unique so we never silently write to the wrong point.
        const matches = plant.points.filter((pt: any) => pt.pointAbbreviation === a.point)
        let point = a.bmsPointId ? matches.find((pt: any) => pt.bmsPointId === a.bmsPointId) : matches[0]
        if (a.bmsPointId && !point) { console.error(`  Point not found: ${a.plant}_${a.bmsPointId}`); continue }
        if (!a.bmsPointId && matches.length > 1) { console.error(`  Ambiguous point abbreviation "${a.point}" in ${a.plant} (${matches.length} matches: ${matches.map((m: any) => m.bmsPointId).join(', ')}) -- pass bmsPointId to disambiguate, skipping`); continue }
        if (!point) { console.error(`  Point not found: ${a.plant}_${a.point}`); continue }
        if (!a.class) { console.error(`  Missing class, skipping: ${a.plant}_${a.point}${a.subpoint ? '_' + a.subpoint : ''}`); continue }

        if (a.subpoint) {
          const sub = point.subpoints?.find((s: any) => s.suffix === a.subpoint)
          if (!sub) { console.error(`  Subpoint not found: ${a.plant}_${a.point}_${a.subpoint}`); continue }
          checkBinarySensorMismatch(`${a.plant}_${a.point}_${a.subpoint}`, sub, a.class)
          sub.brickClass = a.class
          sub.reviewedManually = true
          if (a.confidence) sub.confidence = a.confidence
        } else {
          checkBinarySensorMismatch(`${a.plant}_${a.point}`, point, a.class)
          point.brickClass = a.class
          point.reviewedManually = true
          if (a.confidence) point.confidence = a.confidence || 'high'
        }
        count++
      }
      saveJson(plantPmPath, data)
      console.log(`+ ${count} plant points classified`)
    })
  } else {
    if (!plantId || !pointId || !brickClass) {
      console.error('--type plant-point requires --plant, --point, and --class')
      process.exit(1)
    }
    const plant = data.plants.find((p: any) => p.plantId === plantId)
    if (!plant) { console.error(`Plant not found: ${plantId}`); process.exit(1) }
    const point = plant.points.find((pt: any) => pt.pointAbbreviation === pointId)
    if (!point) { console.error(`Point not found: ${plantId}_${pointId}`); process.exit(1) }

    if (subpointId) {
      const sub = point.subpoints?.find((s: any) => s.suffix === subpointId)
      if (!sub) { console.error(`Subpoint not found: ${plantId}_${pointId}_${subpointId}`); process.exit(1) }
      checkBinarySensorMismatch(`${plantId}_${pointId}_${subpointId}`, sub, brickClass)
      sub.brickClass = brickClass
      sub.reviewedManually = true
      sub.confidence = confidence
      if (brickNote) sub.brickNote = brickNote
      saveJson(plantPmPath, data)
      console.log(`+ ${plantId}_${pointId}_${subpointId} -> ${brickClass} (${confidence})`)
    } else {
      checkBinarySensorMismatch(`${plantId}_${pointId}`, point, brickClass)
      point.brickClass = brickClass
      point.reviewedManually = true
      point.confidence = confidence
      if (brickNote) point.brickNote = brickNote
      saveJson(plantPmPath, data)
      console.log(`+ ${plantId}_${pointId} -> ${brickClass} (${confidence})`)
    }
  }

// ─── Zone classification ──────────────────────────────────────────────────────

} else if (type === 'zone') {
  if (!id || !brickClass) {
    console.error('--type zone requires --id and --class')
    process.exit(1)
  }
  const data = loadJson(zonePmPath)
  const zone = data.zones.find((z: any) => z.zoneId === id)
  if (!zone) {
    console.error(`Zone not found: ${id}`)
    process.exit(1)
  }
  zone.brickClass = brickClass
  zone.reviewedManually = true
  if (brickNote) zone.brickNote = brickNote
  saveJson(zonePmPath, data)
  console.log(`+ Zone ${id} -> ${brickClass}`)

// ─── Zone point classification ────────────────────────────────────────────────

} else if (type === 'zone-point') {
  const data = loadJson(zonePmPath)

  if (batchMode) {
    readStdin().then((input) => {
      const assignments: Array<{ zone: string; point: string; bmsPointId?: string; subpoint?: string; class: string; confidence?: string }> = JSON.parse(input)
      let count = 0
      for (const a of assignments) {
        const zone = data.zones.find((z: any) => z.zoneId === a.zone)
        if (!zone) { console.error(`  Zone not found: ${a.zone}`); continue }
        // Points are flat (no subpoints for most entries) and their pointAbbreviation is only
        // the bare suffix (e.g. "SP", "AL", "ADJ") -- these collide across different base points
        // within the same zone. Disambiguate with bmsPointId when given; otherwise require the
        // abbreviation to be unique so we never silently write to the wrong point.
        const matches = zone.points.filter((pt: any) => pt.pointAbbreviation === a.point)
        let point = a.bmsPointId ? matches.find((pt: any) => pt.bmsPointId === a.bmsPointId) : matches[0]
        if (a.bmsPointId && !point) { console.error(`  Point not found: ${a.zone}_${a.bmsPointId}`); continue }
        if (!a.bmsPointId && matches.length > 1) { console.error(`  Ambiguous point abbreviation "${a.point}" in ${a.zone} (${matches.length} matches: ${matches.map((m: any) => m.bmsPointId).join(', ')}) -- pass bmsPointId to disambiguate, skipping`); continue }
        if (!point) { console.error(`  Point not found: ${a.zone}_${a.point}`); continue }
        if (!a.class) { console.error(`  Missing class, skipping: ${a.zone}_${a.point}${a.subpoint ? '_' + a.subpoint : ''}`); continue }

        if (a.subpoint) {
          const sub = point.subpoints?.find((s: any) => s.suffix === a.subpoint)
          if (!sub) { console.error(`  Subpoint not found: ${a.zone}_${a.point}_${a.subpoint}`); continue }
          checkBinarySensorMismatch(`${a.zone}_${a.point}_${a.subpoint}`, sub, a.class)
          sub.brickClass = a.class
          sub.reviewedManually = true
          if (a.confidence) sub.confidence = a.confidence
        } else {
          checkBinarySensorMismatch(`${a.zone}_${a.point}`, point, a.class)
          point.brickClass = a.class
          point.reviewedManually = true
          if (a.confidence) point.confidence = a.confidence || 'high'
        }
        count++
      }
      saveJson(zonePmPath, data)
      console.log(`+ ${count} zone points classified`)
    })
  } else {
    if (!zoneId || !pointId || !brickClass) {
      console.error('--type zone-point requires --zone, --point, and --class')
      process.exit(1)
    }
    const zone = data.zones.find((z: any) => z.zoneId === zoneId)
    if (!zone) { console.error(`Zone not found: ${zoneId}`); process.exit(1) }
    const point = zone.points.find((pt: any) => pt.pointAbbreviation === pointId)
    if (!point) { console.error(`Point not found: ${zoneId}_${pointId}`); process.exit(1) }

    if (subpointId) {
      const sub = point.subpoints?.find((s: any) => s.suffix === subpointId)
      if (!sub) { console.error(`Subpoint not found: ${zoneId}_${pointId}_${subpointId}`); process.exit(1) }
      checkBinarySensorMismatch(`${zoneId}_${pointId}_${subpointId}`, sub, brickClass)
      sub.brickClass = brickClass
      sub.reviewedManually = true
      sub.confidence = confidence
      if (brickNote) sub.brickNote = brickNote
      saveJson(zonePmPath, data)
      console.log(`+ ${zoneId}_${pointId}_${subpointId} -> ${brickClass} (${confidence})`)
    } else {
      checkBinarySensorMismatch(`${zoneId}_${pointId}`, point, brickClass)
      point.brickClass = brickClass
      point.reviewedManually = true
      point.confidence = confidence
      if (brickNote) point.brickNote = brickNote
      saveJson(zonePmPath, data)
      console.log(`+ ${zoneId}_${pointId} -> ${brickClass} (${confidence})`)
    }
  }

// ─── Equipment classification ─────────────────────────────────────────────────

} else if (type === 'equipment') {
  const data = loadJson(equipPath)

  if (batchMode) {
    readStdin().then((input) => {
      const assignments: Array<{ parent: string; id: string; class: string; note?: string }> = JSON.parse(input)
      let count = 0
      for (const a of assignments) {
        if (!a.class) { console.error(`  Missing class, skipping: ${a.parent}/${a.id}`); continue }
        // Search both zoneEquipment and plantEquipment
        let found = false
        for (const section of ['zoneEquipment', 'plantEquipment']) {
          const parentKey = section === 'zoneEquipment' ? 'zoneId' : 'plantId'
          const entry = data[section]?.find((e: any) => e[parentKey] === a.parent)
          if (!entry) continue
          const equip = entry.equipment?.find((eq: any) => eq.id === a.id)
          if (!equip) continue
          equip.brickClass = a.class
          equip.reviewedManually = true
          if (a.note) equip.brickNote = a.note
          found = true
          count++
          break
        }
        if (!found) console.error(`  Equipment not found: ${a.parent}/${a.id}`)
      }
      saveJson(equipPath, data)
      console.log(`+ ${count} equipment items classified`)
    })
  } else {
    if (!parentId || !id || !brickClass) {
      console.error('--type equipment requires --parent, --id, and --class')
      process.exit(1)
    }
    let found = false
    for (const section of ['zoneEquipment', 'plantEquipment']) {
      const parentKey = section === 'zoneEquipment' ? 'zoneId' : 'plantId'
      const entry = data[section]?.find((e: any) => e[parentKey] === parentId)
      if (!entry) continue
      const equip = entry.equipment?.find((eq: any) => eq.id === id)
      if (!equip) continue
      equip.brickClass = brickClass
      equip.reviewedManually = true
      if (brickNote) equip.brickNote = brickNote
      found = true
      break
    }
    if (!found) {
      console.error(`Equipment not found: ${parentId}/${id}`)
      process.exit(1)
    }
    saveJson(equipPath, data)
    console.log(`+ Equipment ${parentId}/${id} -> ${brickClass}${brickNote ? ' (' + brickNote + ')' : ''}`)
  }

// ─── Floor classification ─────────────────────────────────────────────────────

} else if (type === 'floor') {
  if (!id || !brickClass) {
    console.error('--type floor requires --id and --class')
    process.exit(1)
  }
  const data = loadJson(spatialPath)
  const floor = data.floors?.find((f: any) => f.id === id)
  if (!floor) {
    console.error(`Floor not found: ${id}`)
    process.exit(1)
  }
  floor.brickClass = brickClass
  floor.reviewedManually = true
  if (brickNote) floor.brickNote = brickNote
  saveJson(spatialPath, data)
  console.log(`+ Floor ${id} -> ${brickClass}`)

// ─── Room classification ──────────────────────────────────────────────────────

} else if (type === 'room') {
  if (!id || !brickClass) {
    console.error('--type room requires --id and --class')
    process.exit(1)
  }
  const data = loadJson(spatialPath)
  const room = data.rooms?.find((r: any) => (r.id || r.number) === id)
  if (!room) {
    console.error(`Room not found: ${id}`)
    process.exit(1)
  }
  room.brickClass = brickClass
  room.reviewedManually = true
  if (brickNote) room.brickNote = brickNote
  saveJson(spatialPath, data)
  console.log(`+ Room ${id} -> ${brickClass}`)

} else {
  console.error(`Unknown --type: ${type}. Valid: plant, plant-point, zone, zone-point, equipment, floor, room`)
  process.exit(1)
}
