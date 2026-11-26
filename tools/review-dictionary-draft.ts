// tools/review-dictionary-draft.ts
//
// Read-only review of data/{b}/point-dictionary.draft.json (HITL touchpoint 2).
//
// Usage (npx ts-node tools/review-dictionary-draft.ts ...):
//   <b> [--exclude <b,...>] [--check-only] [--classes <dir>] [--equipment <inputsDir>] [--word-min <n>]
//
//   --exclude      buildings left out of the cross-building notes (e.g. a legacy copy of this building)
//   --check-only   print only the doc-vs-data contradictions (Moment 3); exit 1 while there are any
//   --classes <d>  K8: <d> holds plant-point-mapping.json / zone-point-mapping.json made with the staged
//                  draft. Every point there that carries `tags` is compared with the Brick tags of the same
//                  bmsPointId's brickClass in this building's REAL mapping files (data/<b>/inputs): role,
//                  quantity, medium and direction (stream tags) mismatches, reviewedManually points first.
//                  A dimension is compared when the staged tags have a tag in it. Staged Supply covers a
//                  class's Discharge tag.
//   --equipment <d> <d> holds the mapping files and equipment-inventory.json; the points come from there
//                  (with their image ductPath) and the stream check runs. Without it the points come from
//                  data/<b>/inputs's mapping files and the stream check is skipped.
//   --word-min <n>  word discovery's threshold (default 5)
//
// The draft is in the one shape (schemaVersion 3; older draft shapes are not supported).
// It also gets word discovery, grammar samples, coverage per point, word clashes
// (one at a time), suffix-vs-description roles and the stream check, all from the classifier's own combiner.
//
// Exit 1 while one-at-a-time items, data-only items or missing or open records remain, frequent uncovered
// words, or points with neither role nor quantity.

import * as fs from "fs";
import * as path from "path";
import { dataRoot, loadProfile } from "./lib/building-profile";
import { loadDataPoints, loadPointInputs } from "./lib/dictionary-data";
import { draftEntries, readDraft } from "./lib/dictionary-draft";
import { capLines, legendIssues, reviewDraft, STREAM_TAGS, v3OpenLines, WORD_MIN } from "./lib/dictionary-review";
import type { Item, LegendIssue, V3Sections } from "./lib/dictionary-review";
import type { PointInput } from "./lib/point-parts";
import { MEDIUM_TAGS, QUANTITY_TAGS, ROLE_TAGS } from "./lib/point-dictionary";
import { classTags } from "./lib/tag-match";

function fail(msg: string): never {
  throw new Error(msg);
}

function parseFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  return v;
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function otherDictionaries(b: string, exclude: string[]): Array<{ buildingId: string; dict: any }> {
  const root = dataRoot();
  const out: Array<{ buildingId: string; dict: any }> = [];
  for (const name of fs.readdirSync(root)) {
    if (name === b || exclude.includes(name)) continue;
    const f = path.join(root, name, "point-dictionary.json");
    if (fs.existsSync(f)) out.push({ buildingId: name, dict: readJson(f) });
  }
  return out;
}

const DIMENSIONS: Array<[string, string[]]> = [
  ["role", ROLE_TAGS],
  ["quantity", QUANTITY_TAGS],
  ["medium", MEDIUM_TAGS],
  ["direction", STREAM_TAGS],
];

/** The class's tags of one dimension, as compared with the staged ones. Direction: staged Supply covers
 * Discharge (Brick's supply classes carry both tags; the dictionary uses Supply only), never the reverse. */
function classSide(dim: string, mine: string[], theirs: string[]): string[] {
  if (dim !== "direction" || !mine.includes("Supply")) return theirs;
  return [...new Set(theirs.map((t) => (t === "Discharge" ? "Supply" : t)))];
}

interface RealPoint {
  brickClass?: string;
  reviewedManually?: boolean;
}

function mappingPoints(dir: string): Map<string, any> {
  const out = new Map<string, any>();
  for (const file of ["plant-point-mapping.json", "zone-point-mapping.json"]) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const data = readJson(p);
    for (const g of [...(data.plants ?? []), ...(data.zones ?? []), ...(data.devices ?? [])]) for (const pt of g.points ?? []) out.set(pt.bmsPointId, pt);
  }
  return out;
}

/** K8: staged tags against the Brick tags of the real class, by dimension. reviewedManually first.
 * `compared` counts the staged points that carry tags and have a real class. */
