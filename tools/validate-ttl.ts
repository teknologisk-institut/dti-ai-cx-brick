/**
 * validate-ttl.ts
 *
 * Validates a generated Brick (nightly) TTL file for syntax, structural integrity,
 * and ontology conformance. Uses the n3 library for real Turtle parsing.
 *
 * Checks:
 *   1. Turtle syntax: file parses cleanly as Turtle (via n3)
 *   2. Type completeness: every non-blank subject has at least one `a` (type) triple
 *   3. Class validity: every class used exists in brick-classification-index.json
 *   4. Relationship validity: predicates are known Brick/REC relationships
 *   5. Dangling references: every URI in object position also appears as a subject
 *   6. TSDB references: blank-node structure correct, IDs in valid format
 *   7. Spatial integrity: rooms link to floors, floors link to building
 *
 * Usage:
 *   npx ts-node tools/validate-ttl.ts <buildingId>
 *   npx ts-node tools/validate-ttl.ts <buildingId> --file <subgraph>.ttl
 *   npx ts-node tools/validate-ttl.ts <buildingId> --verbose
 *   npx ts-node tools/validate-ttl.ts <buildingId> --query
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Parser, Quad, Term } from 'n3'
import { isBinarySensorMismatch } from './lib/tag-match'
import { unitUri, unmappedUnits } from './lib/units'
import { loadProfile, dataRoot } from './lib/building-profile'
import { pointIdSeparator, composePointId } from './lib/point-id'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Triple {
  subject: string
  predicate: string
  object: string
  line: number
}

interface ValidationResult {
  file: string
  triples: number
  subjects: number
  errors: Issue[]
  warnings: Issue[]
  stats: {
    typeTriples: number
    spatialTriples: number
    hierarchyTriples: number
    connectionTriples: number
    tsdbRefs: number
    classes: Map<string, number>
    predicates: Map<string, number>
  }
}

interface Issue {
  level: 'error' | 'warning'
  check: string
  message: string
  line?: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Known prefixes we emit
const KNOWN_PREFIXES = new Set(['brick:', 'tag:', 'rec:', 'ref:', 'bacnet:', 'rdfs:', 'xsd:', 'unit:', 'bldg:'])

// Known predicates in our TTL
const KNOWN_PREDICATES = new Set([
  'a',
  'rdfs:label',
  'rdfs:comment',
  'rec:isPartOf',
  'rec:levelNumber',
  'brick:hasPoint',
  'brick:hasPart',
  'brick:isPartOf',
  'brick:feeds',
  'brick:hasLocation',
  'brick:hasUnit',
  'brick:hasTag',
  'rec:includes',
  'brick:controls',
  'brick:hosts',
  'ref:hasExternalReference',
  'ref:hasTimeseriesId',
  'bacnet:objectOf',
  'bacnet:object-name',
  'bacnet:object-identifier',
  'bacnet:object-type',
  'bacnet:device-instance',
  'bacnet:hasPort',
  'bacnet:network-type',
  'bacnet:ip-address',
  'bacnet:ip-default-gateway',
])

// ─── Parser (uses n3 for real Turtle parsing) ───────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

function extractPrefixes(content: string): Map<string, string> {
  const prefixes = new Map<string, string>()
  const re = /@prefix\s+(\S+?:)\s+<([^>]+)>\s*\./g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    prefixes.set(m[1], m[2])
  }
  return prefixes
}

function shortenIri(iri: string, prefixes: Map<string, string>): string {
  for (const [prefix, base] of prefixes) {
    if (iri.startsWith(base) && iri.length > base.length) {
      return prefix + iri.slice(base.length)
    }
  }
  return `<${iri}>`
}

function termToString(term: Term, prefixes: Map<string, string>): string {
  switch (term.termType) {
    case 'NamedNode':
      return shortenIri(term.value, prefixes)
    case 'BlankNode':
      return '_:' + term.value
    case 'Literal':
      return term.value
    default:
      return String((term as any).value)
  }
}

function parseTTL(content: string): { triples: Triple[]; issues: Issue[]; prefixes: Map<string, string> } {
  const triples: Triple[] = []
  const issues: Issue[] = []
  const prefixes = extractPrefixes(content)

  let quads: Quad[]
  try {
    const parser = new Parser()
    quads = parser.parse(content)
  } catch (err: any) {
    const ctxLine: number | undefined = err?.context?.line ?? err?.line
    issues.push({
      level: 'error',
      check: 'syntax',
      message: `Turtle parse failed: ${err.message}`,
      line: ctxLine,
    })
    return { triples, issues, prefixes }
  }

  for (const q of quads) {
    const subject = termToString(q.subject, prefixes)
    // n3 normalises `a` to rdf:type — convert back for downstream checks
    const predicate = q.predicate.value === RDF_TYPE ? 'a' : termToString(q.predicate, prefixes)
    const object = termToString(q.object, prefixes)
    triples.push({ subject, predicate, object, line: 0 })
  }

  return { triples, issues, prefixes }
}

function isBlankSubject(s: string): boolean {
  return s.startsWith('_:')
}

// ─── Validators ─────────────────────────────────────────────────────────────

function validateTypes(triples: Triple[], brickClasses: Set<string>): Issue[] {
  const issues: Issue[] = []

  // Collect all subjects and their type triples
  const subjects = new Map<string, Triple[]>()
  const typeTriples = new Map<string, Triple[]>()

  for (const t of triples) {
    if (isBlankSubject(t.subject)) continue
    if (!subjects.has(t.subject)) subjects.set(t.subject, [])
    subjects.get(t.subject)!.push(t)

    if (t.predicate === 'a') {
      if (!typeTriples.has(t.subject)) typeTriples.set(t.subject, [])
      typeTriples.get(t.subject)!.push(t)
    }
  }

  // Every non-blank subject should have exactly one type triple
  for (const [subj, tTriples] of subjects) {
    if (isBlankSubject(subj)) continue
    const types = typeTriples.get(subj) || []
    if (types.length === 0) {
      issues.push({ level: 'error', check: 'type-completeness', message: `${subj} has no type (a) triple`, line: tTriples[0]?.line })
    } else if (types.length > 1) {
      issues.push({ level: 'warning', check: 'type-completeness', message: `${subj} has ${types.length} type triples`, line: types[1].line })
    }
  }

  // Every class used should exist in the brick index
  for (const t of triples) {
    if (t.predicate !== 'a') continue
    if (isBlankSubject(t.subject)) continue

    const cls = t.object
    // Build the lookup key: any already-prefixed class (rec:, brick:, bacnet:,
    // ref:, …) stays as-is; only bare names get the brick: prefix.
    const lookupKey = cls.includes(':') ? cls : `brick:${cls}`

    if (!brickClasses.has(lookupKey)) {
      issues.push({ level: 'error', check: 'class-validity', message: `Unknown class "${cls}" on ${t.subject}`, line: t.line })
    }
  }

  return issues
}

function validateRelationships(triples: Triple[]): Issue[] {
  const issues: Issue[] = []

  for (const t of triples) {
    if (isBlankSubject(t.subject)) continue
    if (t.predicate === 'a') continue

    // Check predicate is known
    if (!KNOWN_PREDICATES.has(t.predicate)) {
      issues.push({ level: 'warning', check: 'predicate-validity', message: `Unknown predicate "${t.predicate}" on ${t.subject}`, line: t.line })
    }
  }

  return issues
}

function validateDanglingRefs(triples: Triple[], isSubgraph: boolean): Issue[] {
  const issues: Issue[] = []

  const allSubjects = new Set<string>()
  for (const t of triples) allSubjects.add(t.subject)

  // In subgraph mode, dangling refs are expected (entities outside the subgraph)
  const level: 'error' | 'warning' = isSubgraph ? 'warning' : 'error'
  for (const t of triples) {
    if (t.predicate === 'a' || t.predicate === 'rdfs:label' || t.predicate === 'rdfs:comment') continue
    if (t.predicate === 'rec:levelNumber') continue
    if (t.predicate === 'ref:hasTimeseriesId' || t.predicate === 'ref:hasExternalReference') continue

    const obj = t.object
    if (obj.startsWith('bldg:') && !allSubjects.has(obj)) {
      issues.push({ level, check: 'dangling-ref', message: `${t.subject} ${t.predicate} ${obj} — target not defined as subject`, line: t.line })
    }
  }

  return issues
}

// TimeseriesId format: warns (never errors) on a ref:hasTimeseriesId that is not an 8-4-4-4-12 hex
// UUID. generate-ttl emits tsdb.id, the objects.json object name (example: VE01_TI1), so a
// timeseries building's ids are not UUIDs and each one gets this warning.
function validateTSDB(triples: Triple[]): Issue[] {
  const issues: Issue[] = []

  // Map blank-node subject → parent (the entity that has ref:hasExternalReference)
  const blankParent = new Map<string, string>()
  for (const t of triples) {
    if (t.predicate === 'ref:hasExternalReference' && isBlankSubject(t.object)) {
      blankParent.set(t.object, t.subject)
    }
  }

  // UUID format check on ref:hasTimeseriesId
  for (const t of triples) {
    if (t.predicate !== 'ref:hasTimeseriesId') continue
    if (!UUID_RE.test(t.object)) {
      const parent = blankParent.get(t.subject) || t.subject
      issues.push({
        level: 'warning',
        check: 'tsdb-uuid',
        message: `TimeseriesId "${t.object}" on ${parent} is not a valid UUID (source data may use BMS point id as fallback)`,
        line: t.line,
      })
    }
  }

  // Every entity with ref:hasExternalReference should be typed
  const refParents = new Set<string>()
  for (const t of triples) {
    if (t.predicate === 'ref:hasExternalReference' && !isBlankSubject(t.subject)) {
      refParents.add(t.subject)
    }
  }
  const typedSubjects = new Set<string>()
  for (const t of triples) {
    if (t.predicate === 'a' && !isBlankSubject(t.subject)) typedSubjects.add(t.subject)
  }
  for (const subj of refParents) {
    if (!typedSubjects.has(subj)) {
      issues.push({ level: 'warning', check: 'tsdb-orphan', message: `${subj} has TSDB reference but no type triple` })
    }
  }

  // Every blank-node external-ref subject should have an `a ref:*Reference` triple
  const blankTyped = new Set<string>()
  for (const t of triples) {
    if (t.predicate === 'a' && isBlankSubject(t.subject)) blankTyped.add(t.subject)
  }
  for (const [bn, parent] of blankParent) {
    if (!blankTyped.has(bn)) {
      issues.push({ level: 'warning', check: 'tsdb-blank-type', message: `External-ref blank node on ${parent} has no type` })
    }
  }

  return issues
}

// A binary-family BACnet object type (binary-value/binary-input/binary-output on bacnet buildings,
// BinaryInput on timeseries buildings) is a discrete on/off signal — it can never legitimately back a
// continuous-measurement `*_Sensor` class. This is a defense-in-depth structural check:
// the generated TTL already carries `bacnet:object-type` on the same blank node used for
// `ref:hasTimeseriesId` (see validateTSDB's blankParent pattern), so the objectType is read
// straight off the graph rather than re-loading source JSON.
function validateBinaryObjectTypeVsSensorClass(triples: Triple[]): Issue[] {
  const issues: Issue[] = []

  // Map blank-node subject → parent (the entity that has ref:hasExternalReference)
  const blankParent = new Map<string, string>()
  for (const t of triples) {
    if (t.predicate === 'ref:hasExternalReference' && isBlankSubject(t.object)) {
      blankParent.set(t.object, t.subject)
    }
  }

  // objectType per point, read off the blank node's bacnet:object-type triple
  const objectTypeByPoint = new Map<string, { objectType: string; line: number }>()
  for (const t of triples) {
    if (t.predicate !== 'bacnet:object-type') continue
    const parent = blankParent.get(t.subject)
    if (parent) objectTypeByPoint.set(parent, { objectType: t.object, line: t.line })
  }

  // brickClass per point, read off its own `a` triple
  const classByPoint = new Map<string, string>()
  for (const t of triples) {
    if (t.predicate === 'a' && !isBlankSubject(t.subject)) classByPoint.set(t.subject, t.object)
  }

  for (const [point, { objectType, line }] of objectTypeByPoint) {
    const cls = classByPoint.get(point)
    if (!cls) continue
    if (!isBinarySensorMismatch(objectType, cls)) continue
    issues.push({
      level: 'error',
      check: 'binary-objecttype-vs-sensor',
      message: `${point} has binary objectType "${objectType}" but continuous-measurement class ${cls} (not in allowlist)`,
      line,
    })
  }

  return issues
}

function validateSpatial(triples: Triple[]): Issue[] {
  const issues: Issue[] = []

  // Check rooms link to floors and floors link to building
  const isPartOf = new Map<string, string>()
  const types = new Map<string, string>()

  for (const t of triples) {
    if (t.predicate === 'a' && !isBlankSubject(t.subject)) {
      types.set(t.subject, t.object)
    }
    if (t.predicate === 'rec:isPartOf') {
      isPartOf.set(t.subject, t.object)
    }
  }

  // Rooms should link to floors
  for (const [subj, cls] of types) {
    if (subj.startsWith('bldg:room_')) {
      if (!isPartOf.has(subj)) {
        issues.push({ level: 'warning', check: 'spatial', message: `Room ${subj} has no rec:isPartOf (not linked to a floor)` })
      }
    }
  }

  // Floors should link to building
  for (const [subj, cls] of types) {
    if (cls === 'rec:Level' || cls === 'rec:BasementLevel' || cls === 'rec:RoofLevel') {
      if (!isPartOf.has(subj)) {
        issues.push({ level: 'warning', check: 'spatial', message: `Floor ${subj} has no rec:isPartOf (not linked to building)` })
      }
    }
  }

  return issues
}

function classCategory(cls: string, brickIdx: any): string | undefined {
  const key = cls.includes(':') ? cls : `brick:${cls}`
  return brickIdx.classes[key]?.category
}

// Spec faults ① and the Controller pattern: a *_System's brick:hasPoint is
// always wrong (isPointOfShape forbids System as a Point host); a *_System's
// brick:hasPart is always wrong post-migration (nightly's sh:Warning prefers
// rec:includes); a point with no brick:hosts triple where its plant does have
// a resolvable Controller (i.e. some point on that plant IS Controller-hosted)
// is a warning, not an error — hosts is a network-exposure fact this design
// adds, not a structural requirement Brick itself enforces.
function validateSystemFaults(triples: Triple[], brickIdx: any): Issue[] {
  const issues: Issue[] = []
  const typeOf = new Map<string, string>()
  for (const t of triples) if (t.predicate === 'a' && !isBlankSubject(t.subject)) typeOf.set(t.subject, t.object)

  for (const t of triples) {
    if (isBlankSubject(t.subject)) continue
    const subjType = typeOf.get(t.subject)
    if (!subjType) continue
    const category = classCategory(subjType, brickIdx)
    if (category !== 'System') continue
    if (t.predicate === 'brick:hasPoint') {
      issues.push({ level: 'error', check: 'system-hosts-point', message: `${t.subject} (${subjType}) has brick:hasPoint ${t.object} — a System can't host a Point directly (isPointOfShape requires Equipment/Location/Space)`, line: t.line })
    }
    if (t.predicate === 'brick:hasPart') {
      issues.push({ level: 'error', check: 'system-uses-haspart', message: `${t.subject} (${subjType}) has brick:hasPart ${t.object} — nightly recommends rec:includes for System membership`, line: t.line })
    }
  }

  const controllers = new Set<string>()
  for (const [subj, cls] of typeOf) if (cls === 'brick:BACnet_Controller') controllers.add(subj)
  const pointsWithHosts = new Set<string>()
  for (const t of triples) if (t.predicate === 'brick:hosts') pointsWithHosts.add(t.object)
  for (const ctrl of controllers) {
    for (const t of triples) {
      if (t.predicate !== 'brick:hasPoint' || t.subject !== ctrl) continue
      if (!pointsWithHosts.has(t.object)) {
        issues.push({ level: 'warning', check: 'controller-missing-hosts', message: `${t.object} is hasPoint-owned by ${ctrl} but has no brick:hosts triple` })
      }
    }
  }

  return issues
}

// Guards for the zone/equipment relation faults. Two checks, worded
// directly off Brick_nightly.ttl's current (non-deprecated) SHACL shapes: rec:Space's own
// hasPart property shape ("A Location's parts should always be Locations/Spaces") and
// brick:Equipment's isPartOf property shape ("Equipment can be part of a Collection, System or
// other Equipment").
function isCollectionClass(cls: string, brickIdx: any): boolean {
  const key = cls.includes(':') ? cls : `brick:${cls}`
  if (key === 'rec:Collection') return true
  const entry = brickIdx.classes[key]
  return !!entry?.parents?.includes('rec:Collection')
}

function validateSpatialFaults(triples: Triple[], brickIdx: any): Issue[] {
  const issues: Issue[] = []
  const typeOf = new Map<string, string>()
  for (const t of triples) if (t.predicate === 'a' && !isBlankSubject(t.subject)) typeOf.set(t.subject, t.object)

  for (const t of triples) {
    if (isBlankSubject(t.subject) || isBlankSubject(t.object)) continue
    const subjType = typeOf.get(t.subject)
    if (!subjType) continue
    const subjCategory = classCategory(subjType, brickIdx)
    const objType = typeOf.get(t.object)
    const objCategory = objType ? classCategory(objType, brickIdx) : undefined

    if (t.predicate === 'brick:hasPart' && subjCategory === 'Location') {
      if (objCategory !== 'Location') {
        issues.push({
          level: 'error',
          check: 'location-haspart-non-location',
          message: `${t.subject} (${subjType}) has brick:hasPart ${t.object}${objType ? ` (${objType})` : ''} — a Location/Space's hasPart object must also be a Location/Space (e.g. Zone hasPart Room), not Equipment; use brick:feeds and/or brick:hasLocation instead`,
          line: t.line,
        })
      }
    }

    if (t.predicate === 'brick:isPartOf' && subjCategory === 'Equipment') {
      const objOk = objCategory === 'Equipment' || objCategory === 'System' || (!!objType && isCollectionClass(objType, brickIdx))
      if (!objOk) {
        issues.push({
          level: 'error',
          check: 'equipment-ispartof-non-equipment',
          message: `${t.subject} (${subjType}) has brick:isPartOf ${t.object}${objType ? ` (${objType})` : ''} — Equipment's isPartOf object must be System/Equipment/a Collection, not a Location/Zone/Building`,
          line: t.line,
        })
      }
    }
  }

  return issues
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function collectStats(triples: Triple[]): ValidationResult['stats'] {
  const classes = new Map<string, number>()
  const predicates = new Map<string, number>()
  let typeTriples = 0
  let spatialTriples = 0
  let hierarchyTriples = 0
  let connectionTriples = 0
  let tsdbRefs = 0

  for (const t of triples) {
    predicates.set(t.predicate, (predicates.get(t.predicate) || 0) + 1)

    if (t.predicate === 'a' && !isBlankSubject(t.subject)) {
      typeTriples++
      classes.set(t.object, (classes.get(t.object) || 0) + 1)
    }
    if (t.predicate === 'rec:isPartOf') spatialTriples++
    if (t.predicate === 'brick:hasPoint' || t.predicate === 'brick:hasPart') hierarchyTriples++
    if (t.predicate === 'brick:feeds' || t.predicate === 'brick:hasLocation') connectionTriples++
    if (t.predicate === 'ref:hasTimeseriesId') tsdbRefs++
  }

  return { typeTriples, spatialTriples, hierarchyTriples, connectionTriples, tsdbRefs, classes, predicates }
}

// ─── Graph query engine ─────────────────────────────────────────────────────

/** In-memory triple index for graph traversal queries */
class TripleStore {
  private spo = new Map<string, Map<string, Set<string>>>() // subject → predicate → objects
  private ops = new Map<string, Map<string, Set<string>>>() // object → predicate → subjects

