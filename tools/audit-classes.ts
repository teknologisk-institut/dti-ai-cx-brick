// audit-classes.ts
//
// Read-only classification-fidelity audit of the committed classes. Reports:
//
//   B. GENERIC-TAIL (legacy keyword report) — a point with a generic committed class whose
//      description names a stream/medium the class lacks.
//   D. EQUIPMENT MEDIUM AUDIT — plant equipment only (Pump/Storage/Valve/Coil/Exchanger).
//      CORRECTIONS compares the matcher's pick WITH a captured `medium` against its pick
//      WITHOUT one (only meaningful once `medium` is captured, and skipped for
//      reviewedManually items since classify-all never touches their brickClass).
//      CONTRADICTIONS compares a plant equipment item's already-committed brickClass
//      against its plant's own medium context (plantName, then systemType, then the
//      plant's own committed Brick class from plant-point-mapping.json).
//
// (The description-matcher dry run, reports A/LIFTS/C, was removed: its word lists are
// the buildings' cited dictionary entries now, and classify-all combines them per part.)
//
// Usage:
//   npx ts-node tools/audit-classes.ts <building> [building...]   (at least one building id)
//   npx ts-node tools/audit-classes.ts <building> --json
//   npx ts-node tools/audit-classes.ts <building> --generic-only   (report B only)

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { dataRoot } from './lib/building-profile'
import { loadPartsDictionary } from './lib/point-dictionary'
import { getPlantSystem } from './lib/plant-system'
import { loadEquipmentClasses, deriveEquipmentTags, matchEquipmentClass } from './lib/tag-match'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const genericOnly = args.includes('--generic-only')
const ids = args.filter(a => !a.startsWith('--'))
if (ids.length === 0) { console.error('usage: npx ts-node tools/audit-classes.ts <building> [building...] [--json] [--generic-only]'); process.exit(1) }
const buildings = ids

const idx = JSON.parse(readFileSync(resolve(__dirname, '..', 'ontologies', 'brick-classification-index.json'), 'utf-8'))

// Generic/base classes (legacy report B).
const GENERIC = /^(Point|Parameter|Sensor|Status|Command|Setpoint|Temperature_Sensor|Water_Temperature_Sensor|Temperature_Setpoint|Air_Flow_Sensor|Flow_Sensor|Pressure_Sensor|Static_Pressure_Setpoint)$/

type GenHit = { facet: string; cls: string; desc: string; ok: boolean }
type EquipCorrection = { plantId: string; eqId: string; type: string; without: string | null; withMedium: string | null; medium: string }
type EquipContradiction = { plantId: string; plantContext: string; eqId: string; type: string; brickClass: string; impliedMedium: string }

// ── Equipment medium audit (2026-08-20) ──────────────────────────────────────
// Two checks:
//   (a) corrections -- items whose captured `medium` overrides what type/description alone
//       would have produced. Informational only: classify-all already applies this
//       automatically once medium is captured; this is the audit trail, not a to-do list.
//   (b) contradictions -- a plant equipment item with NO medium of its own, whose committed
//       brickClass implies a Hot/Chilled/Domestic qualifier that contradicts the plant's own
//       context (systemType, refined by plantName once captured). These need a human to
//       resolve -- either capture the item's real medium, or fix it directly (assign-brick.ts).

function classImpliesMedium(idx: any, brickClass: string): string | null {
  const e = idx.classes['brick:' + brickClass]
  if (!e || !Array.isArray(e.tags)) return null
  const tags = new Set<string>(e.tags)
  if (tags.has('Domestic')) return 'domestic'
  if (tags.has('Chilled')) return 'chilled'
  if (tags.has('Hot')) return 'hot'
  return null
}

function plantMediumContext(pe: any, sys: string | null): string | null {
  const name = (pe.plantName || '').toLowerCase()
  const hasHeat = /varme|heat/.test(name)
  const hasCool = /køl|chill|kold|cooling/.test(name)
  const hasDom = /brugsvand|dhw|domestic/.test(name)
  if (hasDom && !hasHeat && !hasCool) return 'domestic'
  if (hasHeat && !hasCool) return 'hot'
  if (hasCool && !hasHeat) return 'chilled'
  // plantName absent or ambiguous (e.g. a genuine 4-pipe plant naming both) -- fall back to
  // systemType, the field that's already populated on real data today.
  const sysCtx: Record<string, string> = { heating: 'hot', cooling: 'chilled', chiller: 'chilled', dhw: 'domestic' }
  if (pe.systemType && sysCtx[pe.systemType]) return sysCtx[pe.systemType]
  // Final fallback: the plant's own committed Brick class (plant-point-mapping.json), via the
  // `sys` this function's caller already computed with getPlantSystem() (tools/lib/plant-system.ts).
  // Uses a DIFFERENT value vocabulary than pe.systemType (getPlantSystem returns
  // 'heating'/'chilled'/'dhw'/'ventilation' -- note 'chilled' not 'cooling'), so this needs its
  // own small map, not sysCtx above. This is the tier that can have coverage when plants carry
  // neither plantName nor systemType, since every plant has a committed brickClass.
  const sysMap: Record<string, string> = { heating: 'hot', chilled: 'chilled', dhw: 'domestic' }
  return sysMap[sys || ''] || null
}

