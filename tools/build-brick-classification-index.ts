/**
 * build-brick-classification-index.ts
 *
 * Processes a Brick schema TTL file and outputs a lean classification
 * index optimised for Phase 5 Brick class lookup. Each class entry keeps what is needed for
 * classification decisions: label, direct parent and category, plus, where the TTL has them,
 * definition, equivalentClass, the class's own tags and the ancestor chain (`parents`).
 * Two additive top-level sections sit beside the classes: `tags` (each Brick tag with the
 * classes that carry it, for tag-set matching) and `substances` (each Brick substance with its
 * definition and broader substance).
 *
 * The full TTL (~3MB for Brick nightly) is processed once by this tool. Claude Code then loads
 * only the lean brick-classification-index.json during Phase 5, not the raw TTL.
 *
 * For anything beyond this (properties, restrictions, other relationships), retain
 * Brick_nightly.ttl and query it directly — this tool intentionally does not preserve that detail.
 *
 * The Brick TTL includes both:
 *   - brick: classes  (https://brickschema.org/schema/Brick#)
 *   - rec:   classes  (https://w3id.org/rec# — RealEstateCore, spatial entities)
 *
 * Usage:
 *   npx ts-node tools/build-brick-classification-index.ts <ttl_path> <output_path>
 *
 * Example:
 *   npx ts-node tools/build-brick-classification-index.ts ontologies/Brick_nightly.ttl ontologies/brick-classification-index.json
 *
 * Output structure:
 *   {
 *     "meta": { "source", "generatedAt", "totalClasses", "brickClasses", "recClasses" },
 *     "prefixes": { "brick", "rec", "ref" },
 *     "classes": {
 *       "brick:Air_Handling_Unit": { "label": "Air Handling Unit", "parent": "brick:HVAC", "category": "Equipment" },
 *       "rec:Room":                { "label": "Room", "parent": "rec:Architecture", "category": "Location" }
 *     },
 *     "byCategory": { "Equipment": [...], "Point": [...], "Location": [...], "System": [...], "Other": [...] },
 *     "search":     { "air_handling": ["brick:Air_Handling_Unit"], "room": ["brick:Room", "rec:Room", ...] },
 *     "tags":       { "Return": { "label": "Return", "classes": ["brick:Return_Damper", ...] } },
 *     "substances": { "brick:Return_Air": { "label": "Return Air", "definition": "air removed from a space ...", "broader": "brick:Air" } }
 *   }
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

// Lean entry — label/parent/category drive existing rule validation; the
// enriched fields (definition/tags/equivalentClass/parents) support semantic
// (tag-set) classification and nearest-ancestor fallback.
interface ClassEntry {
  label:            string
  parent:           string | null
  category:         string
  definition?:      string
  tags?:            string[]
  equivalentClass?: string[]
  parents?:         string[]   // full ancestor chain, nearest → root
}

interface ClassificationIndex {
  meta: {
    source:       string
    generatedAt:  string
    totalClasses: number
    brickClasses: number
    recClasses:   number
  }
  prefixes:   Record<string, string>
  classes:    Record<string, ClassEntry>
  byCategory: Record<string, string[]>
  search:     Record<string, string[]>
  tags:       Record<string, TagEntry>
  substances: Record<string, SubstanceEntry>
}

// Brick tags carry no definition of their own; their meaning is the classes
// that use them (brick:isAssociatedWith, limited to classes in this index).
interface TagEntry {
  label:   string
  classes: string[]
}

// Substances (Air, Return_Air, Chilled_Water …) hold the medium/air-stream
// definitions the tags lack.
interface SubstanceEntry {
  label:       string
  definition?: string
  broader?:    string
}

// Raw block from TTL — includes tags for search index enrichment only
interface RawBlock {
  subject:         string
  types:           string[]
  labels:          string[]
  subClassOf:      string[]
  tags:            string[]
  definition:      string | null
  equivalentClass: string[]
  deprecated:      boolean
  associated:      string[]
  broader:         string | null
}

// ─── TTL parsing ──────────────────────────────────────────────────────────────

function parsePrefixes(ttl: string): Record<string, string> {
  const prefixes: Record<string, string> = {}
  const re = /^@prefix\s+(\w*):\s+<([^>]+)>\s*\./gm
  let m: RegExpExecArray | null
  while ((m = re.exec(ttl)) !== null) {
    prefixes[m[1]] = m[2]
  }
  return prefixes
}

function parseBlocks(ttl: string): RawBlock[] {
  const blocks: RawBlock[] = []
  const lines = ttl.split('\n')
  let currentLines: string[] = []
  let currentSubject: string | null = null

  const flushBlock = () => {
    if (!currentSubject || currentLines.length === 0) return
    const block = extractBlock(currentSubject, currentLines.join('\n'))
    if (block) blocks.push(block)
    currentLines = []
    currentSubject = null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('#') || trimmed.startsWith('@prefix') || trimmed === '') {
      if (currentSubject) currentLines.push(line)
      continue
    }

    // Any prefixed subject at column 0 starts a new block. Previously only
    // brick:/rec:/sh:/bsh: were recognised, so `tag:`/`qudt:`/etc. declarations
    // were absorbed into the preceding class block and polluted its tags/labels.
    const newSubjectMatch = trimmed.match(/^([A-Za-z][\w.-]*):(\S+)\s/)
    if (newSubjectMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      flushBlock()
      currentSubject = newSubjectMatch[1] + ':' + newSubjectMatch[2]
    }

    if (currentSubject) currentLines.push(line)
    if (trimmed === '.' && currentSubject) flushBlock()
  }
  flushBlock()

  return blocks
}

function extractBlock(subject: string, blockText: string): RawBlock | null {
  const types: string[] = []
  const labels: string[] = []
  const subClassOf: string[] = []
  const tags: string[] = []
  let m: RegExpExecArray | null

  const typeRe = /(?:^|\s)(?:a|rdf:type)\s+([\w:,\s]+?)(?:\s*[;,.])/gm
  while ((m = typeRe.exec(blockText)) !== null) {
    for (const t of m[1].trim().split(',').map((s: string) => s.trim())) {
      if (t && !t.includes(' ')) types.push(t)
    }
  }

  const labelRe = /rdfs:label\s+"([^"]+)"/g
  while ((m = labelRe.exec(blockText)) !== null) labels.push(m[1])

  const subRe = /rdfs:subClassOf\s+(brick:\w+|rec:\w+)/g
  while ((m = subRe.exec(blockText)) !== null) subClassOf.push(m[1])

  // Tags scoped to THIS class's own assignment, not any stray `tag:X` text:
  // prefer the canonical `brick:hasAssociatedTag tag:A, tag:B …` list; fall back
  // to the `sh:rule [ sh:object tag:X ; sh:predicate brick:hasTag ]` objects.
  const assocM = blockText.match(/brick:hasAssociatedTag\s+((?:tag:\w+[\s,]*)+)/)
  if (assocM) {
    const tre = /tag:(\w+)/g
    while ((m = tre.exec(assocM[1])) !== null) tags.push(m[1])
  } else {
    const hasTagRe = /sh:object\s+tag:(\w+)\s*;\s*sh:predicate\s+brick:hasTag/g
    while ((m = hasTagRe.exec(blockText)) !== null) tags.push(m[1])
  }

  // skos:definition — the canonical human-readable meaning of the class
  let definition: string | null = null
  const defM = blockText.match(/skos:definition\s+"((?:[^"\\]|\\.)*)"/)
  if (defM) definition = defM[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim()

  // owl:equivalentClass — aliases (e.g. Supply_Air_Temperature_Sensor ≡ Discharge_…)
  const equivalentClass: string[] = []
  const eqRe = /owl:equivalentClass\s+(brick:\w+|rec:\w+)/g
  while ((m = eqRe.exec(blockText)) !== null) equivalentClass.push(m[1])

  const deprecated = /owl:deprecated\s+true/.test(blockText)

  // brick:isAssociatedWith — on tag: blocks, the classes that use the tag
  const associated: string[] = []
  const assocWithM = blockText.match(/brick:isAssociatedWith\s+((?:(?:brick|rec):\w+[\s,]*)+)/)
  if (assocWithM) {
    const are = /((?:brick|rec):\w+)/g
    while ((m = are.exec(assocWithM[1])) !== null) associated.push(m[1])
  }

  const broaderM = blockText.match(/skos:broader\s+(brick:\w+)/)
  const broader = broaderM ? broaderM[1] : null

  return { subject, types, labels, subClassOf, tags, definition, equivalentClass, deprecated, associated, broader }
}

// Full ancestor chain (nearest → root) via the direct-parent map; de-duplicated,
// breadth-first so nearer ancestors come first (used for graceful fallback).
function ancestorChain(subject: string, directParents: Map<string, string[]>): string[] {
  const chain: string[] = []
  const visited = new Set<string>()
  const queue = [...(directParents.get(subject) ?? [])]
  while (queue.length > 0) {
    const p = queue.shift()!
    if (!p || visited.has(p)) continue
    visited.add(p)
    chain.push(p)
    queue.push(...(directParents.get(p) ?? []))
  }
  return chain
}

// ─── Category inference ───────────────────────────────────────────────────────

const ROOT_CATEGORIES: Record<string, string> = {
  'brick:Equipment':  'Equipment',
  'brick:Point':      'Point',
  'brick:Location':   'Location',
  'brick:System':     'System',
  'brick:Collection': 'Collection',
  'rec:Space':        'Location',
  'rec:Architecture': 'Location',
  'rec:Zone':         'Location',
  'rec:Asset':        'Equipment',
}

function inferCategory(
  classKey: string,
  directParents: string[],
  allDirectParents: Map<string, string[]>
): string {
  const visited = new Set<string>()
  const queue = [...directParents]

  while (queue.length > 0) {
    const p = queue.shift()!
    if (!p || visited.has(p)) continue
    visited.add(p)
    if (ROOT_CATEGORIES[p]) return ROOT_CATEGORIES[p]
    queue.push(...(allDirectParents.get(p) ?? []))
  }

  // Fallback by class name keywords
  const name = classKey.toLowerCase()
  if (name.includes('sensor') || name.includes('setpoint') || name.includes('command') ||
      name.includes('status') || name.includes('alarm') || name.includes('meter')) return 'Point'
  if (name.includes('room') || name.includes('floor') || name.includes('building') ||
      name.includes('zone') || name.includes('site') || name.includes('space')) return 'Location'
  if (name.includes('system')) return 'System'
  return 'Other'
}

// ─── Search index ─────────────────────────────────────────────────────────────

function buildSearchIndex(
  classes: Record<string, ClassEntry>,
  blockTags: Map<string, string[]>
): Record<string, string[]> {
  const index: Record<string, string[]> = {}

  const addTerm = (term: string, classKey: string) => {
    const key = term.toLowerCase().replace(/[^a-z0-9]/g, '_')
    if (!key || key.length < 3) return
    if (!index[key]) index[key] = []
    if (!index[key].includes(classKey)) index[key].push(classKey)
  }

  for (const [classKey, entry] of Object.entries(classes)) {
    const local = classKey.split(':')[1] ?? ''
    for (const part of local.split('_').filter((p: string) => p.length > 2)) addTerm(part, classKey)
    addTerm(local, classKey)
    for (const word of entry.label.split(/\s+/)) addTerm(word, classKey)
    // Tags are kept out of lean ClassEntry but still enrich the search index
    for (const tag of (blockTags.get(classKey) ?? [])) addTerm(tag, classKey)
  }

  // Sort: brick: before rec:, then alphabetical
  for (const key of Object.keys(index)) {
    index[key].sort((a: string, b: string) => {
      if (a.startsWith('brick:') && !b.startsWith('brick:')) return -1
      if (!a.startsWith('brick:') && b.startsWith('brick:')) return 1
      return a.localeCompare(b)
    })
  }

  return index
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)

  if (args.length < 2) {
    console.error('Usage: npx ts-node tools/build-brick-classification-index.ts <ttl_path> <output_path>')
    console.error('Example: npx ts-node tools/build-brick-classification-index.ts ontologies/Brick_nightly.ttl ontologies/brick-classification-index.json')
    process.exit(1)
  }

  const ttlPath    = resolve(args[0])
  const outputPath = resolve(args[1])

  console.log(`Reading: ${ttlPath}`)
  const ttl = readFileSync(ttlPath, 'utf-8')
  console.log(`File size: ${(ttl.length / 1024 / 1024).toFixed(1)}MB`)

  const prefixes = parsePrefixes(ttl)
  console.log(`Prefixes found: ${Object.keys(prefixes).join(', ')}`)

  console.log('Parsing class blocks...')
  const blocks = parseBlocks(ttl)
  console.log(`Total blocks parsed: ${blocks.length}`)

  // Filter to brick: and rec: class declarations only, excluding deprecated
  const allClassBlocks = blocks.filter(b => {
    if (!b.subject.startsWith('brick:') && !b.subject.startsWith('rec:')) return false
    return b.types.some(t => t === 'rdfs:Class' || t === 'owl:Class' || t === 'sh:NodeShape')
  })
  const deprecatedCount = allClassBlocks.filter(b => b.deprecated).length
  const classBlocks = allClassBlocks.filter(b => !b.deprecated)
  console.log(`Class declarations: ${allClassBlocks.length} (${deprecatedCount} deprecated, excluded)`)

  // Build direct parent map (needed for category inference)
  const directParents = new Map<string, string[]>()
  for (const block of classBlocks) directParents.set(block.subject, block.subClassOf)

  // Build tag map — for search index only, not stored in lean ClassEntry
  const blockTags = new Map<string, string[]>()
  for (const block of classBlocks) {
    if (block.tags.length > 0) blockTags.set(block.subject, block.tags)
  }

  // Build class index — label/parent/category + enriched semantic fields
  const classes: Record<string, ClassEntry> = {}
  for (const block of classBlocks) {
    const label    = block.labels[0] ?? block.subject.split(':')[1].replace(/_/g, ' ')
    const category = inferCategory(block.subject, block.subClassOf, directParents)
    const tags     = [...new Set(block.tags)].sort()
    const parents  = ancestorChain(block.subject, directParents)
    classes[block.subject] = {
      label,
      parent:   block.subClassOf[0] ?? null,
      category,
      ...(block.definition         ? { definition: block.definition } : {}),
      ...(tags.length              ? { tags } : {}),
      ...(block.equivalentClass.length ? { equivalentClass: block.equivalentClass } : {}),
      ...(parents.length           ? { parents } : {}),
    }
  }

  // Build byCategory index
  const byCategory: Record<string, string[]> = {}
  for (const [classKey, entry] of Object.entries(classes)) {
    if (!byCategory[entry.category]) byCategory[entry.category] = []
    byCategory[entry.category].push(classKey)
  }
  for (const cat of Object.keys(byCategory)) byCategory[cat].sort()

  console.log('Building search index...')
  const search = buildSearchIndex(classes, blockTags)

  const tags: Record<string, TagEntry> = {}
  for (const block of blocks) {
    if (!block.subject.startsWith('tag:') || !block.types.includes('brick:Tag')) continue
    const name = block.subject.slice('tag:'.length)
    tags[name] = {
      label:   block.labels[0] ?? name,
      classes: [...new Set(block.associated)].filter(c => classes[c]).sort(),
    }
  }

  const substances: Record<string, SubstanceEntry> = {}
  for (const block of blocks) {
    if (!block.subject.startsWith('brick:') || !block.types.includes('brick:Substance') || block.deprecated) continue
    substances[block.subject] = {
      label: block.labels[0] ?? block.subject.split(':')[1].replace(/_/g, ' '),
      ...(block.definition ? { definition: block.definition } : {}),
      ...(block.broader    ? { broader: block.broader } : {}),
    }
  }

  const brickClasses = Object.keys(classes).filter(k => k.startsWith('brick:')).length
  const recClasses   = Object.keys(classes).filter(k => k.startsWith('rec:')).length

  const output: ClassificationIndex = {
    meta: {
      source:       basename(ttlPath),
      generatedAt:  new Date().toISOString(),
      totalClasses: Object.keys(classes).length,
      brickClasses,
      recClasses
    },
    prefixes: {
      brick: prefixes['brick'] ?? 'https://brickschema.org/schema/Brick#',
      rec:   prefixes['rec']   ?? 'https://w3id.org/rec#',
      ref:   prefixes['ref']   ?? 'https://brickschema.org/schema/Brick/ref#'
    },
    classes,
    byCategory,
    search,
    tags,
    substances
  }

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8')

  console.log('\n✓ brick-classification-index.json written')
  console.log(`  Total classes:  ${output.meta.totalClasses}`)
  console.log(`  brick: classes: ${brickClasses}`)
  console.log(`  rec:   classes: ${recClasses}`)
  console.log('\nCategories:')
  for (const [cat, list] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(12)} ${list.length}`)
  }
  console.log(`\nSearch terms: ${Object.keys(search).length}`)
  console.log(`Tags:         ${Object.keys(tags).length}`)
  console.log(`Substances:   ${Object.keys(substances).length}`)
  console.log(`\nOutput: ${outputPath}`)
  console.log(`Output size: ~${(JSON.stringify(output).length / 1024).toFixed(0)}KB`)
}

main()
