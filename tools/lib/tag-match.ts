// tools/lib/tag-match.ts
//
// Shared, building-agnostic semantic-classification core: the per-part combination of a point's
// dictionary contributions (combineParts) and the class match against Brick's own per-class tags
// (matchPointClass), plant/equipment class tags, and the binary-signal consistency checks. Used by
// classify-all.ts, the dictionary review and the audits.
//
//   • class identity comes from a FULL tag-set match against Brick's own per-class tags
//     (open set, not a {role,quantity,medium,direction} signature — that collapses 56%).
//   • ties break by FACET PRIORITY: core identity facets (role/quantity/medium/direction)
//     outrank statistical modifiers (Max/Min/Limit…).

import * as fs from 'fs'
import * as path from 'path'
import type { Contribution, Level } from './point-parts'
import { wordSpans } from './point-parts'
import type { WordEntry } from './point-dictionary'

// alias: the index gives the class no tags of its own (it took its equivalent's).
export type PointClass = { key: string; tags: Set<string>; size: number; depth: number; equivalents?: string[]; alias?: boolean }

// Which mutually-exclusive dimension each Brick tag belongs to (for tie-break + the
// audit's contradiction test). Unmapped tags simply never participate — safe default.
export const DIM: Record<string, string> = {}
for (const t of ['Sensor', 'Setpoint', 'Command', 'Status', 'Alarm', 'Parameter']) DIM[t] = 'role'
for (const t of ['CO2', 'Humidity', 'Pressure', 'Flow', 'Temperature', 'Energy', 'Power', 'Illuminance', 'Volume']) DIM[t] = 'quantity'
for (const t of ['Air', 'Water', 'Hot', 'Chilled', 'Domestic']) DIM[t] = 'medium'
for (const t of ['Supply', 'Discharge', 'Return', 'Exhaust', 'Outside', 'Intake', 'Zone', 'Mixed', 'Entering', 'Leaving']) DIM[t] = 'direction'
for (const t of ['Max', 'Min', 'High', 'Low', 'Average', 'Reset', 'Deadband', 'Limit']) DIM[t] = 'modifier'
for (const t of ['Occupied', 'Unoccupied', 'Standby', 'Effective', 'Target', 'Level']) DIM[t] = 'occupancy'
// Extended dimensions (non-core; below modifier in tie-break). Tags not present on any
// Brick class simply never help — generous derivation is safe (subset rule still gates).
for (const t of ['Heat', 'Cool']) DIM[t] = 'intent'
for (const t of ['Valve', 'Damper', 'Filter', 'Fan', 'Pump', 'Motor', 'Coil', 'Compressor']) DIM[t] = 'subject'
for (const t of ['Enable', 'Run', 'Start_Stop', 'Speed', 'Position']) DIM[t] = 'commandverb'
for (const t of ['Proportional_Band', 'Integral', 'Derivative', 'Gain']) DIM[t] = 'control'
for (const t of ['Smoke', 'Leak', 'Frost', 'Fire']) DIM[t] = 'safety'

// Core identity dimensions (used for the facet-priority tie-break).
export const CORE_DIMS = new Set(['role', 'quantity', 'medium', 'direction'])

// Canonical value of a dimension within a tag-set (collapses synonyms/sub-mediums),
// used by the audit's contradiction test. Returns '' if the dimension is unset.
export function dimValue(tags: Set<string>, dim: string): string {
  if (dim === 'medium') {
    if (tags.has('Water') || tags.has('Hot') || tags.has('Chilled') || tags.has('Domestic')) return 'Water'
    if (tags.has('Air')) return 'Air'
    return ''
  }
  if (dim === 'direction') {
    if (tags.has('Supply') || tags.has('Discharge')) return 'Supply'
    if (tags.has('Return') || tags.has('Exhaust')) return 'Extract'   // both extract-side
    if (tags.has('Outside') || tags.has('Intake')) return 'Outside'
    if (tags.has('Zone')) return 'Zone'
    if (tags.has('Mixed')) return 'Mixed'
    if (tags.has('Entering')) return 'Entering'
    if (tags.has('Leaving')) return 'Leaving'
    return ''
  }
  if (dim === 'role') {
    // Parameter only when it is the sole role tag (a *_Setpoint_Limit is a Setpoint here)
    for (const t of tags) if (DIM[t] === 'role' && t !== 'Parameter') return t
    return tags.has('Parameter') ? 'Parameter' : ''
  }
  for (const t of tags) if (DIM[t] === dim) return t
  return ''
}