function auditEquipment(buildingId: string, idx: any): { corrections: EquipCorrection[]; contradictions: EquipContradiction[] } {
  const equipmentClasses = loadEquipmentClasses(idx)
  const corrections: EquipCorrection[] = []
  const contradictions: EquipContradiction[] = []
  const dir = resolve(dataRoot(), buildingId, 'inputs')
  const invPath = resolve(dir, 'equipment-inventory.json')
  if (!existsSync(invPath)) return { corrections, contradictions }
  const inv = JSON.parse(readFileSync(invPath, 'utf-8'))
  const words = loadPartsDictionary(buildingId).words

  const plantPath = resolve(dir, 'plant-point-mapping.json')
  const plantClassById = new Map<string, string>()
  if (existsSync(plantPath)) {
    const pm = JSON.parse(readFileSync(plantPath, 'utf-8'))
    for (const p of pm.plants || []) if (p.plantId && p.brickClass) plantClassById.set(p.plantId, p.brickClass)
  }

  const HOT_LIKE = new Set(['hot', 'domestic'])
  // Both checks are only meaningful for the anchors `medium` actually covers (the HITL
  // touchpoint 2 scope: Pump/Storage/Valve/Coil/Exchanger). Filtering here isn't just an
  // optimization for the corrections check (medium's override never changes any other anchor's
  // output, so it would never fire there anyway) -- it also prevents the contradictions check
  // from flagging equipment that was never in scope for medium capture at all, which would
  // otherwise depend on no Fan/Damper/Filter/Chiller-anchored Brick class ever carrying a
  // Hot/Chilled/Domestic tag (true today, verified against the live index, but not guaranteed
  // to stay true across future Brick nightly updates).
  const MEDIUM_SCOPE_ANCHORS = new Set(['Pump', 'Storage', 'Valve', 'Coil', 'Exchanger'])

  for (const pe of inv.plantEquipment || []) {
    const sys = getPlantSystem(plantClassById.get(pe.plantId))
    const plantContext = plantMediumContext(pe, sys)
    for (const eq of pe.equipment || []) {
      const t = eq.type || ''
      const desc = eq.description || ''
      const noMedium = deriveEquipmentTags(t, desc, sys, null, words)
      const anchor = noMedium.anchor
      if (!anchor || !MEDIUM_SCOPE_ANCHORS.has(anchor)) continue

      if (eq.medium && !eq.reviewedManually) {
        const without = matchEquipmentClass(noMedium.tags, noMedium.anchor, equipmentClasses)
        const d2 = deriveEquipmentTags(t, desc, sys, eq.medium, words)
        const withMedium = matchEquipmentClass(d2.tags, d2.anchor, equipmentClasses)
        if (without !== withMedium) {
          corrections.push({ plantId: pe.plantId, eqId: eq.id, type: t, without, withMedium, medium: eq.medium })
        }
      }

      // Contradiction axis is deliberately hot-vs-chilled only (matching the real misclassifications
      // that motivated this design). A domestic-context plant with
      // chilled-tagged equipment (or similar domestic-axis mismatches) is not checked here --
      // out of scope for this pass, not an oversight.
      if (!eq.medium && eq.brickClass && plantContext) {
        const implied = classImpliesMedium(idx, eq.brickClass)
        if (implied && ((implied === 'chilled' && plantContext === 'hot') || (HOT_LIKE.has(implied) && plantContext === 'chilled'))) {
          contradictions.push({ plantId: pe.plantId, plantContext, eqId: eq.id, type: t, brickClass: eq.brickClass, impliedMedium: implied })
        }
      }
    }
  }
  return { corrections, contradictions }
}

// ── legacy generic-tail keyword report (unchanged) ──
const GFACETS: Array<{ name: string; signal: RegExp; want: RegExp }> = [
  { name: 'supply-air',  signal: /indbl|tilluft|indblæs/i,                 want: /Supply|Discharge/ },
  { name: 'return-air',  signal: /udsug|fraluft/i,                         want: /Return|Exhaust/ },
  { name: 'exhaust-air', signal: /afkast/i,                                want: /Exhaust/ },
  { name: 'outside-air', signal: /indtag|udeluft|udetemp|friskluft|\bude\b/i, want: /Outside|Intake/ },
  { name: 'deadband',    signal: /dødbånd/i,                               want: /Deadband/ },
  { name: 'water',       signal: /fremløb|returløb|brugsvand|fjernvarme|\bvand\b/i, want: /Hot|Chilled|Domestic|Entering|Leaving|Thermal|Meter|Tank/ },
]
const KNOWN_OK = /kurvepun|p-bånd|i-tid|d-tid/i

