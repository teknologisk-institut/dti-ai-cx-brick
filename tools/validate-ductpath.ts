/**
 * validate-ductpath.ts
 *
 * Automated guardrail for the ductPath assignment done during plant-image
 * extraction. ductPath is decided geometrically (an element's side of the
 * heat-recovery block), but a building whose equipment naming carries an
 * air-direction marker (the profile's naming.airDirectionMarker) gives an
 * INDEPENDENT signal: a supply mark and an extract mark in the equipment id.
 *
 *   supply-marked equipment:
 *     → ductPath must be one of: intake, supply, preheat
 *   extract-marked equipment:
 *     → ductPath must be one of: return, exhaust
 *
 * This flags any equipment whose marker disagrees with its assigned
 * ductPath — i.e. the exact mis-assignment that naive band-cropping risks.
 * Water-circuit ductPaths (water_supply/water_return) and equipment with no
 * marker (heat recovery, etc.) are skipped.
 *
 * Usage:
 *   npx ts-node tools/validate-ductpath.ts <buildingId>
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { loadProfile, compileRegex, dataRoot } from './lib/building-profile'

const buildingId = process.argv[2]
if (!buildingId) { console.error('Usage: npx ts-node tools/validate-ductpath.ts <buildingId>'); process.exit(1) }

let profile
try {
  profile = loadProfile(buildingId)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const markerSpec = profile.naming?.airDirectionMarker
if (!markerSpec) {
  console.log('skipped: profile declares no naming.airDirectionMarker')
  process.exit(0)
}
const markerRe = compileRegex(markerSpec)
const SUPPLY_MARK = markerSpec.supply
const EXTRACT_MARK = markerSpec.extract
// Danish glosses only when the markers are the I/U convention.
const gloss = (m: string) => (m === 'I' ? ' (Indblæsning)' : m === 'U' ? ' (Udsugning)' : '')

const invPath = join(dataRoot(), buildingId, 'inputs', 'equipment-inventory.json')
if (!existsSync(invPath)) {
  console.log(`No equipment-inventory.json for ${buildingId} — nothing to validate (run extraction first).`)
  process.exit(0)
}

const inv = JSON.parse(readFileSync(invPath, 'utf-8'))

const SUPPLY_TRAIN = new Set(['intake', 'supply', 'preheat'])
const EXTRACT_TRAIN = new Set(['return', 'exhaust'])

// Air-direction marker = group 1 of the profile's naming.airDirectionMarker pattern
// (e.g. a marker letter before the trailing digits). Null if no match.
function airMarker(id: string): string | null {
  const m = markerRe.exec(id || '')
  return m ? m[1] : null
}

interface Issue { level: 'error' | 'warning'; msg: string }
const issues: Issue[] = []
let checked = 0
let marked = 0

for (const pe of inv.plantEquipment || []) {
  for (const eq of pe.equipment || []) {
    checked++
    const dp: string = eq.ductPath || ''
    if (dp.startsWith('water_')) continue          // water circuit — air-direction-marker rule doesn't apply
    const marker = airMarker(eq.id)
    if (!marker) continue                           // no marker signal (heat recovery, generic) — skip
    marked++
    if (!dp) {
      issues.push({ level: 'warning', msg: `${pe.plantId}/${eq.id}: ${marker}-marked but no ductPath set` })
      continue
    }
    if (marker === SUPPLY_MARK && !SUPPLY_TRAIN.has(dp)) {
      issues.push({ level: 'error', msg: `${pe.plantId}/${eq.id}: id marker '${SUPPLY_MARK}'${gloss(SUPPLY_MARK)} but ductPath='${dp}' (expected intake|supply|preheat)` })
    } else if (marker === EXTRACT_MARK && !EXTRACT_TRAIN.has(dp)) {
      issues.push({ level: 'error', msg: `${pe.plantId}/${eq.id}: id marker '${EXTRACT_MARK}'${gloss(EXTRACT_MARK)} but ductPath='${dp}' (expected return|exhaust)` })
    }
  }
}

const errors = issues.filter(i => i.level === 'error')
const warnings = issues.filter(i => i.level === 'warning')

console.log(`ductPath↔naming validation for ${buildingId}`)
console.log(`  plant equipment checked: ${checked} | I/U-marked: ${marked}`)
console.log(`  mismatches: ${errors.length} | warnings: ${warnings.length}`)
if (errors.length) { console.log('\nMISMATCHES (review — geometry vs naming disagree):'); for (const e of errors) console.log(`  ${e.msg}`) }
if (warnings.length) { console.log('\nWARNINGS:'); for (const w of warnings) console.log(`  ${w.msg}`) }
if (!errors.length && !warnings.length) console.log('\nAll I/U-marked equipment consistent with ductPath.')

process.exit(errors.length > 0 ? 1 : 0)