// Load the tagged Brick Point classes from a classification index object. An alias class
// (no tags, an equivalentClass that has tags) takes its equivalent's tags.
export function loadPointClasses(idx: any): PointClass[] {
  return loadTaggedClasses(idx, ['Point'])
}

// The tagged Brick Equipment and System classes, for plants (aliases as for points).
export function loadPlantClasses(idx: any): PointClass[] {
  return loadTaggedClasses(idx, ['Equipment', 'System'])
}

function loadTaggedClasses(idx: any, categories: string[]): PointClass[] {
  const out: PointClass[] = []
  const bare = (k: string) => k.replace(/^brick:/, '')
  for (const [key, e] of Object.entries<any>(idx.classes)) {
    if (!categories.includes(e.category)) continue
    const equivalents = Array.isArray(e.equivalentClass) ? e.equivalentClass.map(bare) : []
    let tags: string[] | null = Array.isArray(e.tags) ? e.tags : null
    let alias = false
    if (!tags) {
      for (const q of equivalents) {
        const qe = idx.classes['brick:' + q] || idx.classes[q]
        if (qe && Array.isArray(qe.tags)) { tags = qe.tags; alias = true; break }
      }
    }
    if (!tags) continue
    out.push({ key: bare(key), tags: new Set<string>(tags), size: tags.length, depth: e.parents?.length ?? 0, equivalents, alias })
  }
  return out
}

export function classTags(idx: any, brickClass: string): Set<string> {
  const e = idx.classes['brick:' + brickClass] || idx.classes[brickClass]
  return new Set<string>(Array.isArray(e?.tags) ? e.tags : [])
}

// Classes Brick itself models as Sensor despite an inherently binary signal (a motion/
// contact/occupancy sensor really is just on/off) — legitimate, not a mismatch. Shared
// between classify-all.ts's write-time guard and validate-ttl.ts's post-hoc guardrail so
// the two checks can never drift apart.
export const BINARY_SENSOR_ALLOWLIST = new Set(['Occupancy_Sensor', 'Contact_Sensor', 'Motion_Sensor'])

// A class's ancestors (bare names), from the classification index's `parents`. Loaded once, here,
// so every caller of isBinarySensorMismatch follows the same hierarchy.
let indexParents: Record<string, string[]> | null = null
function ancestorsOf(bare: string): string[] {
  if (!indexParents) {
    const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ontologies', 'brick-classification-index.json'), 'utf-8'))
    indexParents = {}
    for (const [k, e] of Object.entries<any>(idx.classes)) {
      indexParents[k.replace(/^brick:/, '')] = Array.isArray(e.parents) ? e.parents.map((p: string) => p.replace(/^brick:/, '')) : []
    }
  }
  return indexParents[bare] ?? []
}

// True when a binary-family BACnet objectType (either naming convention — the timeseries route's
// "BinaryInput"/"BinaryValue" or the BACnet route's "binary-value"/"binary-input") is paired with a
// continuous-measurement *_Sensor class outside the allowlist above (a subclass of an
// allowlisted class, e.g. a PIR sensor under Motion_Sensor, is allowed too). A binary-family
// point can only ever report 0/1 — it can never legitimately carry a continuous reading.
export function isBinarySensorMismatch(objectType: string | undefined, brickClass: string | undefined): boolean {
  if (!objectType || !brickClass) return false
  if (!/binary/i.test(objectType)) return false
  const bare = brickClass.startsWith('brick:') ? brickClass.slice('brick:'.length) : brickClass
  if (!/_Sensor$/.test(bare)) return false
  if (BINARY_SENSOR_ALLOWLIST.has(bare)) return false
  if (ancestorsOf(bare).some(a => BINARY_SENSOR_ALLOWLIST.has(a))) return false
  return true
}

// Classes that inherently imply a binary (0/1 on-off/fault/alarm) signal -- asserting one of
// these without grounding is the same unverified-decoder-trust shape that caused the CO2 bug,
// just for a different target class. Grounded here against `tsdb.objectType` the
// same way isBinarySensorMismatch grounds the opposite direction.
export const BINARY_IMPLYING_CLASSES = new Set(['On_Off_Status', 'On_Off_Command', 'Fault_Status', 'Alarm'])

// True when a class that inherently implies a binary signal is paired with a BACnet objectType
// CONFIRMED not binary (analog-value, multi-state-value, AnalogInput, etc) -- positive evidence
// the assigned class is wrong, not just unconfirmed. Mirrors isBinarySensorMismatch for the
// opposite direction. False when objectType is absent -- see isUngroundedBinaryClaim for that case.
export function isNonBinaryCommandMismatch(objectType: string | undefined, brickClass: string | undefined): boolean {
  if (!objectType || !brickClass) return false
  if (/binary/i.test(objectType)) return false
  const bare = brickClass.startsWith('brick:') ? brickClass.slice('brick:'.length) : brickClass
  return BINARY_IMPLYING_CLASSES.has(bare)
}