function analyzePoint(p: any, acc: { gen: GenHit[]; total: number }): void {
  if (typeof p.bmsPointId !== 'string' || typeof p.brickClass !== 'string') return
  acc.total++
  const committed = p.brickClass
  const desc = p.danishDescription || ''

  // legacy report B
  if (GENERIC.test(committed)) {
    for (const f of GFACETS) {
      if (f.signal.test(desc) && !f.want.test(committed)) { acc.gen.push({ facet: f.name, cls: committed, desc, ok: KNOWN_OK.test(desc) }); break }
    }
  }
}

function audit(buildingId: string) {
  const dir = resolve(dataRoot(), buildingId, 'inputs')
  const acc = { gen: [] as GenHit[], total: 0 }

  const plantPath = resolve(dir, 'plant-point-mapping.json')
  if (existsSync(plantPath)) {
    const pm = JSON.parse(readFileSync(plantPath, 'utf-8'))
    for (const plant of pm.plants || []) {
      const visit = (n: any) => {
        if (Array.isArray(n)) return n.forEach(visit)
        if (n && typeof n === 'object') { if (typeof n.bmsPointId === 'string') analyzePoint(n, acc); for (const k of Object.keys(n)) if (k !== 'plants') visit(n[k]) }
      }
      for (const pt of plant.points || []) visit(pt)
    }
  }
  const zonePath = resolve(dir, 'zone-point-mapping.json')
  if (existsSync(zonePath)) {
    const zm = JSON.parse(readFileSync(zonePath, 'utf-8'))
    const visit = (n: any) => {
      if (Array.isArray(n)) return n.forEach(visit)
      if (n && typeof n === 'object') { if (typeof n.bmsPointId === 'string') analyzePoint(n, acc); for (const k of Object.keys(n)) visit(n[k]) }
    }
    for (const zone of zm.zones || []) for (const pt of zone.points || []) visit(pt)
  }
  return acc
}

const result: Record<string, ReturnType<typeof audit>> = {}
try {
  for (const b of buildings) result[b] = audit(b)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const equipResult: Record<string, ReturnType<typeof auditEquipment>> = {}
try {
  for (const b of buildings) equipResult[b] = auditEquipment(b, idx)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

if (asJson) {
  const out: any = {}
  for (const b of buildings) {
    const r = result[b]
    const eqR = equipResult[b]
    out[b] = { totalPoints: r.total, genericTail: r.gen.length, genericTailList: r.gen,
      equipmentCorrections: eqR.corrections.length, equipmentContradictions: eqR.contradictions.length, equipmentCorrectionList: eqR.corrections, equipmentContradictionList: eqR.contradictions }
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

for (const b of buildings) {
  const r = result[b]
  if (!genericOnly) {
    const eqR = equipResult[b]
    console.log(`\n${'─'.repeat(82)}`)
    console.log(`D. ${b} — EQUIPMENT MEDIUM AUDIT (${eqR.corrections.length} corrections, ${eqR.contradictions.length} contradictions)`)
    console.log('─'.repeat(82))
    if (eqR.corrections.length) {
      console.log(`  [corrections] (captured medium changed the matcher's pick -- already applied by classify-all)`)
      for (const c of eqR.corrections) console.log(`    ${c.plantId}/${c.eqId}  ${c.without ?? '(none)'} → ${c.withMedium ?? '(none)'}  (medium: ${c.medium})`)
    }
    if (eqR.contradictions.length) {
      console.log(`  [contradictions] (no medium captured yet -- committed class disagrees with plant context; needs a human)`)
      for (const x of eqR.contradictions) console.log(`    ${x.plantId}/${x.eqId}  ${x.brickClass} implies ${x.impliedMedium}, plant context is ${x.plantContext}`)
    }
    if (!eqR.corrections.length && !eqR.contradictions.length) console.log('  (none)')
  }

  // legacy report B
  const gactionable = r.gen.filter(h => !h.ok).length
  console.log(`\n${'─'.repeat(82)}`)
  console.log(`B. ${b} — GENERIC-TAIL keyword report (${r.gen.length}: ${gactionable} actionable, ${r.gen.length - gactionable} likely config)`)
  console.log('─'.repeat(82))
  if (!r.gen.length) { console.log('  (none)'); continue }
  const byFacet: Record<string, Record<string, { n: number; ok: boolean }>> = {}
  for (const h of r.gen) {
    byFacet[h.facet] = byFacet[h.facet] || {}
    const k = `${h.cls.padEnd(24)} "${h.desc}"`
    byFacet[h.facet][k] = { n: (byFacet[h.facet][k]?.n || 0) + 1, ok: h.ok }
  }
  for (const facet of GFACETS.map(f => f.name)) {
    if (!byFacet[facet]) continue
    console.log(`  [${facet}]`)
    for (const [k, v] of Object.entries(byFacet[facet]).sort((a, z) => z[1].n - a[1].n)) console.log(`    ${String(v.n).padStart(4)}  ${v.ok ? '(config?) ' : '          '}${k}`)
  }
}
