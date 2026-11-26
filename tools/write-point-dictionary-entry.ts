// tools/write-point-dictionary-entry.ts
//
// The dictionary's only write path (HITL touchpoint 2 and the agent's drafting). Everything goes
// through data/{b}/point-dictionary.draft.json; `promote` validates it and writes
// data/{b}/point-dictionary.json.
//
// Usage (npx ts-node tools/write-point-dictionary-entry.ts ...):
//   init <b> --full|--gaps [--force]     start a draft from the current dictionary (its ignored-word
//                                        records come back proposed / confirmed)
//   set <b> <path> [--insert <i>]        entry JSON on stdin (status defaults to proposed)
//   set-batch <b>                        stdin: [{ path, entry, insert? }, ...]; all or nothing
//   status <b> <path> [<path> ...] confirmed|changed
//                                        path may be accounting.legend[<i>] / accounting.removed[<i>]; all or nothing
//   account <b> legend <file> <row> <disposition> [--note <t>]
//   account <b> removed <path> --reason <t>
//   account <b> ignored-word <word> --reason <t>
//                                        word discovery (one shape): a description word that carries no part
//   remove <b> <path>                    delete a draft entry (account a removed current entry separately)
//   promote <b> [--equipment <inputsDir>]   strict-validate and write point-dictionary.json (keeps the
//                                        ignored-word records as accounting.ignoredWords { word, reason })
//   --validate <b> [--equipment <inputsDir>]   strict-validate the dictionary (and the draft, if any)
//     --equipment <d> (one shape): the mapping files for the open-item and "decided by" checks come from <d>
//     instead of data/<b>/inputs (for mapping files older than the current mapper); one line says which.
//
// The dictionary and its draft are in the one shape (schemaVersion 3; older draft shapes are not
// supported). Paths: tokens.<zone|plant|any>.TR, suffixes[0], words[0], units.°C,
// overrides.ID, plantTokens.VE, plantOverrides.ID, meterReadings, meterReadings.readings.ENERGY,
// notEquipment, equipmentIdRules[0]. Promote also refuses while the review has a word clash, a frequent
// uncovered word or a point with neither role nor quantity; the promoted file keeps schemaVersion 3.

import * as fs from "fs";
import * as path from "path";
import { dataRoot, loadProfile } from "./lib/building-profile";
import type { BuildingProfile } from "./lib/building-profile";
import { validatePartsDictionary, validateStrict } from "./lib/point-dictionary";
import { readCsvRows } from "./lib/bacnet-objects";
import { draftPath, readDraft, writeDraft, getAt, setAt, draftEntries, openItems, stripDraft } from "./lib/dictionary-draft";
import type { Draft, DraftStatus } from "./lib/dictionary-draft";
import { capLines, DISPOSITIONS, reviewDraft, v3OpenLines } from "./lib/dictionary-review";
import { loadDataPoints, loadPointInputs } from "./lib/dictionary-data";

const STATUSES = ["proposed", "confirmed", "changed"];

