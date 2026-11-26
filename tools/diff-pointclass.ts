// diff-pointclass.ts — READ-ONLY: compare brickClass per bmsPointId between two
// point-mapping JSONs (nested or flat). Reports class changes + dropped/added points.
//   npx ts-node tools/diff-pointclass.ts <fileA> <fileB>
import { readFileSync } from 'fs'
const [a, b] = process.argv.slice(2)
function collect(p: string): Record<string, string> {
  const m: Record<string, string> = {}
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === 'object') {
      if (typeof n.bmsPointId === 'string' && typeof n.brickClass === 'string') m[n.bmsPointId] = n.brickClass
      for (const k of Object.keys(n)) walk(n[k])
    }
  }
  walk(JSON.parse(readFileSync(p, 'utf-8')))
  return m
}
const ma = collect(a), mb = collect(b)
const ids = new Set([...Object.keys(ma), ...Object.keys(mb)])
const changes: Record<string, number> = {}; const onlyA: string[] = []; const onlyB: string[] = []
for (const id of ids) {
  if (!(id in ma)) onlyB.push(id)
  else if (!(id in mb)) onlyA.push(id)
  else if (ma[id] !== mb[id]) { const k = `${ma[id]} -> ${mb[id]}`; changes[k] = (changes[k] || 0) + 1 }
}
const changed = Object.values(changes).reduce((s, n) => s + n, 0)
console.log(`A=${Object.keys(ma).length} pts  B=${Object.keys(mb).length} pts | changed=${changed}  dropped(onlyA)=${onlyA.length}  added(onlyB)=${onlyB.length}`)
for (const [k, n] of Object.entries(changes).sort((x, y) => y[1] - x[1]).slice(0, 45)) console.log(`  ${String(n).padStart(4)}  ${k}`)
if (onlyA.length) console.log('dropped e.g.:', onlyA.slice(0, 12))
if (onlyB.length) console.log('added e.g.:', onlyB.slice(0, 12))