  constructor(triples: Triple[]) {
    for (const t of triples) {
      if (isBlankSubject(t.subject)) continue
      // Forward index
      if (!this.spo.has(t.subject)) this.spo.set(t.subject, new Map())
      const pMap = this.spo.get(t.subject)!
      if (!pMap.has(t.predicate)) pMap.set(t.predicate, new Set())
      pMap.get(t.predicate)!.add(t.object)
      // Reverse index
      if (!this.ops.has(t.object)) this.ops.set(t.object, new Map())
      const rpMap = this.ops.get(t.object)!
      if (!rpMap.has(t.predicate)) rpMap.set(t.predicate, new Set())
      rpMap.get(t.predicate)!.add(t.subject)
    }
  }

  /** Get objects: subject predicate ?object */
  objects(subject: string, predicate: string): Set<string> {
    return this.spo.get(subject)?.get(predicate) || new Set()
  }

  /** Get subjects: ?subject predicate object */
  subjects(predicate: string, object: string): Set<string> {
    return this.ops.get(object)?.get(predicate) || new Set()
  }

  /** Get type of a subject */
  typeOf(subject: string): string | undefined {
    const types = this.objects(subject, 'a')
    return types.size > 0 ? [...types][0] : undefined
  }

  /** Check if a triple exists */
  has(subject: string, predicate: string, object: string): boolean {
    return this.spo.get(subject)?.get(predicate)?.has(object) || false
  }