// True when a class that inherently implies a binary signal has NO objectType data at all to
// confirm it -- an ungrounded assertion (no TSDB match), the same epistemic risk as a confirmed
// mismatch (isNonBinaryCommandMismatch), just without positive counter-evidence. The caller
// should demote confidence, not necessarily the class itself -- unconfirmed isn't the same as
// contradicted.
export function isUngroundedBinaryClaim(objectType: string | undefined, brickClass: string | undefined): boolean {
  if (objectType) return false
  if (!brickClass) return false
  const bare = brickClass.startsWith('brick:') ? brickClass.slice('brick:'.length) : brickClass
  return BINARY_IMPLYING_CLASSES.has(bare)
}

// ─── Per-part combination and matching ───────────────────────────────────────────

export type FlagKind = "level-conflict" | "word-clash" | "no-role" | "role-fallback" | "trade-off" | "tie" | "binary-mismatch" | "analog-onoff" | "unit-quantity" | "no-source"
export interface Flag { kind: FlagKind; detail: string }
// objectType rides along for matchPointClass's consistency checks.
export interface Combined { tags: string[]; decidedBy: Record<string, { level: Level; entry: string } | null>; roleSource: Contribution | null; flags: Flag[]; objectType?: string }
export interface ClassMatch { brickClass: string; confidence: "high" | "low"; alternatives: string[]; flags: Flag[] }

// The decided parts and their tags. A part is decided by the first level (source order) that
// carries it; every tag in no part is a union over all contributions.
export const PART_TAGS: Record<string, string[]> = {
  role: ['Sensor', 'Setpoint', 'Command', 'Status', 'Alarm', 'Parameter', 'On', 'Off'],
  quantity: ['CO2', 'Humidity', 'Pressure', 'Flow', 'Temperature', 'Energy', 'Power', 'Illuminance', 'Volume'],
  medium: ['Air', 'Water'],
  waterKind: ['Hot', 'Chilled', 'Domestic'],
  stream: ['Supply', 'Return', 'Exhaust', 'Outside', 'Intake', 'Zone', 'Mixed'],
  subject: ['Valve', 'Damper', 'Filter', 'Fan', 'Pump', 'Motor', 'Coil', 'Compressor'],
  intent: ['Heat', 'Cool'],
  occupancy: ['Occupied', 'Unoccupied', 'Standby'],
}
// The role tags proper (On/Off belong to the role but do not make one).
export const ROLE_TAGS = new Set(['Sensor', 'Setpoint', 'Command', 'Status', 'Alarm', 'Parameter'])
// Only conventions and the host frame add these; contributions' copies are dropped.
export const CONVENTION_ONLY = new Set(['Discharge', 'Entering', 'Leaving', 'District'])
export const LEVEL_ORDER: Level[] = ['override', 'ductPath', 'suffix', 'desc', 'token', 'unit', 'plant']

const partOf: Record<string, string> = {}
for (const [p, ts] of Object.entries(PART_TAGS)) for (const t of ts) partOf[t] = p

