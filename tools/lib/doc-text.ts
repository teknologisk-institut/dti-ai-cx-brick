// tools/lib/doc-text.ts
//
// Shared document-text extraction (moved out of search-supporting-docs.ts) and a quote check
// used by dictionary validation to verify a cited quote really appears in a document.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { extname, join, relative, dirname } from 'path'
import { execFileSync } from 'child_process'
import { dataRoot } from './building-profile'

export interface DocText { status: 'ok' | 'unreadable' | 'unsupported'; text: string }

// A cached text containing U+FFFD was made by an older extraction that read Latin-1 output as UTF-8
// (every æ/ø/å became U+FFFD); it is stale and gets re-extracted.
export function isStaleCache(text: string): boolean {
  return text.includes(String.fromCharCode(0xfffd))
}

// CSV/JSON are read raw; PDFs go through `pdftotext -enc UTF-8 -layout`, cached under cacheDir (normally
// docs-unsorted/.text-cache/) keyed by the path relative to cacheDir's parent, '/' -> '__'.
export function extractDocText(absPath: string, cacheDir: string): DocText {
  const ext = extname(absPath).toLowerCase()
  if (ext === '.csv' || ext === '.json') return { status: 'ok', text: readFileSync(absPath, 'utf-8') }
  if (ext !== '.pdf') return { status: 'unsupported', text: '' }

  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  const relPath = relative(dirname(cacheDir), absPath).split('\\').join('/')
  const cachePath = join(cacheDir, `${relPath.split('/').join('__')}.txt`)
  let text = ''
  const cached = existsSync(cachePath) ? readFileSync(cachePath, 'utf-8') : null
  if (cached !== null && !isStaleCache(cached)) {
    text = cached
  } else {
    try {
      text = execFileSync('pdftotext', ['-enc', 'UTF-8', '-layout', absPath, '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
      // Only cache successful extractions -- a transient failure, a maxBuffer overrun, or
      // pdftotext simply not being on PATH must never be permanently recorded as "unreadable"
      // (indistinguishable from a genuinely scanned PDF with no text layer). A failed
      // extraction still classifies as unreadable for THIS run, just isn't cached.
      writeFileSync(cachePath, text, 'utf-8')
    } catch {
      text = '' // also for a stale cache: corrupted text must not satisfy a quote; the stale file is left as is
    }
  }
  if (text.trim().length < 20) return { status: 'unreadable', text: '' }
  return { status: 'ok', text }
}

function normalise(s: string): string {
  return s.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim()
}

// `file` is relative to data/{buildingId}/.
export function quoteStatus(buildingId: string, file: string, quote: string): 'found' | 'missing' | 'unreadable' | 'no-file' {
  const buildingDir = join(dataRoot(), buildingId)
  const abs = join(buildingDir, file)
  if (!existsSync(abs)) return 'no-file'
  const doc = extractDocText(abs, join(buildingDir, 'docs-unsorted', '.text-cache'))
  if (doc.status !== 'ok') return 'unreadable'
  return normalise(doc.text).includes(normalise(quote)) ? 'found' : 'missing'
}