  /** Get all subjects with a given type */
  ofType(cls: string): Set<string> {
    return this.subjects('a', cls)
  }

  /** Get all distinct subjects that have any triple with the given predicate */
  subjectsWithPredicate(predicate: string): Set<string> {
    const out = new Set<string>()
    for (const [s, predMap] of this.spo) {
      if (predMap.has(predicate)) out.add(s)
    }
    return out
  }

  /** Multi-hop: follow a predicate path from a subject, collecting all reachable nodes */
  traverse(start: string, predicate: string, maxDepth = 10): Set<string> {
    const visited = new Set<string>()
    const queue = [start]
    let depth = 0
    while (queue.length > 0 && depth < maxDepth) {
      const next: string[] = []
      for (const node of queue) {
        for (const target of this.objects(node, predicate)) {
          if (!visited.has(target)) {
            visited.add(target)
            next.push(target)
          }
        }
      }
      queue.length = 0
      queue.push(...next)
      depth++
    }
    return visited
  }
}

interface QueryResult {
  name: string
  description: string
  passed: boolean
  expected: string
  actual: string
  details?: string
  // A check whose optional source file is absent: reported as SKIP, counted as neither pass nor fail.
  skipped?: boolean
}

// Same URI minting as generate-ttl.ts's sanitizeUri/plantUri/pointUri/equipUri/roomUri.
function sanitizeId(id: string): string {
  return id.replace(/\./g, '_').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_æøåÆØÅ]/g, '_')
}
const entityUri = (id: string): string => `bldg:${sanitizeId(id)}`
const roomEntityUri = (roomId: string): string => `bldg:room_${sanitizeId(roomId)}`