// A contribution's value for a part: its tags in that part. The role part needs a role tag proper.
function partValue(c: Contribution, part: string): string[] {
  const v = c.tags.filter(t => partOf[t] === part)
  if (part === 'role' && !v.some(t => ROLE_TAGS.has(t))) return []
  return v
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(t => b.includes(t))
const contains = (a: [number, number], b: [number, number]) => a[0] <= b[0] && b[1] <= a[1]

export function combineParts(cs: Contribution[], opts: { hostFrame: string[]; isZone: boolean; unitTags: string[]; objectType: string }): Combined {
  const flags: Flag[] = []
  const decidedBy: Record<string, { level: Level; entry: string } | null> = {}
  const tags = new Set<string>()
  let roleSource: Contribution | null = null

  for (const part of Object.keys(PART_TAGS)) {
    decidedBy[part] = null
    for (const level of LEVEL_ORDER) {
      let here = cs.filter(c => c.level === level && partValue(c, part).length > 0)
      if (here.length === 0) continue
      if (level === 'desc' && part === 'role') {
        // A phrase that contains another wins over it: drop every contribution whose span lies inside a
        // longer one's, then look for a clash among the rest only.
        here = here.filter(a => !(a.span && here.some(b => b !== a && b.span
          && contains(b.span, a.span!) && b.span[1] - b.span[0] > a.span![1] - a.span![0])))
        const clash = here.some((a, i) => here.some((b, j) => j > i && !sameSet(partValue(a, part), partValue(b, part))
          && !(a.span && b.span && (contains(a.span, b.span) || contains(b.span, a.span)))))
        if (clash) {
          flags.push({ kind: 'word-clash', detail: here.map(c => `${c.entry} [${partValue(c, part).join(',')}]`).join(' vs ') })
          continue   // the role is left to the next level
        }
      }
      const top = Math.max(...here.map(c => c.pos))
      const best = here.filter(c => c.pos === top)
      const win = best[0]
      const val = partValue(win, part)
      if (best.some(c => !sameSet(partValue(c, part), val))) {
        flags.push({ kind: 'level-conflict', detail: `${part} at ${level}: ` + best.map(c => `${c.entry} [${partValue(c, part).join(',')}]`).join(' vs ') })
      }
      decidedBy[part] = { level, entry: win.entry }
      if (part === 'role') roleSource = win
      for (const t of val) tags.add(t)
      // Domestic hot water is hot water: a decided Hot is refined by a lower level's Domestic.
      if (part === 'waterKind' && sameSet(val, ['Hot'])) {
        const li = LEVEL_ORDER.indexOf(level)
        if (cs.some(c => LEVEL_ORDER.indexOf(c.level) > li && partValue(c, part).includes('Domestic'))) tags.add('Domestic')
      }
      break
    }
  }
  for (const c of cs) for (const t of c.tags) if (!partOf[t] && !CONVENTION_ONLY.has(t) && t !== 'Point') tags.add(t)

  // On/Off refine a decided Status or Command whose source carries none: from the highest-precedence
  // lower level with a pure On/Off contribution (no role tag of its own, e.g. state texts).
  const rs = roleSource as Contribution | null
  if (rs && rs.tags.some(t => t === 'Status' || t === 'Command') && !rs.tags.some(t => t === 'On' || t === 'Off')) {
    for (const level of LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(rs.level) + 1)) {
      const pure = cs.filter(c => c.level === level && c.tags.some(t => t === 'On' || t === 'Off') && !c.tags.some(t => ROLE_TAGS.has(t)))
      if (pure.length === 0) continue
      for (const c of pure) for (const t of c.tags) if (t === 'On' || t === 'Off') tags.add(t)
      break
    }
  }

  // Role fallback: a quantity and no role → Sensor (low); neither → no role.
  const hasQty = [...tags].some(t => partOf[t] === 'quantity')
  if (!roleSource) {
    if (hasQty) { tags.add('Sensor'); flags.push({ kind: 'role-fallback', detail: 'quantity without a role: Sensor' }) }
    else flags.push({ kind: 'no-role', detail: 'no role and no quantity' })
  }

  // Generic conventions.
  if (opts.hostFrame.length > 0 && tags.has('Water')) {
    tags.delete('Supply'); tags.delete('Return')
    for (const t of opts.hostFrame) tags.add(t)
  }
  if (tags.has('Supply')) tags.add('Discharge')
  if (tags.has('Limit') && tags.has('Setpoint')) tags.add('Parameter')
  if (tags.has('CO2') && tags.has('Sensor')) tags.add('Level')
  if (opts.isZone && tags.has('Air') && tags.has('Temperature') && tags.has('Setpoint')
      && !['Heat', 'Cool', 'Effective', 'Deadband', 'Max', 'Min'].some(t => tags.has(t))) tags.add('Target')

  // Unit quantity vs the decided quantity.
  const unitQ = opts.unitTags.filter(t => partOf[t] === 'quantity')
  const decidedQ = [...tags].filter(t => partOf[t] === 'quantity')
  if (unitQ.length > 0 && decidedQ.length > 0 && !sameSet(unitQ, decidedQ)) {
    flags.push({ kind: 'unit-quantity', detail: `unit [${unitQ.join(',')}] vs decided [${decidedQ.join(',')}]` })
  }

  return { tags: [...tags], decidedBy, roleSource, flags, objectType: opts.objectType }
}

// The water frame's opposites: a frame tag whose opposite the class carries contradicts it.
const FRAME_OPPOSITE: Record<string, string> = { Entering: 'Leaving', Leaving: 'Entering', Supply: 'Return', Return: 'Supply' }

