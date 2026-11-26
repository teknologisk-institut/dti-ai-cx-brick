// tools/group-low-confidence.ts
//
// Groups the points to review (needsReview, confidence:'low', or a trade-off flag) by (flag kinds, decided parts) for
// HITL touchpoint 3 review (see brick-assign/SKILL.md, "Touchpoint 3: low-confidence review"). The
// decided parts are the point's partSources (part -> "<level>:<entry>" that decided it); each sample
// shows its class, tags, partSources and classFlags.
// Read-only -- never writes to source data. Regenerate fresh every review session; the
// population shrinks as review lands (confirmed groups get promoted to confidence:high via
// assign-brick.ts) and grows as new data is added.
//
//   npx ts-node tools/group-low-confidence.ts <buildingId>
//
// For deeper physical-context checks beyond what's shown here (ductPath, water-context), cross-
// reference the sample point IDs against equipment-inventory.json / building-connections.json --
// see brick-assign/SKILL.md's "Data sources for classification decisions" table.

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { dataRoot } from './lib/building-profile'

const buildingId = process.argv[2]
if (!buildingId) {
  console.error('Usage: npx ts-node tools/group-low-confidence.ts <buildingId>')
  process.exit(1)
}

let plantPm: any, zonePm: any
try {
  const inputDir = resolve(dataRoot(), buildingId, 'inputs')
  plantPm = JSON.parse(readFileSync(resolve(inputDir, 'plant-point-mapping.json'), 'utf-8'))
  zonePm = JSON.parse(readFileSync(resolve(inputDir, 'zone-point-mapping.json'), 'utf-8'))
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

type Sample = { id: string; parent: string; brickClass: string; tags: string[]; sources: string; flags: string; desc: string }
type Group = { flagKinds: string; parts: string; count: number; samples: Sample[] }

const groups = new Map<string, Group>()
let totalReview = 0

// "part=<level>:<entry>" per decided part, by part name
function partsOf(partSources: unknown): string {
  const ps = partSources && typeof partSources === 'object' ? Object.entries(partSources as Record<string, string>) : []
  return ps.length ? ps.sort(([a], [b]) => a.localeCompare(b)).map(([p, s]) => `${p}=${s}`).join(' ') : '(no parts)'
}

function addPoint(point: any, parent: string) {
  const tradeOff = Array.isArray(point.classFlags) && point.classFlags.some((f: any) => f.kind === 'trade-off')
  if (point.needsReview !== true && point.confidence !== 'low' && !tradeOff) return
  totalReview++
  const flags: Array<{ kind: string; detail: string }> = Array.isArray(point.classFlags) ? point.classFlags : []
  const flagKinds = [...new Set(flags.map(f => f.kind))].sort().join(',') || '(no flags)'
  const parts = partsOf(point.partSources)
  const key = `${flagKinds} | ${parts}`
  let g = groups.get(key)
  if (!g) { g = { flagKinds, parts, count: 0, samples: [] }; groups.set(key, g) }
  g.count++
  if (g.samples.length < 5) {
    g.samples.push({
      id: point.bmsPointId || point.pointAbbreviation || '(no id)',
      parent,
      brickClass: point.brickClass || '(none)',
      tags: Array.isArray(point.tags) ? [...point.tags].sort() : [],
      sources: parts,
      flags: flags.map(f => `${f.kind}: ${f.detail}`).join('; '),
      desc: point.danishDescription || point.semanticMeaning || '',
    })
  }
}

for (const plant of plantPm.plants || []) {
  for (const point of plant.points || []) addPoint(point, plant.plantId)
}
for (const device of plantPm.devices || []) {
  for (const point of device.points || []) addPoint(point, device.deviceName)
}
for (const zone of zonePm.zones || []) {
  for (const point of zone.points || []) addPoint(point, zone.zoneId)
}

const sorted = [...groups.values()].sort((a, b) => b.count - a.count)

// Internal-consistency self-check: every point to review must land in exactly one group.
const groupedTotal = sorted.reduce((sum, g) => sum + g.count, 0)
if (groupedTotal !== totalReview) {
  console.error(`INCONSISTENCY: grouped ${groupedTotal} points but found ${totalReview} points to review -- a point was dropped or double-counted. Do not trust this report; fix the tool before using it for review.`)
  process.exit(1)
}

console.log(`${buildingId}: ${totalReview} points to review in ${sorted.length} groups (flag kinds, decided parts)\n`)
for (const g of sorted) {
  console.log(`${g.count}\t${g.flagKinds} | ${g.parts}`)
  for (const s of g.samples) {
    console.log(`\t  [${s.parent}] ${s.id}  ${s.brickClass}  tags=[${s.tags.join(',')}]  sources={${s.sources}}  flags=[${s.flags}]  desc="${s.desc}"`)
  }
}
