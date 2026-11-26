// tools/compare-classes-by-cause.ts
//
// Compares every point's class between two inputs dirs (--before, --after) and groups the changes by
// cause (the entry that decided the point's role), so each group can be judged once (a no-worse
// test). A reviewed point's before class is its reviewed class.
// Prints counts per verdict and flag counts per kind for both sides. With --out <file.md> it writes the
// groups (largest first, every point id) and, beside it, <same basename>.json for apply-class-verdicts.
// Read-only on the mapping files.
//
//   npx ts-node tools/compare-classes-by-cause.ts <buildingId> --before <inputsDir> --after <inputsDir> [--out <file.md>]

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname, join, parse } from 'path'
import { loadParents, groupChanges, readMappings } from './lib/class-groups'
import type { BeforePoint, AfterPoint } from './lib/class-groups'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const buildingId = process.argv[2]
  const beforeDir = arg('--before'), afterDir = arg('--after'), out = arg('--out')
  if (!buildingId || buildingId.startsWith('--') || !beforeDir || !afterDir) {
    throw new Error('Usage: npx ts-node tools/compare-classes-by-cause.ts <buildingId> --before <inputsDir> --after <inputsDir> [--out <file.md>]')
  }
  const parents = loadParents(JSON.parse(readFileSync(resolve(__dirname, '..', 'ontologies', 'brick-classification-index.json'), 'utf-8')))

  const before = new Map<string, BeforePoint>()
  const afterMap = new Map<string, AfterPoint>()
  const flagCount = { before: new Map<string, number>(), after: new Map<string, number>() }
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
  for (const { id, point } of readMappings(beforeDir)) {
    before.set(id, { cls: point.brickClass ?? '', reviewed: point.reviewedManually === true })
    for (const f of point.classFlags ?? []) bump(flagCount.before, f.kind)
  }
  for (const { id, point } of readMappings(afterDir)) {
    afterMap.set(id, { cls: point.brickClass ?? '', partSources: point.partSources, flags: point.classFlags ?? [] })
    for (const f of point.classFlags ?? []) bump(flagCount.after, f.kind)
  }

  const groups = groupChanges(before, afterMap, parents)
  const onlyBefore = [...before.keys()].filter(id => !afterMap.has(id))
  const onlyAfter = [...afterMap.keys()].filter(id => !before.has(id))

  const verdicts: Record<string, number> = { more: 0, less: 0, different: 0, flagged: 0 }
  for (const g of groups) for (const p of g.points) verdicts[p.verdict]++
  const compared = [...before.keys()].filter(id => afterMap.has(id)).length
  const lines: string[] = [
    `${buildingId}: ${compared} points compared, ${groups.reduce((n, g) => n + g.points.length, 0)} changed in ${groups.length} groups`,
    `verdicts: ${Object.entries(verdicts).map(([k, v]) => `${k}: ${v}`).join('  ')}`,
  ]
  for (const side of ['before', 'after'] as const) {
    const m = flagCount[side]
    lines.push(`flags (${side}): ` + ([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join('  ') || '0'))
  }
  lines.push(`only in before: ${onlyBefore.length}   only in after: ${onlyAfter.length}`)
  console.log(lines.join('\n'))

  if (!out) return
  const md: string[] = [`# Class changes by cause — ${buildingId}`, '', ...lines.map(l => `- ${l}`), '']
  for (const g of groups) {
    md.push(`## ${g.key}`, '', `${g.points.length} points; verdict ${[...new Set(g.points.map(p => p.verdict))].join('/')}; reviewed ${g.points.filter(p => p.reviewed).length}`, '')
    md.push(g.points.map(p => p.id).join(', '), '')
  }
  md.push(`## Only in before (${onlyBefore.length})`, '', onlyBefore.join(', '), '')
  md.push(`## Only in after (${onlyAfter.length})`, '', onlyAfter.join(', '), '')
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, md.join('\n'), 'utf-8')
  const p = parse(resolve(out))
  writeFileSync(join(p.dir, p.name + '.json'), JSON.stringify({ building: buildingId, groups, onlyBefore, onlyAfter }, null, 2), 'utf-8')
}

try { main() } catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