// spatial-hierarchy.json is zone-centred: zones[] = { id, roomIds }. The distinct room ids of a zone
// (duplicate IFC room records share an id, so they collapse to one link).
function zoneRoomIdList(zone: any): string[] {
  return Array.isArray(zone.roomIds) ? [...new Set<string>(zone.roomIds)] : []
}

const MAX_LISTED = 10

/** "<total> failing: a, b, ... (+N more)" — at most MAX_LISTED ids, plus the total. */
function listFailures(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(', ')
  const more = ids.length > MAX_LISTED ? ` (+${ids.length - MAX_LISTED} more)` : ''
  return `${ids.length} failing: ${shown}${more}`
}

function skippedResult(name: string, description: string, file: string): QueryResult {
  return { name, description, passed: true, skipped: true, expected: '-', actual: `skipped — no ${file}` }
}

function runQueries(store: TripleStore, buildingId: string, dataDir: string): QueryResult[] {
  const results: QueryResult[] = []
  const inputDir = resolve(dataDir, 'inputs')

  const loadInput = (file: string): any => JSON.parse(readFileSync(resolve(inputDir, file), 'utf-8'))
  const loadOptionalInput = (file: string): any => existsSync(resolve(inputDir, file)) ? loadInput(file) : null

  const plantPm = loadInput('plant-point-mapping.json')
  const zonePm = loadInput('zone-point-mapping.json')
  const spatial = loadInput('spatial-hierarchy.json')
  // Optional for bacnet buildings — the checks that need them are skipped when absent.
  const equipInv = loadOptionalInput('equipment-inventory.json')
  const connections = loadOptionalInput('building-connections.json')
  const { separator: pointIdSep, note: pointIdSepNote } = pointIdSeparator(loadProfile(buildingId))
  if (pointIdSepNote) console.log(pointIdSepNote)

  const plants: any[] = plantPm.plants || []
  const zones: any[] = zonePm.zones || []
  const rooms: any[] = spatial.rooms || []
  const spatialZones: any[] = Array.isArray(spatial.zones) ? spatial.zones : []
  const floors: any[] = spatial.floors || []
  const knownZoneIds = new Set<string>(zones.map((z: any) => z.zoneId))
  const plantUris = new Set<string>(plants.map((p: any) => entityUri(p.plantId)))
  const zoneUris = new Set<string>(zones.map((z: any) => entityUri(z.zoneId)))

  const classCat = (cls: string): string | undefined => {
    if (!cls) return undefined
    const key = cls.startsWith('brick:') || cls.startsWith('rec:') ? cls : 'brick:' + cls
    return (brickIdx.classes[key] as any)?.category
  }
  const isEquipClass = (cls: string): boolean => classCat(cls) === 'Equipment'

  // Membership edges from a plant down to its points: hasPoint and hasPart, plus rec:includes,
  // which generate-ttl.ts uses instead of hasPart under a *_System plant (equipment, controllers,
  // equipment-classed points). A point routed onto a device or controller hangs one hop lower.
  const MEMBER_PREDICATES = ['brick:hasPoint', 'brick:hasPart', 'rec:includes']
  const reachable = (start: string): Set<string> => {
    const seen = new Set<string>()
    let frontier = [start]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const node of frontier) {
        for (const p of MEMBER_PREDICATES) {
          for (const o of store.objects(node, p)) {
            if (!seen.has(o)) { seen.add(o); next.push(o) }
          }
        }
      }
      frontier = next
    }
    return seen
  }

  // ─── 1. Every plant has a type triple ─────────────────────────────────────
  {
    const missing = plants.filter((p: any) => !store.typeOf(entityUri(p.plantId))).map((p: any) => p.plantId)
    results.push({
      name: 'Plant types',
      description: 'Every plant in plant-point-mapping has a type triple',
      passed: missing.length === 0,
      expected: `${plants.length} typed plants`,
      actual: `${plants.length - missing.length} typed plants`,
      details: missing.length > 0 ? listFailures(missing) : undefined,
    })
  }

  // ─── 2. Every plant's mapping points are reachable from it ────────────────
  {
    const failing: string[] = []
    let totalMissing = 0
    let totalPoints = 0
    for (const plant of plants) {
      const reach = reachable(entityUri(plant.plantId))
      const missing = (plant.points || []).filter((pt: any) => !reach.has(entityUri(pt.bmsPointId)))
      totalPoints += (plant.points || []).length
      if (missing.length > 0) {
        totalMissing += missing.length
        failing.push(`${plant.plantId} (${missing.length} missing, e.g. ${missing[0].bmsPointId})`)
      }
    }
    results.push({
      name: 'Plant points reachable',
      description: 'Every plant-point-mapping point is reachable from its plant via (hasPoint ∪ hasPart ∪ rec:includes)*',
      passed: failing.length === 0,
      expected: `${totalPoints} points reachable`,
      actual: `${totalPoints - totalMissing} points reachable`,
      details: failing.length > 0 ? `Plants with unreachable points — ${listFailures(failing)}` : undefined,
    })
  }

  // ─── 3. Every plant's inventory equipment is hasPart of it ────────────────
  {
    const name = 'Plant equipment parts'
    const description = 'Every Equipment-class equipment-inventory item is hasPart (rec:includes on a *_System plant) of its plant'
    if (!equipInv) {
      results.push(skippedResult(name, description, 'equipment-inventory.json'))
    } else {
      // An item whose id collides with a point of the same plant stays a Point (or is revived as a
      // minted `_eq` device) in generate-ttl.ts — the point-reachability check covers those.
      const pointIdsByPlant = new Map<string, Set<string>>(
        plants.map((p: any) => [p.plantId, new Set<string>((p.points || []).map((pt: any) => pt.bmsPointId))])
      )
      const missing: string[] = []
      let expected = 0
      for (const pe of equipInv.plantEquipment || []) {
        const pointIds = pointIdsByPlant.get(pe.plantId)
        if (!pointIds) continue // plant not in the point mapping -> not emitted
        const plantUri = entityUri(pe.plantId)
        for (const eq of pe.equipment || []) {
          if (!isEquipClass(eq.brickClass || 'HVAC_Equipment')) continue
          if (pointIds.has(composePointId(pointIdSep, pe.plantId, eq.id))) continue
          expected++
          // project URI convention: fixed "_" (not the building's naming)
          const uri = `${plantUri}_${sanitizeId(eq.id)}`
          if (!store.has(plantUri, 'brick:hasPart', uri) && !store.has(plantUri, 'rec:includes', uri)) {
            missing.push(uri.replace('bldg:', ''))
          }
        }
      }
      results.push({
        name,
        description,
        passed: missing.length === 0,
        expected: `${expected} equipment parts`,
        actual: `${expected - missing.length} equipment parts`,
        details: missing.length > 0 ? listFailures(missing) : undefined,
      })
    }
  }

  // ─── 4. Every plant's feeds equal its zones ───────────────────────────────
  {
    const name = 'Plant feeds zones'
    const description = 'Every plant\'s brick:feeds to zones equals its building-connections plantFeedsZone list'
    if (!connections) {
      results.push(skippedResult(name, description, 'building-connections.json'))
    } else {
      const expectedByPlant = new Map<string, Set<string>>()
      for (const f of connections.plantFeedsZone || []) {
        if (!expectedByPlant.has(f.plantId)) expectedByPlant.set(f.plantId, new Set())
        for (const z of f.zoneIds || []) if (knownZoneIds.has(z)) expectedByPlant.get(f.plantId)!.add(entityUri(z))
      }
      const failing: string[] = []
      let expectedEdges = 0
      let matchedEdges = 0
      for (const plant of plants) {
        const want = expectedByPlant.get(plant.plantId) || new Set<string>()
        const got = new Set([...store.objects(entityUri(plant.plantId), 'brick:feeds')].filter(o => zoneUris.has(o)))
        expectedEdges += want.size
        const missing = [...want].filter(z => !got.has(z))
        const extra = [...got].filter(z => !want.has(z))
        matchedEdges += want.size - missing.length
        if (missing.length > 0 || extra.length > 0) failing.push(`${plant.plantId} (-${missing.length}/+${extra.length})`)
      }
      results.push({
        name,
        description,
        passed: failing.length === 0,
        expected: `${expectedEdges} plant→zone feeds`,
        actual: `${matchedEdges} matched, ${failing.length} plant(s) differ`,
        details: failing.length > 0 ? `Plants (missing/extra) — ${listFailures(failing)}` : undefined,
      })
    }
  }

  // ─── 5. Every zone's TSDB-linked point count equals the mapping's ─────────
  // A zone's points hang off the zone itself or off its zone equipment, which generate-ttl.ts
  // links as `equipment brick:feeds zone` (never zone hasPart equipment). Plants also feed
  // zones, so plant URIs are excluded from the feeders.
  {
    const failing: string[] = []
    let expectedTotal = 0
    let actualTotal = 0
    for (const zone of zones) {
      const zUri = entityUri(zone.zoneId)
      const pts = reachable(zUri)
      for (const feeder of store.subjects('brick:feeds', zUri)) {
        if (plantUris.has(feeder) || zoneUris.has(feeder)) continue
        for (const p of reachable(feeder)) pts.add(p)
      }
      let actual = 0
      for (const p of pts) if (store.objects(p, 'ref:hasExternalReference').size > 0) actual++
      const expected = new Set<string>((zone.points || []).filter((p: any) => p.tsdb?.id).map((p: any) => p.bmsPointId)).size
      expectedTotal += expected
      actualTotal += actual
      if (actual !== expected) failing.push(`${zone.zoneId} (${actual}/${expected})`)
    }
    results.push({
      name: 'Zone TSDB points',
      description: 'Every zone\'s TSDB-linked points, reached via the zone or the equipment that feeds it, match zone-point-mapping',
      passed: failing.length === 0,
      expected: `${expectedTotal} TSDB-linked zone points`,
      actual: `${actualTotal} TSDB-linked zone points`,
      details: failing.length > 0 ? `Zones (graph/mapping) — ${listFailures(failing)}` : undefined,
    })
  }

  // ─── 6. Every room → floor → building ─────────────────────────────────────
  // One expectation per distinct (room id, floorId) record: a room id listed on several floors
  // must reach each of them.
  {
    const failing: string[] = []
    const pairs = new Map<string, { roomId: string; floorId: string }>()
    for (const r of rooms) pairs.set(`${r.id}@${r.floorId ?? ''}`, { roomId: r.id, floorId: r.floorId })
    const buildingOk = store.typeOf('bldg:Building') === 'rec:Building'
    for (const { roomId, floorId } of pairs.values()) {
      const rUri = roomEntityUri(roomId)
      const fUri = floorId ? entityUri(floorId) : undefined
      const ok = buildingOk && !!store.typeOf(rUri) && !!fUri && store.has(rUri, 'rec:isPartOf', fUri)
        && !!store.typeOf(fUri) && store.has(fUri, 'rec:isPartOf', 'bldg:Building')
      if (!ok) failing.push(`${roomId}@${floorId ?? '(no floorId)'}`)
    }
    results.push({
      name: 'Room → Floor → Building',
      description: 'Every spatial-hierarchy room record isPartOf its typed floor, which isPartOf the rec:Building',
      passed: failing.length === 0,
      expected: `${pairs.size} room→floor links`,
      actual: `${pairs.size - failing.length} room→floor links`,
      details: failing.length > 0 ? listFailures(failing) : undefined,
    })
  }

  // ─── 7. Every zone linked to a room has hasLocation to it ─────────────────
  {
    const failing: string[] = []
    let links = 0
    for (const zone of spatialZones) {
      for (const roomId of zoneRoomIdList(zone)) {
        links++
        if (!store.has(entityUri(zone.id), 'brick:hasLocation', roomEntityUri(roomId))) failing.push(`${zone.id}→${roomId}`)
      }
    }
    results.push({
      name: 'Zone hasLocation room',
      description: 'Every room a spatial-hierarchy zone lists has brick:hasLocation from that zone',
      passed: failing.length === 0,
      expected: `${links} zone→room links`,
      actual: `${links - failing.length} zone→room links`,
      details: failing.length > 0 ? listFailures(failing) : undefined,
    })
  }

  // ─── 8. Room → zone → plant reverse query ─────────────────────────────────
  {
    const name = 'Room → Zone → Plant reverse'
    const description = 'For every room with a fed zone, room ← hasLocation ← zone ← feeds ← plant finds exactly the connected plants'
    if (!connections) {
      results.push(skippedResult(name, description, 'building-connections.json'))
    } else {
      const feedersOfZone = new Map<string, Set<string>>()
      for (const f of connections.plantFeedsZone || []) {
        for (const z of f.zoneIds || []) {
          if (!knownZoneIds.has(z)) continue
          if (!feedersOfZone.has(z)) feedersOfZone.set(z, new Set())
          feedersOfZone.get(z)!.add(entityUri(f.plantId))
        }
      }
      const expectedByRoom = new Map<string, Set<string>>()
      for (const zone of spatialZones) {
        for (const roomId of zoneRoomIdList(zone)) {
          for (const p of feedersOfZone.get(zone.id) || []) {
            if (!expectedByRoom.has(roomId)) expectedByRoom.set(roomId, new Set())
            expectedByRoom.get(roomId)!.add(p)
          }
        }
      }
      const failing: string[] = []
      for (const [roomId, want] of expectedByRoom) {
        const got = new Set<string>()
        for (const z of store.subjects('brick:hasLocation', roomEntityUri(roomId))) {
          if (!zoneUris.has(z)) continue
          for (const p of store.subjects('brick:feeds', z)) if (plantUris.has(p)) got.add(p)
        }
        const same = got.size === want.size && [...want].every(p => got.has(p))
        if (!same) failing.push(`${roomId} (found ${got.size}/${want.size})`)
      }
      results.push({
        name,
        description,
        passed: failing.length === 0,
        expected: `${expectedByRoom.size} rooms with fed zones`,
        actual: `${expectedByRoom.size - failing.length} rooms resolve their plants`,
        details: failing.length > 0 ? listFailures(failing) : undefined,
      })
    }
  }

  // ─── 9. Zone and floor counts ─────────────────────────────────────────────
  {
    const graphZones = store.ofType('rec:HVACZone')
    results.push({
      name: 'Total zones',
      description: 'Count of rec:HVACZone entities vs zone-point-mapping',
      passed: graphZones.size === zones.length,
      expected: `${zones.length}`,
      actual: `${graphZones.size}`,
    })
  }
  {
    const graphFloors = new Set<string>()
    for (const t of ['rec:Level', 'rec:BasementLevel', 'rec:RoofLevel']) {
      for (const f of store.ofType(t)) graphFloors.add(f)
    }
    results.push({
      name: 'Total floors',
      description: 'Count of floor-typed entities vs spatial-hierarchy',
      passed: graphFloors.size === floors.length,
      expected: `${floors.length}`,
      actual: `${graphFloors.size}`,
    })
  }

  // Unique points across both mappings (the TTL emits one entity per bmsPointId).
  const uniquePoints = new Map<string, any>()
  for (const p of plants) for (const pt of p.points || []) if (!uniquePoints.has(pt.bmsPointId)) uniquePoints.set(pt.bmsPointId, pt)
  for (const z of zones) for (const pt of z.points || []) if (!uniquePoints.has(pt.bmsPointId)) uniquePoints.set(pt.bmsPointId, pt)
  // Controller-wide device points (plant-point-mapping's top-level `devices`).
  for (const d of Array.isArray(plantPm.devices) ? plantPm.devices : []) for (const pt of d.points || []) if (!uniquePoints.has(pt.bmsPointId)) uniquePoints.set(pt.bmsPointId, pt)

  // ─── 10. hasExternalReference count ───────────────────────────────────────
  {
    const graphRefs = store.subjectsWithPredicate('ref:hasExternalReference').size
    const expected = [...uniquePoints.values()].filter((pt: any) => pt.tsdb?.id).length
    results.push({
      name: 'TSDB reference count',
      description: 'Entities with ref:hasExternalReference vs unique mapping points with a tsdb.id',
      passed: graphRefs === expected,
      expected: `${expected}`,
      actual: `${graphRefs}`,
    })
  }

  // ─── 11. hasUnit count ────────────────────────────────────────────────────
  {
    const withUnits = [...uniquePoints.values()].filter((pt: any) => pt.tsdb?.units)
    const expected = withUnits.filter((pt: any) => unitUri(pt.tsdb.units) !== undefined).length
    const graphUnits = store.subjectsWithPredicate('brick:hasUnit').size
    const unmapped = unmappedUnits(withUnits.map((pt: any) => pt.tsdb.units))
    const unmappedText = Object.entries(unmapped).map(([u, n]) => `${u}×${n}`).join(', ')
    results.push({
      name: 'Unit triple count',
      description: 'Points with brick:hasUnit vs unique mapping points whose tsdb.units is in the unit map',
      passed: graphUnits === expected,
      expected: `${expected}`,
      actual: `${graphUnits}`,
      details: unmappedText ? `Unmapped units (information, not counted): ${unmappedText}` : undefined,
    })
  }

  return results
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const buildingId = args[0]