function fail(msg: string): never {
  throw new Error(msg);
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dictionaryFile(b: string): string {
  return path.join(dataRoot(), b, "point-dictionary.json");
}

function parseFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function parseJson(text: string, what: string): any {
  if (text.trim() === "") fail(`${what}: no JSON on stdin`);
  try {
    return JSON.parse(text);
  } catch (e) {
    return fail(`${what}: stdin is not valid JSON: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const KEY = "[^.\\[\\]]+";
const V3_PATHS = [
  new RegExp(`^tokens\\.(zone|plant|any)\\.${KEY}$`),
  /^(suffixes|words|equipmentIdRules)(\[\d+\])?$/,
  new RegExp(`^(units|overrides|plantTokens|plantOverrides)\\.${KEY}$`),
  /^meterReadings$/,
  new RegExp(`^meterReadings\\.readings\\.${KEY}$`),
  /^notEquipment$/,
];

/** An error message when the draft is not in the one shape (schemaVersion 3) or `p` is not one of its
 * entry paths, else null. */
function pathError(p: string, d: Draft): string | null {
  if ((d as any).schemaVersion !== 3) return `the draft is not in the one shape (schemaVersion 3); older draft shapes are not supported`;
  if (V3_PATHS.some((re) => re.test(p))) return null;
  return `"${p}" is not an entry path of the one shape (schemaVersion 3) (e.g. tokens.zone.TR, tokens.any.TR, suffixes[0], words[2], units.°C, overrides.<id>, plantTokens.VE, plantOverrides.<id>, meterReadings.readings.<reading>, notEquipment, equipmentIdRules[0])`;
}

// ---------------------------------------------------------------------------
// set / set-batch
// ---------------------------------------------------------------------------

interface SetItem {
  path: string;
  entry: unknown;
  insert?: number;
}

/** Applies one item to a copy of the draft. Returns the new draft, or the errors (nothing changes). */
function applyItem(d: Draft, item: SetItem): { draft?: Draft; errors: string[] } {
  const p = item?.path;
  if (typeof p !== "string" || p === "") return { errors: ["item has no path"] };
  const pe = pathError(p, d);
  if (pe) return { errors: [pe] };
  if (!isObj(item.entry)) return { errors: [`${p}: entry must be a JSON object`] };
  if (item.insert !== undefined && (!Number.isInteger(item.insert) || item.insert < 0)) {
    return { errors: [`${p}: insert must be a non-negative integer`] };
  }
  const entry: Record<string, any> = { ...item.entry };
  if (entry.status === undefined) entry.status = "proposed";
  if (!STATUSES.includes(entry.status)) return { errors: [`${p}: status must be one of ${STATUSES.join(", ")}`] };
  if (entry.review !== undefined) {
    const r = entry.review;
    if (!isObj(r) || (r.docVsData !== undefined && !["agree", "contradict", "n/a"].includes(r.docVsData)) || (r.note !== undefined && typeof r.note !== "string") || (r.flag !== undefined && typeof r.flag !== "boolean")) {
      return { errors: [`${p}: review must be { docVsData?: "agree"|"contradict"|"n/a", note?: string, flag?: boolean }`] };
    }
  }

  const next: Draft = JSON.parse(JSON.stringify(d));
  let written: string;
  try {
    written = setAt(next, p, entry, item.insert);
  } catch (e) {
    return { errors: [(e as Error).message] };
  }
  // Structural check of the whole result, keeping only the errors that belong to the written entry.
  const structural = validatePartsDictionary(stripDraft(next));
  const errors = structural.filter((m) => {
    const lead = m.split(" ")[0];
    return m.includes(written) || written.startsWith(lead);
  });
  return errors.length ? { errors: errors.map((m) => `${written}: ${m}`) } : { draft: next, errors: [] };
}

/** M9: the legend records whose `entry:<section>[i]` disposition has i >= from, i.e. an entry of that array
 * section that moved (or went) after a remove / insert. Listed as one warning line, never rewritten. */
function shiftedLegendWarning(d: Draft, section: string, from: number): string | null {
  const prefix = `entry:${section}[`;
  const indexOf = (disp: unknown): number => (typeof disp === "string" && disp.startsWith(prefix) && /^\d+\]$/.test(disp.slice(prefix.length)) ? Number(disp.slice(prefix.length, -1)) : -1);
  const hits = d.accounting.legend
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => indexOf(r.disposition) >= from);
  if (hits.length === 0) return null;
  return `warning: ${hits.length} legend record(s) point at entries of ${section} that moved (not rewritten, check them): ` +
    hits.map(({ r, i }) => `accounting.legend[${i}] (${r.file} row ${r.row}: ${r.disposition})`).join("; ");
}

function cmdSet(b: string, argv: string[]): void {
  const p = argv[2];
  if (!p) fail("usage: set <b> <path> [--insert <i>]  (entry JSON on stdin)");
  const insertText = parseFlag(argv, "insert");
  const insert = insertText === undefined ? undefined : Number(insertText);
  if (insertText !== undefined && !Number.isInteger(insert)) fail(`--insert must be an integer (got "${insertText}")`);
  const d = readDraft(b);
  const entry = parseJson(readStdin(), p);
  const r = applyItem(d, { path: p, entry, insert });
  if (!r.draft) fail(r.errors.join("\n"));
  writeDraft(b, r.draft);
  console.log(`Set ${p}${insert !== undefined ? ` (inserted at ${insert})` : ""} in ${draftPath(b)}.`);
  const warn = insert === undefined ? null : shiftedLegendWarning(r.draft, p, insert);
  if (warn) console.log(warn);
}

function cmdSetBatch(b: string): void {
  let d = readDraft(b);
  const items = parseJson(readStdin(), "set-batch");
  if (!Array.isArray(items)) fail("set-batch: stdin must be a JSON array of { path, entry, insert? }");
  const errors: string[] = [];
  items.forEach((item: any, i: number) => {
    const r = applyItem(d, item);
    if (r.draft) d = r.draft;
    else for (const m of r.errors) errors.push(`item ${i}${typeof item?.path === "string" ? ` (${item.path})` : ""}: ${m}`);
  });
  if (errors.length) fail(`set-batch refused, nothing written (${errors.length} problem(s)):\n  - ${errors.join("\n  - ")}`);
  writeDraft(b, d);
  console.log(`Set ${items.length} entries in ${draftPath(b)}.`);
}

// ---------------------------------------------------------------------------
// status / account
// ---------------------------------------------------------------------------

function cmdStatus(b: string, argv: string[]): void {
  const paths = argv.slice(2, -1);
  const value = argv[argv.length - 1];
  if (paths.length === 0 || !value) fail("usage: status <b> <path> [<path> ...] confirmed|changed");
  if (value !== "confirmed" && value !== "changed") fail(`status must be confirmed or changed (got "${value}")`);
  const d = readDraft(b);
  const entryPaths = new Set(draftEntries(d).map((e) => e.path));
  // all or nothing: every path is checked before anything is written
  const RECORD = /^accounting\.(legend|removed|ignoredWords)\[\d+\]$/;
  const targets = paths.map((p) => {
    const isRecord = RECORD.test(p);
    const target = getAt(d, p);
    if ((!isRecord && !entryPaths.has(p)) || !isObj(target)) {
      fail(`${p} is not a draft entry or an accounting record (entry paths: tokens.zone.TR, suffixes[0], words[0], ...; records: accounting.legend[<i>], accounting.removed[<i>], accounting.ignoredWords[<i>])`);
    }
    return target;
  });
  if (value === "changed") {
    // a change is a human decision: the entry must carry the human's answer
    paths.forEach((p, i) => {
      const isRecord = RECORD.test(p);
      const ev: any[] = Array.isArray(targets[i].evidence) ? targets[i].evidence : [];
      if (!isRecord && !ev.some((e) => e?.kind === "human")) fail(`${p}: status changed needs human evidence on the entry (add a { kind: "human", answer, date } item first)`);
    });
  }
  for (const t of targets) t.status = value as DraftStatus;
  writeDraft(b, d);
  console.log(paths.length === 1 ? `${paths[0]} -> ${value}` : `${paths.length} paths -> ${value}`);
}

/** Deletes one draft entry: an object key, or an array element (later elements move up). A current entry
 * that disappears this way still needs `account removed` (K1). */
function cmdRemove(b: string, argv: string[]): void {
  const p = argv[2];
  if (!p) fail("usage: remove <b> <path>");
  const d = readDraft(b);
  if (!draftEntries(d).some((e) => e.path === p)) fail(`${p} is not a draft entry`);
  const m = /^(.*)\[(\d+)\]$/.exec(p);
  let warn: string | null = null;
  if (m) {
    getAt(d, m[1]).splice(Number(m[2]), 1);
    warn = shiftedLegendWarning(d, m[1], Number(m[2]));
  } else {
    const dot = p.lastIndexOf(".");
    delete getAt(d, p.slice(0, dot))[p.slice(dot + 1)];
  }
  writeDraft(b, d);
  console.log(`Removed ${p} from ${draftPath(b)}.`);
  if (warn) console.log(warn);
}

function legendText(b: string, file: string, row: number): string {
  const abs = path.join(dataRoot(), b, file);
  if (!fs.existsSync(abs)) return "";
  const lines = fs.readFileSync(abs, "utf-8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  return (lines[row - 1] ?? "").trim();
}

function cmdAccount(b: string, argv: string[]): void {
  const kind = argv[2];
  const d = readDraft(b);
  if (kind === "legend") {
    const [file, rowText, disposition] = argv.slice(3);
    if (!file || !rowText || !disposition) fail("usage: account <b> legend <file> <row> <disposition> [--note <t>]");
    const row = Number(rowText);
    if (!Number.isInteger(row) || row < 1) fail(`row must be a positive integer (got "${rowText}")`);
    if (!DISPOSITIONS.test(disposition)) {
      fail(`disposition must be entry:<path>, plant-id, point-id, meter-id, wildcard, not-in-data or not-a-token (got "${disposition}")`);
    }
    if (disposition.startsWith("entry:") && getAt(d, disposition.slice(6)) === undefined) {
      console.error(`warning: ${disposition.slice(6)} does not exist in the draft yet`);
    }
    const note = parseFlag(argv, "note");
    let rec = d.accounting.legend.find((r) => r.file === file && r.row === row);
    if (!rec) {
      rec = { file, row, text: legendText(b, file, row), disposition, status: "proposed" };
      d.accounting.legend.push(rec);
    }
    rec.disposition = disposition;
    if (note !== undefined) rec.note = note;
    rec.status = "proposed";
    writeDraft(b, d);
    console.log(`legend ${file} row ${row} -> ${disposition} (proposed)`);
  } else if (kind === "removed") {
    const p = argv[3];
    const reason = parseFlag(argv, "reason");
    if (!p || !reason) fail("usage: account <b> removed <path> --reason <t>");
    let rec = d.accounting.removed.find((r) => r.path === p);
    if (!rec) {
      rec = { path: p, reason, status: "proposed" };
      d.accounting.removed.push(rec);
    }
    rec.reason = reason;
    rec.status = "proposed";
    writeDraft(b, d);
    console.log(`removed ${p} (proposed)`);
  } else if (kind === "ignored-word") {
    // word discovery: a description word that carries no part (stored lower-cased, as discovery lists it)
    const word = (argv[3] ?? "").trim().toLowerCase();
    const reason = parseFlag(argv, "reason");
    if (word === "" || word.startsWith("--") || !reason) fail("usage: account <b> ignored-word <word> --reason <t>");
    if (!/^\p{L}+$/u.test(word)) fail(`ignored-word must be one word of letters only, as word discovery lists it (got "${word}")`);
    d.accounting.ignoredWords ??= [];
    let rec = d.accounting.ignoredWords.find((r) => r.word === word);
    if (!rec) {
      rec = { word, reason, status: "proposed" };
      d.accounting.ignoredWords.push(rec);
    }
    rec.reason = reason;
    rec.status = "proposed";
    writeDraft(b, d);
    console.log(`ignored word "${word}" (proposed)`);
  } else fail("usage: account <b> legend|removed|ignored-word ...");
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const EMPTY_DICTIONARY = { schemaVersion: 3, tokens: {}, suffixes: [], words: [], units: {}, overrides: {}, plantTokens: {}, plantOverrides: {} };

function docFiles(profile: BuildingProfile): string[] {
  const a = profile.inputs.docs?.abbreviations;
  return a === undefined ? [] : Array.isArray(a) ? a : [a];
}

function cmdInit(b: string, argv: string[]): void {
  const mode = argv.includes("--full") ? "full" : argv.includes("--gaps") ? "gaps" : null;
  if (!mode) fail("usage: init <b> --full|--gaps [--force]");
  if (fs.existsSync(draftPath(b)) && !argv.includes("--force")) {
    fail(`${draftPath(b)} already exists; init would discard its review work (use --force to replace it)`);
  }
  const profile = loadProfile(b);
  const file = dictionaryFile(b);
  const base = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : JSON.parse(JSON.stringify(EMPTY_DICTIONARY));
  if (!isObj(base)) fail(`${file} is not a JSON object`);
  if (base.schemaVersion !== 3) fail(`${file} is not in the one shape (schemaVersion 3)`);
  // the dictionary's ignored-word records come back into the draft with the entries' status
  const ignored: { word: string; reason: string }[] = base.accounting?.ignoredWords ?? [];
  delete base.accounting;
  const d: Draft = { mode, ...base, accounting: { legend: [], removed: [] } } as Draft;

  const status: DraftStatus = mode === "full" ? "proposed" : "confirmed";
  if (ignored.length > 0) d.accounting.ignoredWords = ignored.map((r) => ({ word: r.word, reason: r.reason, status }));
  for (const { entry } of draftEntries(d)) {
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      entry.evidence = [{ kind: "pre-existing", source: typeof entry.source === "string" && entry.source !== "" ? entry.source : "(none)" }];
    }
    delete entry.source;
    entry.status = status;
  }

  if (mode === "full") {
    for (const rel of docFiles(profile)) {
      const abs = path.join(dataRoot(), b, rel);
      if (!fs.existsSync(abs)) fail(`declared abbreviations file not found: ${abs}`);
      // row 1 of the CSV is its header; one record per data row, row = the line number in the file
      readCsvRows(abs).forEach((_, i) => {
        if (i === 0) return;
        d.accounting.legend.push({ file: rel, row: i + 1, text: legendText(b, rel, i + 1), disposition: "", status: "proposed" });
      });
    }
  }

  // --gaps: the gaps are the review's coverage and word discovery (review-dictionary-draft.ts);
  // init adds no placeholder entries.
  writeDraft(b, d);
  console.log(`Draft written: ${draftPath(b)} (mode ${mode}, ${draftEntries(d).length} entries, ${d.accounting.legend.length} legend rows, ${d.accounting.ignoredWords?.length ?? 0} ignored words).`);
}

// ---------------------------------------------------------------------------
// promote / validate
// ---------------------------------------------------------------------------

/** --equipment <inputsDir>: the dir the point inputs come from (undefined = data/<b>/inputs). */
function equipmentDirFlag(argv: string[]): string | undefined {
  const dir = parseFlag(argv, "equipment");
  if (dir === undefined) return undefined;
  if (!dir || dir.startsWith("--")) fail("--equipment needs an inputs directory");
  const abs = path.resolve(dir);
  if (!fs.existsSync(path.join(abs, "plant-point-mapping.json")) && !fs.existsSync(path.join(abs, "zone-point-mapping.json"))) {
    fail(`--equipment ${dir}: no plant-point-mapping.json or zone-point-mapping.json (mapping files) found there`);
  }
  return abs;
}

/** With --equipment: an equipment-inventory.json in the dir adds the image ductPath (as review-dictionary-draft does). */
function hasInventory(inputsDir?: string): boolean {
  return inputsDir !== undefined && fs.existsSync(path.join(inputsDir, "equipment-inventory.json"));
}

function cmdPromote(b: string, inputsDir?: string): void {
  const withEquipment = hasInventory(inputsDir);
  const d = readDraft(b);
  if ((d as any).schemaVersion !== 3) fail("promote refused: the draft is not in the one shape (schemaVersion 3); older draft shapes are not supported");
  const open = openItems(d);
  if (open.length) fail(`promote refused: ${open.length} open item(s) still proposed:\n  - ${open.join("\n  - ")}`);
  // the accounting checks (K1, K2, ignored words) and the strict validation
  const current = fs.existsSync(dictionaryFile(b)) ? JSON.parse(fs.readFileSync(dictionaryFile(b), "utf-8")) : {};
  // also the review's open parts items (word clashes, frequent uncovered words, points with neither
  // role nor quantity), from data/<b>/inputs's mapping files when they exist
  const pointInputs = loadPointInputs(b, inputsDir, withEquipment) ?? undefined;
  console.log(`point inputs: ${inputsDir ?? path.join(dataRoot(), b, "inputs")}`);
  const report = reviewDraft({ draft: d, current, others: [], points: loadDataPoints(b), pointInputs, withDuctPaths: withEquipment });
  const clashes = report.oneAtATime.filter((i) => i.reason === "word-clash").map((i) => `word-clash: ${i.path}: ${i.notes[0] ?? ""}`);
  if (pointInputs === undefined) console.log(`note: no mapping files in ${inputsDir ?? path.join(dataRoot(), b, "inputs")}; word discovery checked on the raw data points, coverage and word clashes not checked`);
  const stats = { v3RowsSkipped: 0 };
  const errors = [...capLines([...report.accounting, ...clashes, ...v3OpenLines(report)]), ...validateStrict(stripDraft(d), b, { requireTags: true, inputsDir, withEquipment, stats })];
  skippedRows(stats);
  if (errors.length) fail(`promote refused: ${errors.length} validation error(s):\n  - ${errors.join("\n  - ")}`);
  fs.writeFileSync(dictionaryFile(b), JSON.stringify(stripDraft(d), null, 2) + "\n", "utf-8");
  fs.unlinkSync(draftPath(b));
  console.log(`Promoted: wrote ${dictionaryFile(b)} and removed the draft.`);
}

function knownPointIds(b: string, inputsDir?: string): Set<string> | null {
  const ids = new Set<string>();
  let any = false;
  for (const file of ["zone-point-mapping.json", "plant-point-mapping.json"]) {
    const p = path.join(inputsDir ?? path.join(dataRoot(), b, "inputs"), file);
    if (!fs.existsSync(p)) continue;
    any = true;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    for (const g of [...(data.zones ?? []), ...(data.plants ?? []), ...(data.devices ?? [])]) for (const pt of g.points ?? []) ids.add(pt.bmsPointId);
  }
  return any ? ids : null;
}

function orphanOverrides(dict: any, known: Set<string> | null): string[] {
  if (!known) return [];
  const out: string[] = [];
  const check = (label: string, t: unknown): void => {
    if (isObj(t)) for (const k of Object.keys(t)) if (!known.has(k)) out.push(`${label}.${k}: ORPHAN override matches no current bmsPointId`);
  };
  check("overrides", dict?.overrides);
  return out;
}

/** How many data rows the "decided by this entry" check could not reach. */
function skippedRows(stats: { v3RowsSkipped: number }): void {
  console.log(`  data rows not checked for "decided by this entry" (point not in the mapping files, or no mapping files): ${stats.v3RowsSkipped}`);
}

function cmdValidate(b: string, inputsDir?: string): void {
  console.log(`point inputs: ${inputsDir ?? path.join(dataRoot(), b, "inputs")}`);
  const profile = loadProfile(b);
  const known = knownPointIds(b, inputsDir);
  const withEquipment = hasInventory(inputsDir);
  let issues = 0;
  const report = (label: string, errors: string[]): void => {
    console.log(`${label}: ${errors.length} issue(s)`);
    for (const e of errors) console.log(`  - ${e}`);
    issues += errors.length;
  };
  const kinds = (errors: string[]): string =>
    `missing evidence: ${errors.filter((e) => e.endsWith("missing evidence")).length}, other: ${errors.filter((e) => !e.endsWith("missing evidence")).length}`;

  const file = dictionaryFile(b);
  if (fs.existsSync(file)) {
    const dict = JSON.parse(fs.readFileSync(file, "utf-8"));
    const stats = { v3RowsSkipped: 0 };
    const errors = [...validateStrict(dict, b, { stats, inputsDir, withEquipment }), ...orphanOverrides(dict, known)];
    report(`dictionary ${b} (${profile.dataShape})`, errors);
    console.log(`  (${kinds(errors)})`);
    skippedRows(stats);
  } else console.log(`no dictionary file: ${file}`);
  if (!fs.existsSync(file) && !fs.existsSync(draftPath(b))) fail(`nothing to validate for ${b}: neither ${file} nor ${draftPath(b)} exists`);

  if (fs.existsSync(draftPath(b))) {
    const d = readDraft(b);
    const stripped = stripDraft(d);
    const stats = { v3RowsSkipped: 0 };
    const errors = [...validateStrict(stripped, b, { requireTags: true, stats, inputsDir, withEquipment }), ...orphanOverrides(stripped, known)];
    report(`draft ${b}`, errors);
    console.log(`  (${kinds(errors)})`);
    skippedRows(stats);
    console.log(`draft open items: ${openItems(d).length}`);
  }
  if (issues) process.exitCode = 1;
  else console.log(`Validation OK for ${b}.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv: string[]): void {
  if (argv[0] === "--validate") {
    if (!argv[1]) fail("usage: --validate <b> [--equipment <inputsDir>]");
    return cmdValidate(argv[1], equipmentDirFlag(argv));
  }
  const [cmd, b] = argv;
  if (!cmd || !b) fail("usage: init|set|set-batch|status|account|remove|promote <b> [--equipment <dir>] ...  |  --validate <b> [--equipment <dir>]  (see the header of this file)");
  switch (cmd) {
    case "init":
      return cmdInit(b, argv);
    case "set":
      return cmdSet(b, argv);
    case "set-batch":
      return cmdSetBatch(b);
    case "status":
      return cmdStatus(b, argv);
    case "account":
      return cmdAccount(b, argv);
    case "remove":
      return cmdRemove(b, argv);
    case "promote":
      return cmdPromote(b, equipmentDirFlag(argv));
    default:
      return fail(`unknown command "${cmd}"`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