function classMismatches(b: string, stagedDir: string): { lines: string[]; compared: number } {
  const files = ["plant-point-mapping.json", "zone-point-mapping.json"];
  if (!files.some((f) => fs.existsSync(path.join(stagedDir, f)))) fail(`--classes ${stagedDir}: neither ${files.join(" nor ")} found there`);
  const idx = readJson(path.resolve(__dirname, "..", "ontologies", "brick-classification-index.json"));
  const staged = mappingPoints(stagedDir);
  const real = mappingPoints(path.join(dataRoot(), b, "inputs"));
  const manual: string[] = [];
  const rest: string[] = [];
  let compared = 0;
  for (const [id, pt] of staged) {
    if (!Array.isArray(pt.tags)) continue;
    const r: RealPoint | undefined = real.get(id);
    if (!r?.brickClass) continue;
    compared++;
    const brick = classTags(idx, r.brickClass);
    for (const [dim, tags] of DIMENSIONS) {
      const mine = pt.tags.filter((t: string) => tags.includes(t));
      if (mine.length === 0) continue;
      const theirs = [...brick].filter((t) => tags.includes(t));
      const cmp = classSide(dim, mine, theirs);
      if (mine.length === cmp.length && mine.every((t: string) => cmp.includes(t))) continue;
      const line = `${id}: ${dim} [${mine.join(", ")}] vs ${r.brickClass} [${theirs.join(", ")}]${r.reviewedManually ? " (reviewedManually)" : ""}`;
      (r.reviewedManually ? manual : rest).push(line);
    }
  }
  return { lines: [...manual, ...rest], compared };
}

function printItems(title: string, items: Item[]): void {
  console.log(`\n${title}: ${items.length}`);
  for (const it of items) {
    console.log(`  [${it.reason}] ${it.path}`);
    for (const n of it.notes) console.log(`      - ${n}`);
  }
}

/** R13: the legend records that fail K2 (open, invalid disposition, bad entry: target) as ONE table
 * (row, text, disposition, note); records with an empty/invalid disposition or a failing entry: target
 * come first. Returns the number of records listed. */
function printLegendTable(draft: any): number {
  const byRecord = new Map<number, LegendIssue[]>();
  for (const x of legendIssues(draft)) byRecord.set(x.index, [...(byRecord.get(x.index) ?? []), x]);
  const rows = [...byRecord.values()].sort((x, y) => Number(y.some((i) => i.bad)) - Number(x.some((i) => i.bad)));
  console.log(`\nOpen legend records: ${rows.length}`);
  if (rows.length === 0) return 0;
  const cell = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").replace(/\|/g, "/");
  console.log("| row | text | disposition | note |");
  console.log("| --- | --- | --- | --- |");
  for (const g of rows) console.log(`| ${cell(g[0].row)} | ${cell(g[0].text)} | ${cell(g[0].disposition)} | ${cell(g.map((i) => i.note).join("; "))} |`);
  return rows.length;
}

function main(argv: string[]): void {
  const b = argv[0];
  if (!b || b.startsWith("--")) fail("usage: <b> [--exclude <b,...>] [--check-only] [--classes <dir>] [--equipment <inputsDir>] [--word-min <n>]");
  const known = ["--exclude", "--check-only", "--classes", "--equipment", "--word-min"];
  const flags = argv.slice(1).filter((a) => a.startsWith("--"));
  for (const a of flags) if (!known.includes(a)) fail(`unknown flag ${a} (known: ${known.join(", ")})`);
  if (flags.includes("--check-only") && flags.includes("--classes")) fail("--classes cannot be combined with --check-only");
  const exclude = (parseFlag(argv, "exclude") ?? "").split(",").filter((x) => x !== "");
  const classesDir = parseFlag(argv, "classes");
  const checkOnly = argv.includes("--check-only");
  const equipmentDir = parseFlag(argv, "equipment");
  const wordMinText = parseFlag(argv, "word-min");
  const wordMin = wordMinText === undefined ? WORD_MIN : Number(wordMinText);
  if (!Number.isInteger(wordMin) || wordMin < 1) fail(`--word-min must be a positive integer (got "${wordMinText}")`);

  loadProfile(b);
  const draft = readDraft(b);
  if ((draft as any).schemaVersion !== 3) fail(`${b}: the draft is not in the one shape (schemaVersion 3); older draft shapes are not supported`);
  const currentFile = path.join(dataRoot(), b, "point-dictionary.json");
  const current = fs.existsSync(currentFile) ? readJson(currentFile) : {};
  // The points as the classifier sees them, from the mapping files (and, with --equipment, that
  // directory's equipment inventory for the image ductPath).
  const inputs = loadPointInputs(b, equipmentDir, equipmentDir !== undefined);
  if (inputs === null && equipmentDir !== undefined) fail(`--equipment ${equipmentDir}: neither plant-point-mapping.json nor zone-point-mapping.json found there`);
  const pointInputs: PointInput[] | undefined = inputs ?? undefined;
  const report = reviewDraft({
    draft, current, others: otherDictionaries(b, exclude), points: loadDataPoints(b),
    pointInputs, withDuctPaths: equipmentDir !== undefined, wordMin,
  });

  const contradictions = report.oneAtATime.filter((i) => i.reason === "contradiction");
  if (checkOnly) {
    printItems("Contradictions", contradictions);
    if (contradictions.length) process.exitCode = 1;
    return;
  }

  printItems("One at a time", report.oneAtATime);
  const otherAccounting = report.accounting.filter((l) => !l.startsWith("K2:"));
  console.log(`\nMissing or open records: ${otherAccounting.length}`);
  for (const l of capLines(otherAccounting)) console.log(`  - ${l}`);
  printLegendTable(draft);
  printItems("Data-only (confirm all, or name rows to change)", report.dataOnly);
  console.log(`\nAgrees: ${report.agrees.length}`);
  // a count only, except the entries that carry a cross-building note
  for (const it of report.agrees.filter((i) => i.notes.some((n) => !n.startsWith("note: ")))) {
    console.log(`  [agrees, note] ${it.path}`);
    for (const n of it.notes) console.log(`      - ${n}`);
  }
  console.log(`Already confirmed/changed (not listed): ${draftEntries(draft).filter((e) => e.entry.status === "confirmed" || e.entry.status === "changed").length}`);
  if (report.info.length) {
    console.log(`\nInfo: ${report.info.length}`);
    for (const l of report.info) console.log(`  - ${l}`);
  }
  if (classesDir) {
    const { lines, compared } = classMismatches(b, classesDir);
    console.log(`\nClass cross-check (K8): ${lines.length} mismatch(es), compared ${compared} point(s)`);
    for (const l of capLines(lines)) console.log(`  - ${l}`);
  }
  if (report.v3) printPartsSections(report.v3, b, equipmentDir);
  if (report.oneAtATime.length || report.dataOnly.length || report.accounting.length || v3OpenLines(report).length) process.exitCode = 1;
}