if (!buildingId) {
  console.error('Usage: npx ts-node tools/validate-ttl.ts <buildingId> [--file <name.ttl>] [--verbose] [--query]')
  process.exit(1)
}

const verbose = hasFlag(args, '--verbose')
const queryMode = hasFlag(args, '--query')
const fileArg = getArg(args, '--file')
const ttlFile = fileArg || 'building.ttl'
const ttlPath = resolve(dataRoot(), buildingId, 'outputs', ttlFile)

if (!existsSync(ttlPath)) {
  console.error(`TTL file not found: ${ttlPath}`)
  process.exit(1)
}

// Load brick classification index
const brickIdxPath = resolve(__dirname, '..', 'ontologies', 'brick-classification-index.json')
const brickIdx = JSON.parse(readFileSync(brickIdxPath, 'utf-8'))
const brickClasses = new Set<string>(Object.keys(brickIdx.classes))

// Also add ref: and bacnet: types used in blank nodes / external references
brickClasses.add('ref:TimeseriesReference')
brickClasses.add('ref:BACnetReference')
brickClasses.add('bacnet:BACnetDevice')
brickClasses.add('bacnet:Port')

console.log(`Validating: ${ttlPath}`)
console.log()

// Parse
const content = readFileSync(ttlPath, 'utf-8')
const { triples, issues: parseIssues, prefixes } = parseTTL(content)