// A reviewed point's tags without those that contradict its class: for every decided part the class's
// tags carry a value for, the point's tags of that part which the class does not carry are dropped; so is
// a frame tag whose opposite the class carries.
export function dropContradicting(tags: string[], classTags: Set<string>): string[] {
  return tags.filter(t => {
    if (FRAME_OPPOSITE[t] && classTags.has(FRAME_OPPOSITE[t]) && !classTags.has(t)) return false
    const part = partOf[t]
    if (!part) return true
    const settled = PART_TAGS[part].filter(v => classTags.has(v))
    return settled.length === 0 || settled.includes(t)
  })
}

export function matchPointClass(c: Combined, classes: PointClass[]): ClassMatch {
  const flags = [...c.flags]
  const lowFlag = flags.some(f => f.kind === 'role-fallback' || f.kind === 'word-clash')
  if (flags.some(f => f.kind === 'no-role')) return { brickClass: 'Point', confidence: 'low', alternatives: [], flags }

  const pt = new Set(c.tags)
  // The decided role: the role source's role tags proper, else (fallback) Sensor.
  const roles = c.roleSource ? c.roleSource.tags.filter(t => ROLE_TAGS.has(t)) : ['Sensor']
  const src = new Set(c.roleSource ? c.roleSource.tags : [])
  let elig: Array<{ cls: PointClass; kept: number; core: number }> = []
  for (const k of classes) {
    if (!roles.some(r => k.tags.has(r))) continue
    let subset = true
    for (const t of k.tags) if (t !== 'Point' && !pt.has(t)) { subset = false; break }
    if (!subset) continue
    let kept = 0, core = 0
    for (const t of k.tags) { if (src.has(t)) kept++; if (CORE_DIMS.has(DIM[t])) core++ }
    elig.push({ cls: k, kept, core })
  }
  if (pt.has('Deadband') && elig.some(e => e.cls.tags.has('Deadband'))) elig = elig.filter(e => e.cls.tags.has('Deadband'))
  if (elig.length === 0) return { brickClass: 'Point', confidence: 'low', alternatives: [], flags }

  type E = typeof elig[number]
  const rankCmp = (a: E, b: E) => b.kept - a.kept || b.cls.size - a.cls.size || b.core - a.core || b.cls.depth - a.cls.depth
  // Equal rank: the class with its own tags before its alias, then by name (deterministic).
  elig.sort((a, b) => rankCmp(a, b) || Number(!!a.cls.alias) - Number(!!b.cls.alias) || (a.cls.key < b.cls.key ? -1 : a.cls.key > b.cls.key ? 1 : 0))
  const pick = elig[0]
  const isEquiv = (a: PointClass, b: PointClass) => !!a.equivalents?.includes(b.key) || !!b.equivalents?.includes(a.key)
  const equivs = elig.filter(e => e !== pick && isEquiv(e.cls, pick.cls)).map(e => e.cls.key)
  const others = elig.filter(e => e !== pick && !isEquiv(e.cls, pick.cls))
  const alternatives = [...equivs, ...others.slice(0, 2).map(e => e.cls.key)]

  const ties = others.filter(e => rankCmp(e, pick) === 0)
  if (ties.length > 0) flags.push({ kind: 'tie', detail: [pick, ...ties].map(e => e.cls.key).join(' = ') })

  // Trade-off: another class keeps a decided-part or role-source tag the pick drops, and no other
  // class keeps everything it keeps (the best candidates keep different parts of the point).
  // All such undominated classes are listed with the pick, not only the runner-up: the runner-up
  // by rank can be a near-copy of the pick while a class keeping a whole other part ranks lower.
  const telling = c.tags.filter(t => partOf[t] || src.has(t))
  const keeps = (e: E) => telling.filter(t => e.cls.tags.has(t))
  const kp = new Map(elig.map(e => [e, keeps(e)] as [E, string[]]))
  const dominated = (e: E) => elig.some(o => o !== e && !isEquiv(o.cls, e.cls)
    && kp.get(e)!.every(t => kp.get(o)!.includes(t)) && kp.get(o)!.length > kp.get(e)!.length)
  const trade = others.filter(e => kp.get(e)!.some(t => !kp.get(pick)!.includes(t))
      && kp.get(pick)!.some(t => !kp.get(e)!.includes(t)) && !dominated(e))
    .filter((e, i, arr) => !arr.slice(0, i).some(o => isEquiv(o.cls, e.cls)))
  if (trade.length > 0) {
    flags.push({ kind: 'trade-off', detail: [pick, ...trade].map(e => `${e.cls.key} [${kp.get(e)!.join(',')}]`).join(' vs ') })
  }

  const brickClass = pick.cls.key
  if (isBinarySensorMismatch(c.objectType, brickClass)) flags.push({ kind: 'binary-mismatch', detail: `${c.objectType} with ${brickClass}` })
  if (c.objectType && !/binary/i.test(c.objectType) && /^On_Off_/.test(brickClass)) flags.push({ kind: 'analog-onoff', detail: `${c.objectType} with ${brickClass}` })

  return { brickClass, confidence: lowFlag ? 'low' : 'high', alternatives, flags }
}