/** The one shape's parts sections. Open: frequent uncovered words and points with neither role nor
 * quantity (word clashes are printed under "One at a time"). */
function printPartsSections(s: V3Sections, b: string, equipmentDir: string | undefined): void {
  const words = (w: { word: string; count: number; samples: string[] }) => `"${w.word}" (${w.count}): e.g. ${w.samples.join(", ")}`;
  console.log(`\nWord discovery${s.skipped ? " (from the point list / object files: no mapping files yet)" : ""}: ${s.wordDiscovery.length} distinct word(s), ${s.wordDiscovery.filter((w) => w.count >= s.wordMin).length} occur ${s.wordMin}+ times, ${s.uncoveredWords.length} of those not covered (open)`);
  for (const w of s.uncoveredWords) console.log(`  - [open] ${words(w)}`);
  for (const w of s.wordDiscovery.filter((x) => !s.uncoveredWords.includes(x))) console.log(`  - ${w.covered ? "[covered] " : ""}${words(w)}`);
  if (s.skipped) {
    console.log(`\nGrammar samples, coverage, suffix vs description, word clashes: skipped (no plant-point-mapping.json or zone-point-mapping.json in ${path.join(dataRoot(), b, "inputs")}; give --equipment <inputsDir>)`);
    console.log("Stream check: skipped (no point inputs)");
    return;
  }

  const g = s.grammarSamples;
  console.log(`\nGrammar samples: ${g.tokens.length} token(s), ${g.suffixes.length} suffix part(s), ${g.letters.length} trailing letter(s)`);
  for (const t of g.tokens) {
    console.log(`  token ${t.token}: ${t.count} point(s)`);
    for (const x of t.samples) console.log(`      - ${x}`);
  }
  if (g.suffixes.length) console.log(`  suffix parts: ${g.suffixes.map((x) => `${x.part} (${x.count})`).join(" · ")}`);
  if (g.letters.length) console.log(`  trailing letters: ${g.letters.map((x) => `${x.letter} (${x.count})`).join(" · ")}`);

  const c = s.coverage;
  console.log(`\nCoverage: ${c.noRoleNoQuantity.length} point(s) with neither role nor quantity (open), ${c.roleFallback.length} with only the role fallback (information)`);
  for (const x of capLines(c.noRoleNoQuantity.map((p) => `[open] ${p.id} ${p.description.trim() === "" ? "(empty)" : `"${p.description}"`}`))) console.log(`  - ${x}`);
  if (c.roleFallback.length) console.log(`  role fallback: ${c.roleFallback.slice(0, 20).join(", ")}${c.roleFallback.length > 20 ? `, ... and ${c.roleFallback.length - 20} more` : ""}`);

  console.log(`\nSuffix vs description roles (information): ${s.suffixVsDescription.length}`);
  for (const l of capLines(s.suffixVsDescription)) console.log(`  - ${l}`);

  if (!s.streamCheck) {
    console.log(`\nStream check: skipped (give --equipment <inputsDir> with the mapping and equipment-inventory.json files)`);
    return;
  }
  console.log(`\nStream check: ${s.streamCheck.entrySpread.length} entr(ies) whose points span ductPaths, ${s.streamCheck.pointDisagrees.length} point(s) whose ductPath disagrees with a description stream word (information; ${equipmentDir})`);
  for (const l of capLines(s.streamCheck.entrySpread)) console.log(`  - ${l}`);
  for (const l of capLines(s.streamCheck.pointDisagrees)) console.log(`  - ${l}`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
