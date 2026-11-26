// tools/apply-class-verdicts.ts
//
// Applies the human's verdicts on cause groups (from compare-classes-by-cause.ts) to the CURRENT mapping
// files of <buildingId>: a reviewed point in a "better" group takes the group's new class and a reviewNote
// "cause group <key> approved <date>" (appended with "; " to an existing reviewNote; brickNote untouched).
// Every other reviewed point keeps its class. A point already at the new class counts as already-applied.
//
//   npx ts-node tools/apply-class-verdicts.ts <buildingId> --groups <groups.json> --verdicts <verdicts.json>
//   verdicts.json: { "<group key>": "better" | "worse" }

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { dataRoot } from './lib/building-profile'
import { loadMappings } from './lib/class-groups'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const buildingId = process.argv[2]
  const groupsPath = arg('--groups'), verdictsPath = arg('--verdicts')
  if (!buildingId || buildingId.startsWith('--') || !groupsPath || !verdictsPath) {
    throw new Error('Usage: npx ts-node tools/apply-class-verdicts.ts <buildingId> --groups <file.json> --verdicts <file.json>')
  }
  const groups: Array<{ key: string; after: string; points: Array<{ id: string }> }> = JSON.parse(readFileSync(groupsPath, 'utf-8')).groups
  const verdicts: Record<string, string> = JSON.parse(readFileSync(verdictsPath, 'utf-8'))
  const byKey = new Map(groups.map(g => [g.key, g]))
  const notFound = Object.keys(verdicts).filter(k => !byKey.has(k))

  // point id -> the better group it belongs to
  const approved = new Map<string, { key: string; after: string }>()
  for (const [key, v] of Object.entries(verdicts)) {
    const g = byKey.get(key)
    if (g && v === 'better') for (const p of g.points) approved.set(p.id, { key, after: g.after })
  }

  const inputsDir = resolve(dataRoot(), buildingId, 'inputs')
  const date = new Date().toISOString().slice(0, 10)
  let applied = 0, alreadyApplied = 0, kept = 0
  const { files, points } = loadMappings(inputsDir)
  for (const { id, point } of points) {
    if (point.reviewedManually !== true) continue
    const a = approved.get(id)
    if (!a) { kept++; continue }
    if (point.brickClass === a.after) { alreadyApplied++; continue }
    point.brickClass = a.after
    const note = `cause group ${a.key} approved ${date}`
    point.reviewNote = point.reviewNote ? `${point.reviewNote}; ${note}` : note
    applied++
  }
  for (const f of files) writeFileSync(f.path, JSON.stringify(f.json, null, 2), 'utf-8')
  console.log(`${buildingId}: applied: ${applied}  kept: ${kept}  already-applied: ${alreadyApplied}  verdict keys not found: ${notFound.length}`)
  for (const k of notFound) console.log(`  not found: ${k}`)
}

try { main() } catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
