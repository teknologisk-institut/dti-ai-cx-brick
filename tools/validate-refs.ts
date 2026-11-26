// validate-refs.ts
//
// Cross-checks the external references emitted in building.ttl against the source
// point mappings — i.e. that every timeseries / BACnet id in the graph is REAL
// (matches the input files) and that no source point with a tsdb id was dropped.
//
//   timeseries: ref:TimeseriesReference / ref:hasTimeseriesId "<tsdb.id>"
//   BACnet:     ref:BACnetReference / bacnet:object-name "<tsdb.id>"
//               + bacnet:object-identifier "<kebab(objectType)>,<objectInstance>"
//               + bacnet:objectOf bldg:dev_<host>  (host device-instance == tsdb.deviceInstance)
//
// Checks: id match (both directions), coverage (no missing/extra refs), and for
// BACnet the object-identifier + host-device linkage, plus device blocks vs devices.csv.
//
// Usage: npx ts-node tools/validate-refs.ts {buildingId}

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Parser } from 'n3'
import { loadProfile, inputPath, BuildingProfile } from './lib/building-profile'

const buildingId = process.argv[2]
if (!buildingId) { console.error('Usage: npx ts-node tools/validate-refs.ts {buildingId}'); process.exit(1) }

let profile: BuildingProfile
try {
  profile = loadProfile(buildingId)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

const inputDir = resolve(__dirname, '..', 'data', buildingId, 'inputs')
const ttlPath = resolve(__dirname, '..', 'data', buildingId, 'outputs', 'building.ttl')
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const ttlContent = readFileSync(ttlPath, 'utf-8')
const bldgPrefix = (ttlContent.match(/@prefix\s+bldg:\s*<([^>]+)>/) || [, `urn:${buildingId}/`])[1] as string
const localOf = (v: string) => v.startsWith(bldgPrefix) ? v.slice(bldgPrefix.length) : v

// objectType → BACnet object-identifier type token (mirrors generate-ttl emitBacnetRef)
const kebab = (s: string) => s.replace(/([A-Z])/g, (m, c, i) => (i ? `-${c}` : c)).toLowerCase()
// mirrors generate-ttl sanitizeUri — the TTL subject local name is the SANITIZED bmsPointId
const sanitizeUri = (id: string) => id.replace(/\./g, '_').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_æøåÆØÅ]/g, '_')

// ── 1. Collect source points with a tsdb id (points + subpoints) ──
interface Tsdb { id: string; objectType: string; objectInstance: number; deviceInstance?: number }
const source = new Map<string, Tsdb>()  // bmsPointId → tsdb
function collect(node: any): void {
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node && typeof node === 'object') {
    if (typeof node.bmsPointId === 'string' && node.tsdb && typeof node.tsdb.id === 'string') {
      // key by the SANITIZED id (matches the TTL subject local name); store raw tsdb for id compare
      source.set(sanitizeUri(node.bmsPointId), node.tsdb)
    }
    for (const k of Object.keys(node)) collect(node[k])
  }
}
for (const f of ['plant-point-mapping.json', 'zone-point-mapping.json']) {
  const p = resolve(inputDir, f)
  if (existsSync(p)) collect(JSON.parse(readFileSync(p, 'utf-8')))
}

// ── 2. Parse the TTL refs ──
const quads = new Parser().parse(ttlContent)
const extRefOf = new Map<string, string>()              // pointLocal → blank id
const blank = new Map<string, any>()                    // blank id → { type, tsId, objName, objId, objOf }
const devInstance = new Map<string, string>()           // deviceLocal → instance
for (const q of quads) {
  const p = q.predicate.value
  if (p.endsWith('hasExternalReference')) { extRefOf.set(localOf(q.subject.value), q.object.value); continue }
  if (p.endsWith('#device-instance') || p.endsWith('/device-instance')) devInstance.set(localOf(q.subject.value), q.object.value)
  if (q.subject.termType === 'BlankNode') {
    const b = blank.get(q.subject.value) || {}
    if (p === RDF_TYPE) b.type = q.object.value
    else if (p.endsWith('hasTimeseriesId')) b.tsId = q.object.value
    else if (p.endsWith('object-name')) b.objName = q.object.value
    else if (p.endsWith('object-identifier')) b.objId = q.object.value
    else if (p.endsWith('objectOf')) b.objOf = localOf(q.object.value)
    blank.set(q.subject.value, b)
  }
}