// ─── Equipment classification (2026-08-20) ────────────────────────────────────
//
// Structurally different from point tags: no role/quantity axis. Every Equipment
// class carries `Equipment` + exactly one physical-type "anchor" tag (Fan, Damper,
// Valve, Pump, Coil, Filter, Chiller, Exchanger, Wheel, Storage) + optional
// qualifiers.
//
// Deliberately excludes equipment.type values whose CURRENT legacy target class is
// Point-category, not Equipment (temperature_sensor, humidity_sensor,
// air_quality_sensor, presence_sensor/occupancy, diff_pressure_sensor, energy_meter,
// flow_meter, meter) — those are a different, pre-existing pattern (equipment-
// inventory entries that are really sensor-location markers) and out of this
// matcher's scope; classifyEquipmentItem's existing rules keep handling them
// unchanged.
const EQUIPMENT_ANCHOR_TYPES: Record<string, string> = {
  supply_fan: 'Fan', return_fan: 'Fan', exhaust_fan: 'Fan',
  damper: 'Damper', fire_damper: 'Damper', mixing_damper: 'Damper',
  outside_damper: 'Damper', exhaust_damper: 'Damper',
  supply_inlet_damper: 'Damper', supply_air_unit: 'Damper',
  heating_valve: 'Valve', cooling_valve: 'Valve', valve: 'Valve',
  pump: 'Pump',
  heating_coil: 'Coil', cooling_coil: 'Coil',
  filter: 'Filter',
  chiller_compressor: 'Chiller', cooling_unit: 'Chiller',
  heat_exchanger: 'Exchanger',
  heat_recovery: 'Wheel', heat_wheel: 'Wheel',
  storage_tank: 'Storage',
}

export function loadEquipmentClasses(idx: any): PointClass[] {
  const out: PointClass[] = []
  for (const [key, e] of Object.entries<any>(idx.classes)) {
    if (e.category !== 'Equipment' || !Array.isArray(e.tags)) continue
    out.push({ key: key.replace(/^brick:/, ''), tags: new Set<string>(e.tags), size: e.tags.length, depth: e.parents?.length ?? 0 })
  }
  return out
}

// Description words are the building's word entries that apply to equipment (appliesTo "equipment"),
// matched whole word. Their Heat/Cool tags are intent (never against the type's own intent), their
// Hot/Chilled/Domestic tags only decide a Pump/Storage medium, and every other tag is a union.
const EQUIPMENT_DESC_DECIDED = new Set(['Heat', 'Cool', 'Hot', 'Chilled', 'Domestic'])

// The tags of the building's equipment word entries found (whole word) in an equipment description.
export function equipmentWordTags(description: string, words: WordEntry[]): Set<string> {
  const dt = new Set<string>()
  for (const w of words) {
    if ((w.appliesTo ?? []).includes('equipment') && wordSpans(w.phrase, description || '').length > 0) for (const tg of w.tags) dt.add(tg)
  }
  return dt
}