// Detect subgraph mode (any file that's not building.ttl)
const isSubgraph = ttlFile !== 'building.ttl'

// Run all validators
const allIssues: Issue[] = [
  ...parseIssues,
  ...validateTypes(triples, brickClasses),
  ...validateRelationships(triples),
  ...validateDanglingRefs(triples, isSubgraph),
  ...validateTSDB(triples),
  ...validateSpatial(triples),
  ...validateBinaryObjectTypeVsSensorClass(triples),
  ...validateSystemFaults(triples, brickIdx),
  ...validateSpatialFaults(triples, brickIdx),
]

const errors = allIssues.filter(i => i.level === 'error')
const warnings = allIssues.filter(i => i.level === 'warning')
const stats = collectStats(triples)

// Unique subjects
const subjects = new Set(triples.filter(t => !isBlankSubject(t.subject)).map(t => t.subject))

// ─── Report ─────────────────────────────────────────────────────────────────

console.log(`Parsed: ${triples.length} triples, ${subjects.size} entities`)
console.log()

console.log(`Stats:`)
console.log(`  Type assertions:   ${stats.typeTriples}`)
console.log(`  Spatial (isPartOf): ${stats.spatialTriples}`)
console.log(`  Hierarchy (hasPoint/hasPart): ${stats.hierarchyTriples}`)
console.log(`  Connections (feeds/hasLocation): ${stats.connectionTriples}`)
console.log(`  TSDB references:   ${stats.tsdbRefs}`)
console.log()