// ── 3. Cross-check ──
const errors: string[] = []
// The check is decided by the profile; the TTL's ref kind must agree with it.
const isBacnet = profile.dataShape === 'bacnet'
const ttlHasBacnetRefs = [...blank.values()].some(b => b.type && b.type.endsWith('BACnetReference'))
if (extRefOf.size > 0 && ttlHasBacnetRefs !== isBacnet) {
  errors.push(`profile dataShape is ${profile.dataShape} but the TTL contains ${ttlHasBacnetRefs ? 'BACnet' : 'timeseries'} refs`)
}

// 3a. every TTL ref matches a source point + correct id (no fabricated / mangled ids)
for (const [pt, blankId] of extRefOf) {
  const b = blank.get(blankId) || {}
  const src = source.get(pt)
  if (!src) { errors.push(`TTL ref on bldg:${pt} has NO matching source point with tsdb`); continue }
  const emittedId = isBacnet ? b.objName : b.tsId
  if (emittedId !== src.id) errors.push(`id mismatch on ${pt}: TTL="${emittedId}" vs source tsdb.id="${src.id}"`)
  if (isBacnet) {
    const expectId = `${kebab(src.objectType)},${src.objectInstance}`
    if (b.objId !== expectId) errors.push(`object-identifier mismatch on ${pt}: TTL="${b.objId}" vs expected "${expectId}"`)
    if (src.deviceInstance != null) {
      const hostInst = b.objOf ? devInstance.get(b.objOf) : undefined
      if (hostInst !== String(src.deviceInstance))
        errors.push(`host device mismatch on ${pt}: objectOf=${b.objOf} (instance ${hostInst}) vs source deviceInstance=${src.deviceInstance}`)
    }
  }
}

// 3b. coverage — every source point with a tsdb id is emitted
let missing = 0
for (const pt of source.keys()) if (!extRefOf.has(pt)) { missing++; if (missing <= 10) errors.push(`source point ${pt} has tsdb.id but NO ref in TTL`) }

// 3c. BACnet buildings: device blocks vs the profile's inputs.devices (devices.csv)
let devReport = ''
if (isBacnet) {
  const devCsv = inputPath(profile, 'devices') // a bacnet profile always declares inputs.devices
  if (!existsSync(devCsv)) errors.push(`devices file declared in the building profile does not exist: ${devCsv}`)
  else {
    const lines = readFileSync(devCsv, 'utf-8').trim().split(/\r?\n/)
    const csvInstances = new Set(lines.slice(1).map(l => l.split(',')[0].trim()))
    let devOk = 0, devBad = 0
    for (const inst of devInstance.values()) { if (csvInstances.has(inst)) devOk++; else { devBad++; errors.push(`device-instance ${inst} in TTL not found in devices.csv`) } }
    devReport = `  Devices: ${devInstance.size} blocks, ${devOk} match devices.csv (${csvInstances.size} rows)`
  }
}

// ── 4. Report ──
console.log(`Ref validation — ${buildingId} (${isBacnet ? 'BACnet' : 'Timeseries'})`)
console.log(`  Source points with tsdb.id: ${source.size}`)
console.log(`  TTL external references:    ${extRefOf.size}`)
if (devReport) console.log(devReport)
console.log('')
if (errors.length === 0) {
  console.log(`PASSED — all ${extRefOf.size} refs match source ids; 0 missing, 0 mismatches.`)
} else {
  console.log(`FAILED — ${errors.length} issue(s):`)
  for (const e of errors.slice(0, 40)) console.log(`  - ${e}`)
  if (errors.length > 40) console.log(`  ... and ${errors.length - 40} more`)
  process.exit(1)
}