// An equipment item that marks a sensor (a point class, not equipment): its base class refined by its
// description's word tags — the point class with the base's role within base + word tags that keeps the
// most word tags (then the largest, the deepest, a class with its own tags before an alias, by name).
export function refineMarkerClass(base: string, wordTags: Set<string>, pointClasses: PointClass[]): string {
  const b = pointClasses.find(c => c.key === base)
  if (!b || wordTags.size === 0) return base
  const roles = [...b.tags].filter(t => ROLE_TAGS.has(t))
  const all = new Set([...b.tags, ...wordTags])
  const elig = pointClasses.filter(c => roles.some(r => c.tags.has(r)) && [...c.tags].every(t => all.has(t)))
  const kept = (c: PointClass) => [...c.tags].filter(t => wordTags.has(t)).length
  elig.sort((x, y) => kept(y) - kept(x) || y.size - x.size || y.depth - x.depth
    || Number(!!x.alias) - Number(!!y.alias) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  return elig[0]?.key ?? base
}

export function deriveEquipmentTags(type: string, description: string, sys: string | null,
    medium: 'hot' | 'chilled' | 'domestic' | 'cold' | 'condenser' | null | undefined, words: WordEntry[]):
    { tags: Set<string>; anchor: string | null } {
  const t = (type || '').toLowerCase()
  const dt = equipmentWordTags(description, words)
  const anchor = EQUIPMENT_ANCHOR_TYPES[t] || null
  const tags = new Set<string>(['Equipment'])
  if (anchor) tags.add(anchor)
  if (!anchor) return { tags, anchor: null }   // unrecognized type — abstain, legacy chain handles it

  // ── direction (Fan/Damper family: extract from type name) ──
  if (t.includes('supply')) { tags.add('Supply'); tags.add('Discharge') }
  if (t.includes('return')) tags.add('Return')
  if (t.includes('exhaust')) tags.add('Exhaust')
  if (t.includes('outside')) tags.add('Outside')
  if (t.includes('mixing')) tags.add('Mixed')  // mixing damper ("blandespjæld")

  // ── intent (Valve/Coil family: Heat/Cool — from type AND description) ──
  // Type intent is authoritative for heating_valve/cooling_valve/heating_coil/cooling_coil (legacy maps them directly).
  // For generic valve/damper types, description decides. Prevent description from contradicting explicit type intent.
  const typeHeat = t.includes('heating') || t.includes('heat')
  const typeCool = t.includes('cooling') || t.includes('cool')
  if (typeHeat) tags.add('Heat')
  if (typeCool) tags.add('Cool')
  if (dt.has('Heat') && !typeCool) tags.add('Heat')
  // For Exchanger: don't derive Cool from description alone (base Heat_Exchanger has Heat,
  // not Cool; condenser variants are identified by Condenser/Water/Air tags). For Valve/Coil: do derive Cool.
  if (anchor !== 'Exchanger' && dt.has('Cool') && !typeHeat) tags.add('Cool')

  // ── medium (Pump/Storage family: Hot/Chilled/Domestic/Water) ──
  // No blind default to Hot when nothing else fires: legacy's own unconditional
  // "else brickClass = 'Hot_Water_Pump'" default is not sound reasoning — it produced
  // a confirmed-wrong answer for a cold domestic-water booster station (per its own plant
  // schematic, not a heating pump at all) once this
  // matcher started asserting confidence:'high' on it. With no medium signal at all,
  // leave the tag set at {Equipment, Pump/Storage-anchor, Water} — this correctly
  // resolves to the generic brick:Water_Pump/Water_Storage_Tank (never wrong, just
  // less specific) instead of confidently guessing a medium with no evidence.
  if (anchor === 'Pump' || anchor === 'Storage') {
    tags.add('Water')
    if (dt.has('Chilled') || dt.has('Cool')) tags.add('Chilled')
    else if (sys === 'dhw' || dt.has('Domestic')) { tags.add('Domestic'); tags.add('Hot'); tags.add('Circulator') }
    else if (dt.has('Hot') || dt.has('Heat') || sys === 'heating') tags.add('Hot')
    else if (sys === 'chilled') tags.add('Chilled')
  }

  // ── every other description tag (Circulator, Bypass, Outside, Wheel, Condenser, Air, Water …) ──
  for (const tg of dt) if (!EQUIPMENT_DESC_DECIDED.has(tg)) tags.add(tg)

  // ── heat-exchanger qualifiers (new: previously entirely unreached) ──
  if (anchor === 'Exchanger') tags.add('HX')  // Brick internal tag for all heat exchangers

  // ── medium override (2026-08-20, equipment-medium-extraction design) ──
  // A captured `medium` is human-confirmed, multi-signal-verified evidence -- the same
  // evidential bar as `ductPath` -- and is authoritative over both `type`'s Heat/Cool intent
  // (Valve/Coil) and `description`/`sys` text-matching (Pump/Storage): `type` is mostly assigned
  // by ID-naming convention at extraction time with no independent cross-check, so subordinating
  // a verified medium field to it would reproduce the exact failure shape this
  // design exists to fix.
  const VALID_MEDIA = new Set(['hot', 'chilled', 'domestic', 'cold', 'condenser'])
  if (medium && VALID_MEDIA.has(medium)) {
    if (anchor === 'Pump' || anchor === 'Storage') {
      // Condenser/Air are cleared too: both are added unconditionally earlier in this function
      // from free-text description matching, and since 'condenser' is itself a medium value, a
      // captured medium must fully control this axis (previously a description-derived
      // Condenser tag could outrank a captured medium of 'hot'/'chilled', reaching
      // Condenser_Water_Pump instead of Hot_Water_Pump/Chilled_Water_Pump).
      tags.delete('Hot'); tags.delete('Chilled'); tags.delete('Domestic'); tags.delete('Circulator')
      tags.delete('Condenser'); tags.delete('Air')
      if (medium === 'hot') tags.add('Hot')
      else if (medium === 'chilled') tags.add('Chilled')
      // Circulator is Pump-only: a Storage tank is never a "circulator."
      else if (medium === 'domestic') { tags.add('Domestic'); tags.add('Hot'); if (anchor === 'Pump') tags.add('Circulator') }
      else if (medium === 'condenser') tags.add('Condenser')
      // 'cold' -> no qualifier tag: resolves to generic Water_Pump/Water_Storage_Tank, matching
      // the booster station's real fix (a cold-water booster station has no Hot/Chilled/Domestic qualifier).
      // Circulator is independent of medium (Hot_Water_Circulator_Pump, Chilled_Water_Circulator_Pump,
      // and Condenser_Water_Circulator_Pump all exist as real, distinct classes from their non-
      // circulator counterparts) -- re-derive it from the same description signal the un-overridden
      // code already uses, so a genuine recirculation pump doesn't silently lose the tag just
      // because its medium turned out to be something other than 'domestic'. Pump-only, per above.
      if (anchor === 'Pump' && dt.has('Circulator')) tags.add('Circulator')
    } else if (anchor === 'Valve' || anchor === 'Coil') {
      // Brick has a second tag axis here beyond Heat/Cool: Hot_Water_Valve/Chilled_Water_Valve/
      // Domestic_Hot_Water_Valve/Hot_Water_Coil/Chilled_Water_Coil are genuine SUBCLASSES of
      // Heating_Valve/Cooling_Valve/Heating_Coil respectively (confirmed via the index's own
      // `parents` field, not a parallel/unrelated taxonomy), and Hot_Water_Valve is already an
      // actively-used brickClass in this project's real committed BACnet output today (via a
      // different pipeline -- plant-point-mapping.json's own plant-level valve entries). Not
      // reaching this family from equipment-inventory-sourced valves
      // once medium is known would be an arbitrary inconsistency with identical evidence
      // producing a less specific result purely because of which pipeline extracted the valve --
      // so this adds the full Hot/Chilled/Water/Domestic tag set on top of Heat/Cool, and lets
      // matchEquipmentClass's largest-eligible-subset tie-break naturally prefer the more
      // specific subclass when it's warranted (harmless when it isn't: a class that doesn't
      // require these extra tags stays equally eligible regardless of whether they're present).
      tags.delete('Heat'); tags.delete('Cool'); tags.delete('Hot'); tags.delete('Chilled'); tags.delete('Domestic'); tags.delete('Water')
      // Condenser/Air are cleared too, for the same reason as the Pump/Storage branch above.
      tags.delete('Condenser'); tags.delete('Air')
      if (medium === 'hot') { tags.add('Heat'); tags.add('Hot'); tags.add('Water') }
      else if (medium === 'chilled') { tags.add('Cool'); tags.add('Chilled'); tags.add('Water') }
      else if (medium === 'domestic') { tags.add('Domestic'); tags.add('Heat'); tags.add('Hot'); tags.add('Water') }
      else if (medium === 'condenser') { tags.add('Condenser'); tags.add('Water') }
      // 'cold' -> no qualifier tag: resolves to generic Valve/Coil. No equivalent Coil+Condenser
      // class exists in the index today, so 'condenser' is a no-op for Coil specifically --
      // matches physical reality, nothing more specific to reach.
    } else if (anchor === 'Exchanger' && medium === 'condenser') {
      tags.add('Condenser')
      // Exchanger anchor's Heat/HX tags are already unconditional (base Heat_Exchanger requires
      // them regardless of medium) -- medium's only useful signal here is condenser confirmation.
    }
  }

  return { tags, anchor }
}

export function matchEquipmentClass(tags: Set<string>, anchor: string | null, equipmentClasses: PointClass[]): string | null {
  if (!anchor) return null
  const elig: Array<{ key: string; size: number; depth: number }> = []
  for (const c of equipmentClasses) {
    if (!c.tags.has(anchor)) continue
    let subset = true
    for (const tg of c.tags) if (!tags.has(tg)) { subset = false; break }
    if (!subset) continue
    elig.push({ key: c.key, size: c.size, depth: c.depth })
  }
  if (!elig.length) return null
  elig.sort((a, b) => b.size - a.size || b.depth - a.depth)
  return elig[0].key
}