// Predicate breakdown
if (verbose) {
  console.log(`Predicates:`)
  for (const [pred, count] of [...stats.predicates.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pred}: ${count}`)
  }
  console.log()

  // Top classes
  console.log(`Top classes:`)
  for (const [cls, count] of [...stats.classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${cls}: ${count}`)
  }
  console.log()
}

// Group issues by check
const issuesByCheck = new Map<string, Issue[]>()
for (const issue of allIssues) {
  const key = `${issue.level}:${issue.check}`
  if (!issuesByCheck.has(key)) issuesByCheck.set(key, [])
  issuesByCheck.get(key)!.push(issue)
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('Validation PASSED — no issues found')
} else {
  if (errors.length > 0) {
    console.log(`ERRORS: ${errors.length}`)
    for (const [check, items] of issuesByCheck) {
      if (!check.startsWith('error:')) continue
      console.log(`  [${check.replace('error:', '')}] ${items.length} issue(s)`)
      const show = verbose ? items : items.slice(0, 5)
      for (const item of show) {
        console.log(`    ${item.line ? `L${item.line}: ` : ''}${item.message}`)
      }
      if (!verbose && items.length > 5) {
        console.log(`    ... and ${items.length - 5} more (use --verbose to see all)`)
      }
    }
    console.log()
  }

  if (warnings.length > 0) {
    console.log(`WARNINGS: ${warnings.length}`)
    for (const [check, items] of issuesByCheck) {
      if (!check.startsWith('warning:')) continue
      console.log(`  [${check.replace('warning:', '')}] ${items.length} issue(s)`)
      const show = verbose ? items : items.slice(0, 5)
      for (const item of show) {
        console.log(`    ${item.line ? `L${item.line}: ` : ''}${item.message}`)
      }
      if (!verbose && items.length > 5) {
        console.log(`    ... and ${items.length - 5} more (use --verbose to see all)`)
      }
    }
    console.log()
  }

  console.log(`Result: ${errors.length} errors, ${warnings.length} warnings`)
}

