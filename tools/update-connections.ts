/**
 * update-connections.ts
 *
 * Manages building-connections.json — the inter-system topology file.
 * Captures plant-feeds-zone, plant-serves-plant, and plant-hierarchy
 * relationships extracted from BMS schematic images.
 *
 * This is a focused file independent of building_model.json.
 * The TTL generator joins it with spatial-hierarchy.json, brick-assignments.json,
 * and the point mapping files.
 *
 * Usage:
 *   # Add plant-feeds-zone connections
 *   echo '<json>' | npx ts-node tools/update-connections.ts <buildingId> --type feeds
 *
 *   # Add plant-serves-plant connections
 *   echo '<json>' | npx ts-node tools/update-connections.ts <buildingId> --type serves
 *
 *   # Add plant-hierarchy (parent-child) connections
 *   echo '<json>' | npx ts-node tools/update-connections.ts <buildingId> --type hierarchy
 *
 *   # Validate all connections against spatial-hierarchy.json and brick-assignments.json
 *   npx ts-node tools/update-connections.ts <buildingId> --validate
 *
 *   # Show summary
 *   npx ts-node tools/update-connections.ts <buildingId> --summary
 *
 * Input JSON formats:
 *
 *   --type feeds:
 *   {
 *     "plantId": "VE01",
 *     "zoneIds": ["Z_101", "Z_102"],
 *     "sourceImage": "plants/VE01.png",
 *     "confidence": "high"
 *   }
 *
 *   --type serves:
 *   {
 *     "plantId": "KO01",
 *     "servesPlantIds": ["VE01"],
 *     "sourceImage": "plants_overview/cooling.png",
 *     "confidence": "high"
 *   }
 *
 *   --type hierarchy:
 *   {
 *     "plantId": "BSP01",
 *     "parentPlantId": "VE01",
 *     "sourceImage": "plants/VE01.png",
 *     "confidence": "high"
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// ─── Types ──────────────────────────────────────────────────────────────────

interface FeedsConnection {
  plantId: string
  zoneIds: string[]
  sourceImage: string
  confidence: 'high' | 'medium' | 'low'
  extractedAt: string
}

interface ServesConnection {
  plantId: string
  servesPlantIds: string[]
  sourceImage: string
  confidence: 'high' | 'medium' | 'low'
  extractedAt: string
}

interface HierarchyConnection {
  plantId: string
  parentPlantId: string
  sourceImage: string
  confidence: 'high' | 'medium' | 'low'
  extractedAt: string
}

interface BuildingConnections {
  meta: {
    buildingId: string
    lastUpdated: string
    totalFeeds: number
    totalServes: number
    totalHierarchy: number
  }
  plantFeedsZone: FeedsConnection[]
  plantServesPlant: ServesConnection[]
  plantHierarchy: HierarchyConnection[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function loadOrCreate(path: string, buildingId: string): BuildingConnections {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'))
  }
  return {
    meta: {
      buildingId,
      lastUpdated: new Date().toISOString(),
      totalFeeds: 0,
      totalServes: 0,
      totalHierarchy: 0,
    },
    plantFeedsZone: [],
    plantServesPlant: [],
    plantHierarchy: [],
  }
}

function updateMeta(conn: BuildingConnections): void {
  conn.meta.lastUpdated = new Date().toISOString()
  conn.meta.totalFeeds = conn.plantFeedsZone.length
  conn.meta.totalServes = conn.plantServesPlant.length
  conn.meta.totalHierarchy = conn.plantHierarchy.length
}

function save(path: string, conn: BuildingConnections): void {
  updateMeta(conn)
  writeFileSync(path, JSON.stringify(conn, null, 2), 'utf-8')
}

// ─── Commands ───────────────────────────────────────────────────────────────

function addFeeds(conn: BuildingConnections, data: any): void {
  const { plantId, zoneIds, sourceImage, confidence } = data
  if (!plantId || !Array.isArray(zoneIds)) {
    console.error('feeds requires: plantId, zoneIds[]')
    process.exit(1)
  }

  // Upsert: if same plantId exists, merge zoneIds
  const existing = conn.plantFeedsZone.find(f => f.plantId === plantId)
  if (existing) {
    const merged = new Set([...existing.zoneIds, ...zoneIds])
    existing.zoneIds = [...merged].sort()
    existing.sourceImage = sourceImage || existing.sourceImage
    existing.confidence = confidence || existing.confidence
    existing.extractedAt = new Date().toISOString()
    console.log(`Updated feeds: ${plantId} -> ${existing.zoneIds.length} zones`)
  } else {
    conn.plantFeedsZone.push({
      plantId,
      zoneIds: [...new Set(zoneIds)].sort(),
      sourceImage: sourceImage || '',
      confidence: confidence || 'high',
      extractedAt: new Date().toISOString(),
    })
    console.log(`Added feeds: ${plantId} -> ${zoneIds.length} zones`)
  }
}

function addServes(conn: BuildingConnections, data: any): void {
  const { plantId, servesPlantIds, sourceImage, confidence } = data
  if (!plantId || !Array.isArray(servesPlantIds)) {
    console.error('serves requires: plantId, servesPlantIds[]')
    process.exit(1)
  }

  const existing = conn.plantServesPlant.find(s => s.plantId === plantId)
  if (existing) {
    const merged = new Set([...existing.servesPlantIds, ...servesPlantIds])
    existing.servesPlantIds = [...merged].sort()
    existing.sourceImage = sourceImage || existing.sourceImage
    existing.confidence = confidence || existing.confidence
    existing.extractedAt = new Date().toISOString()
    console.log(`Updated serves: ${plantId} -> ${existing.servesPlantIds.length} plants`)
  } else {
    conn.plantServesPlant.push({
      plantId,
      servesPlantIds: [...new Set(servesPlantIds)].sort(),
      sourceImage: sourceImage || '',
      confidence: confidence || 'high',
      extractedAt: new Date().toISOString(),
    })
    console.log(`Added serves: ${plantId} -> ${servesPlantIds.length} plants`)
  }
}

function addHierarchy(conn: BuildingConnections, data: any): void {
  const { plantId, parentPlantId, sourceImage, confidence } = data
  if (!plantId || !parentPlantId) {
    console.error('hierarchy requires: plantId, parentPlantId')
    process.exit(1)
  }

  const existing = conn.plantHierarchy.find(h => h.plantId === plantId)
  if (existing) {
    existing.parentPlantId = parentPlantId
    existing.sourceImage = sourceImage || existing.sourceImage
    existing.confidence = confidence || existing.confidence
    existing.extractedAt = new Date().toISOString()
    console.log(`Updated hierarchy: ${plantId} -> parent ${parentPlantId}`)
  } else {
    conn.plantHierarchy.push({
      plantId,
      parentPlantId,
      sourceImage: sourceImage || '',
      confidence: confidence || 'high',
      extractedAt: new Date().toISOString(),
    })
    console.log(`Added hierarchy: ${plantId} -> parent ${parentPlantId}`)
  }
}

// ─── Validate ───────────────────────────────────────────────────────────────

function validate(dataDir: string, conn: BuildingConnections): void {
  const issues: string[] = []

  // Load spatial hierarchy for zone validation
  const spatialPath = resolve(inputDir, 'spatial-hierarchy.json')
  let knownZoneIds: Set<string> = new Set()
  if (existsSync(spatialPath)) {
    const spatial = JSON.parse(readFileSync(spatialPath, 'utf-8'))
    knownZoneIds = new Set((Array.isArray(spatial.zones) ? spatial.zones : []).map((z: any) => z.id))
  } else {
    issues.push('WARN: spatial-hierarchy.json not found, cannot validate zone IDs')
  }

  // Load brick assignments for plant validation
  const assignPath = resolve(dataDir, 'brick-assignments.json')
  let knownPlantIds: Set<string> = new Set()
  if (existsSync(assignPath)) {
    const assignments = JSON.parse(readFileSync(assignPath, 'utf-8'))
    knownPlantIds = new Set(Object.keys(assignments.plants || {}))
  } else {
    issues.push('WARN: brick-assignments.json not found, cannot validate plant IDs')
  }

  // Validate feeds
  for (const f of conn.plantFeedsZone) {
    if (knownPlantIds.size > 0 && !knownPlantIds.has(f.plantId)) {
      issues.push(`FEEDS: unknown plant "${f.plantId}"`)
    }
    for (const zid of f.zoneIds) {
      if (knownZoneIds.size > 0 && !knownZoneIds.has(zid)) {
        issues.push(`FEEDS: ${f.plantId} references unknown zone "${zid}"`)
      }
    }
  }

  // Reverse-coverage check: every real zone should be fed by at least one plant.
  // Catches silent extraction misses (a zone never written to any feeds entry) that the
  // forward check above can't see, since it only validates zone IDs that WERE written.
  if (knownZoneIds.size > 0) {
    const coveredZoneIds = new Set(conn.plantFeedsZone.flatMap(f => f.zoneIds))
    for (const zid of [...knownZoneIds].sort()) {
      if (!coveredZoneIds.has(zid)) {
        issues.push(`FEEDS: zone "${zid}" has no feeding plant (not covered by any plantFeedsZone entry)`)
      }
    }
  }

  // Validate serves
  const allPlantIdsInConnections = new Set([
    ...conn.plantFeedsZone.map(f => f.plantId),
    ...conn.plantServesPlant.map(s => s.plantId),
    ...conn.plantServesPlant.flatMap(s => s.servesPlantIds),
    ...conn.plantHierarchy.map(h => h.plantId),
    ...conn.plantHierarchy.map(h => h.parentPlantId),
  ])

  for (const s of conn.plantServesPlant) {
    if (knownPlantIds.size > 0 && !knownPlantIds.has(s.plantId)) {
      issues.push(`SERVES: unknown plant "${s.plantId}"`)
    }
    for (const pid of s.servesPlantIds) {
      if (knownPlantIds.size > 0 && !knownPlantIds.has(pid)) {
        issues.push(`SERVES: ${s.plantId} references unknown plant "${pid}"`)
      }
    }
    // Check for self-reference
    if (s.servesPlantIds.includes(s.plantId)) {
      issues.push(`SERVES: ${s.plantId} references itself`)
    }
  }

  // Validate hierarchy
  for (const h of conn.plantHierarchy) {
    if (knownPlantIds.size > 0 && !knownPlantIds.has(h.plantId)) {
      issues.push(`HIERARCHY: unknown plant "${h.plantId}"`)
    }
    if (knownPlantIds.size > 0 && !knownPlantIds.has(h.parentPlantId)) {
      issues.push(`HIERARCHY: ${h.plantId} references unknown parent "${h.parentPlantId}"`)
    }
    if (h.plantId === h.parentPlantId) {
      issues.push(`HIERARCHY: ${h.plantId} is its own parent`)
    }
  }

  // Check for circular hierarchy
  const parentMap = new Map(conn.plantHierarchy.map(h => [h.plantId, h.parentPlantId]))
  for (const [child] of parentMap) {
    const visited = new Set<string>()
    let current: string | undefined = child
    while (current && !visited.has(current)) {
      visited.add(current)
      current = parentMap.get(current)
    }
    if (current && visited.has(current)) {
      issues.push(`HIERARCHY: circular reference detected involving "${current}"`)
    }
  }

  // Check for low-confidence entries
  const lowConf = [
    ...conn.plantFeedsZone.filter(f => f.confidence === 'low'),
    ...conn.plantServesPlant.filter(s => s.confidence === 'low'),
    ...conn.plantHierarchy.filter(h => h.confidence === 'low'),
  ]
  if (lowConf.length > 0) {
    issues.push(`INFO: ${lowConf.length} low-confidence connections need review`)
  }

  // Report
  if (issues.length === 0) {
    console.log('Validation passed: all connections are consistent')
  } else {
    console.log(`Validation found ${issues.length} issue(s):`)
    for (const issue of issues) {
      console.log(`  - ${issue}`)
    }
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

function showSummary(conn: BuildingConnections): void {
  console.log(`Building Connections: ${conn.meta.buildingId}`)
  console.log(`  Last updated: ${conn.meta.lastUpdated}`)
  console.log(`  Plant-feeds-zone:    ${conn.plantFeedsZone.length} entries`)
  console.log(`  Plant-serves-plant:  ${conn.plantServesPlant.length} entries`)
  console.log(`  Plant hierarchy:     ${conn.plantHierarchy.length} entries`)

  const totalZonesServed = new Set(conn.plantFeedsZone.flatMap(f => f.zoneIds)).size
  const totalPlantsInvolved = new Set([
    ...conn.plantFeedsZone.map(f => f.plantId),
    ...conn.plantServesPlant.map(s => s.plantId),
    ...conn.plantServesPlant.flatMap(s => s.servesPlantIds),
    ...conn.plantHierarchy.map(h => h.plantId),
    ...conn.plantHierarchy.map(h => h.parentPlantId),
  ]).size
  console.log(`  Unique zones served: ${totalZonesServed}`)
  console.log(`  Unique plants involved: ${totalPlantsInvolved}`)

  // Confidence breakdown
  const allEntries = [
    ...conn.plantFeedsZone,
    ...conn.plantServesPlant,
    ...conn.plantHierarchy,
  ]
  const confCounts = { high: 0, medium: 0, low: 0 }
  for (const e of allEntries) {
    confCounts[e.confidence] = (confCounts[e.confidence] || 0) + 1
  }
  console.log(`  Confidence: ${confCounts.high} high, ${confCounts.medium} medium, ${confCounts.low} low`)

  // Source images
  const images = new Set(allEntries.map(e => e.sourceImage).filter(Boolean))
  console.log(`  Source images: ${images.size}`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const buildingId = args[0]

if (!buildingId) {
  console.error('Usage: npx ts-node tools/update-connections.ts <buildingId> --type <feeds|serves|hierarchy> | --validate | --summary')
  process.exit(1)
}

const dataDir = resolve(__dirname, '..', 'data', buildingId)
const inputDir = resolve(dataDir, 'inputs')
const connPath = resolve(inputDir, 'building-connections.json')
const conn = loadOrCreate(connPath, buildingId)

if (hasFlag(args, '--validate')) {
  validate(dataDir, conn)
} else if (hasFlag(args, '--summary')) {
  showSummary(conn)
} else {
  const type = getArg(args, '--type')
  if (!type) {
    console.error('Specify --type feeds|serves|hierarchy, or --validate, or --summary')
    process.exit(1)
  }

  // Read data from stdin
  const stdinData = readFileSync(0, 'utf-8').trim()
  const data = JSON.parse(stdinData)

  switch (type) {
    case 'feeds':
      addFeeds(conn, data)
      break
    case 'serves':
      addServes(conn, data)
      break
    case 'hierarchy':
      addHierarchy(conn, data)
      break
    default:
      console.error(`Unknown type: ${type}. Use feeds, serves, or hierarchy.`)
      process.exit(1)
  }

  save(connPath, conn)
}
