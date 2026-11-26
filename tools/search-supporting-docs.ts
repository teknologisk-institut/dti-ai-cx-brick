// tools/search-supporting-docs.ts
//
// Searches data/{buildingId}/docs-unsorted/ for a token or keyword, returning matching
// snippets with a source citation (file + line/row) -- never a full document dump, to keep
// context bounded across the dozens of tokens a building may need resolved. Used by HITL
// touchpoint 2 -- see point-mapping/SKILL.md.
//
//   npx ts-node tools/search-supporting-docs.ts <buildingId> <query>
//
// Handles: CSV (grepped row by row), JSON (grepped line by line over the raw text), PDF with
// a text layer (pdftotext -layout, cached under docs-unsorted/.text-cache/ so repeated queries
// across many tokens don't re-extract the same file). A PDF yielding near-zero extractable text
// is reported "unreadable" (scanned, no text layer) -- distinct from "no match"; this project's
// existing rule (never conclude something is absent from an unreadable source) applies here the
// same as it does to BMS images. XLSX and any other file type are reported "unsupported", not
// silently skipped -- no XLSX-parsing library exists in this repo; add support only if a real
// XLSX-only file (no CSV/other equivalent) ever appears.
//
// Recurses into subfolders -- docs-unsorted/ can have real subfolder structure (e.g. a
// building's function-description folder, often the single most useful resource for this tool,
// lives one level down; a non-recursive first draft of this tool was caught missing such a
// folder entirely during planning, before this file existed).

import { existsSync, readdirSync } from 'fs'
import { extname, join, relative, resolve } from 'path'
import { extractDocText } from './lib/doc-text'

const buildingId = process.argv[2]
const query = process.argv[3]
if (!buildingId || !query) {
  console.error('Usage: npx ts-node tools/search-supporting-docs.ts <buildingId> <query>')
  process.exit(1)
}

const docsDir = resolve(__dirname, '..', 'data', buildingId, 'docs-unsorted')
if (!existsSync(docsDir)) {
  console.log(`No docs-unsorted for ${buildingId} -- nothing to search.`)
  process.exit(0)
}

interface Match { file: string; location: string; text: string }
const matches: Match[] = []
const unreadable: string[] = []
const unsupported: string[] = []
const needle = query.toLowerCase()

function searchLines(file: string, text: string, locationPrefix: string) {
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.toLowerCase().includes(needle)) {
      matches.push({ file, location: `${locationPrefix}${i + 1}`, text: line.trim() })
    }
  })
}

// Collect every file under docsDir, recursing into subfolders, skipping the tool's own cache.
function collectFiles(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.text-cache') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

const cacheDir = join(docsDir, '.text-cache')
const allFiles: string[] = []
collectFiles(docsDir, allFiles)

for (const filePath of allFiles) {
  const relPath = relative(docsDir, filePath).split('\\').join('/') // citation-friendly, forward-slash
  const ext = extname(filePath).toLowerCase()

  const doc = extractDocText(filePath, cacheDir)
  if (doc.status === 'unsupported') {
    unsupported.push(relPath)
  } else if (doc.status === 'unreadable') {
    unreadable.push(relPath)
  } else {
    searchLines(relPath, doc.text, ext === '.csv' ? 'row ' : 'line ')
  }
}

// Printing is capped to keep context bounded -- the underlying search/categorization above is
// exhaustive and unchanged; only how much of it gets echoed to the console is limited here.
const MATCH_PRINT_LIMIT = 50
const LIST_PRINT_LIMIT = 15

function printCappedList(label: string, items: string[]) {
  if (items.length === 0) return
  if (items.length <= LIST_PRINT_LIMIT) {
    console.log(`  ${label}: ${items.join(', ')}`)
  } else {
    const shown = items.slice(0, LIST_PRINT_LIMIT)
    console.log(`  ${label} (${items.length} total, showing ${LIST_PRINT_LIMIT}): ${shown.join(', ')} … ${items.length - LIST_PRINT_LIMIT} more suppressed`)
  }
}

console.log(`Search "${query}" in data/${buildingId}/docs-unsorted/:`)
if (matches.length === 0) {
  console.log('  No matches.')
} else {
  const shown = matches.slice(0, MATCH_PRINT_LIMIT)
  for (const m of shown) console.log(`  [${m.file}:${m.location}] ${m.text}`)
  if (matches.length > MATCH_PRINT_LIMIT) {
    console.log(`  … ${matches.length - MATCH_PRINT_LIMIT} more matches suppressed — narrow the query`)
  }
}
printCappedList('Unreadable (near-zero extractable text, likely scanned)', unreadable)
printCappedList('Unsupported file type, skipped (not silently ignored)', unsupported)