// ─── Query mode ─────────────────────────────────────────────────────────────

if (queryMode) {
  console.log()
  console.log('=' .repeat(60))
  console.log('Graph Query Tests')
  console.log('=' .repeat(60))

  const store = new TripleStore(triples)
  const dataDir = resolve(dataRoot(), buildingId)
  let queryResults: QueryResult[]
  try {
    queryResults = runQueries(store, buildingId, dataDir)
  } catch (err: any) {
    console.error(`Query mode failed: ${err?.message ?? err}`)
    process.exit(1)
  }

  let passed = 0
  let failed = 0
  let skipped = 0
  for (const r of queryResults) {
    const icon = r.skipped ? 'SKIP' : r.passed ? 'PASS' : 'FAIL'
    console.log(`  ${icon}  ${r.name}`)
    console.log(`         ${r.description}`)
    if (r.skipped) {
      console.log(`         ${r.actual}`)
    } else if (!r.passed || verbose || r.details) {
      console.log(`         Expected: ${r.expected}`)
      console.log(`         Actual:   ${r.actual}`)
      if (r.details) console.log(`         Details:  ${r.details}`)
    }
    if (r.skipped) skipped++
    else if (r.passed) passed++
    else failed++
  }

  console.log()
  console.log(`Query results: ${passed} passed, ${skipped} skipped, ${failed} failed out of ${queryResults.length}`)

  if (failed > 0) process.exit(1)
}

process.exit(errors.length > 0 ? 1 : 0)
