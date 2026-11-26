// Cause groups for class changes: every point whose class differs
// between two mappings is grouped by (before -> after | cause), so a human can judge a whole group once.
// The cause is the entry that decided the point's role (partSources.role), or "unknown".

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import type { Flag } from './tag-match'

export type Verdict = 'same' | 'more' | 'less' | 'different' | 'flagged'
export interface ClassChange { id: string; before: string; after: string; reviewed: boolean; cause: string; verdict: Verdict }
export interface ClassGroup { key: string; before: string; after: string; cause: string; points: ClassChange[] }
export interface BeforePoint { cls: string; reviewed: boolean }
export interface AfterPoint { cls: string; partSources: any; flags: Flag[]; reviewed?: boolean }

const bare = (c: string) => c.replace(/^brick:/, '')

// class -> its ancestors (bare names), from the classification index
export function loadParents(idx: any): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const [k, e] of Object.entries<any>(idx.classes)) m.set(bare(k), (e.parents ?? []).map(bare))
  return m
}

function verdictOf(before: string, after: string, flagged: boolean, parents: Map<string, string[]>): Verdict {
  if (before === after) return 'same'
  if (flagged) return 'flagged'
  if (parents.get(after)?.includes(before)) return 'more'
  if (parents.get(before)?.includes(after)) return 'less'
  return 'different'
}

// Points present on both sides whose class differs, grouped by "before → after | cause", largest first.
export function groupChanges(before: Map<string, BeforePoint>, after: Map<string, AfterPoint>, parents: Map<string, string[]>): ClassGroup[] {
  const groups = new Map<string, ClassGroup>()
  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a) continue
    const bc = bare(b.cls), ac = bare(a.cls)
    const verdict = verdictOf(bc, ac, a.flags.length > 0, parents)
    if (verdict === 'same') continue
    const role = a.partSources?.role
    const cause = typeof role === 'string' && role ? role : 'unknown'
    const key = `${bc} → ${ac} | ${cause}`
    let g = groups.get(key)
    if (!g) { g = { key, before: bc, after: ac, cause, points: [] }; groups.set(key, g) }
    g.points.push({ id, before: bc, after: ac, reviewed: b.reviewed, cause, verdict })
  }
  return [...groups.values()].sort((x, y) => y.points.length - x.points.length || x.key.localeCompare(y.key))
}

// The plant/zone mapping files of one inputs dir: each parsed file (to write back) and its live points.
export function loadMappings(inputsDir: string): { files: Array<{ path: string; json: any }>; points: Array<{ id: string; point: any }> } {
  const files: Array<{ path: string; json: any }> = []
  const points: Array<{ id: string; point: any }> = []
  for (const [file, list] of [['plant-point-mapping.json', 'plants'], ['zone-point-mapping.json', 'zones']]) {
    const p = resolve(inputsDir, file)
    if (!existsSync(p)) throw new Error(`Missing ${p}`)
    const json = JSON.parse(readFileSync(p, 'utf-8'))
    files.push({ path: p, json })
    const parents = [...(json[list] ?? []), ...(list === 'plants' ? json.devices ?? [] : [])]
    for (const parent of parents) for (const point of parent.points ?? []) if (point.bmsPointId) points.push({ id: point.bmsPointId, point })
  }
  return { files, points }
}

export function readMappings(inputsDir: string): Array<{ id: string; point: any }> {
  return loadMappings(inputsDir).points
}
