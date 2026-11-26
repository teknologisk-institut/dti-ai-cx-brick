// tools/lib/dictionary-review.ts
//
// The read-only review of a dictionary draft (HITL touchpoint 2): the buckets the human reviews,
// cross-building notes, and the accounting checks (K1, K2, ignored words). Pure: no file access.
// review-dictionary-draft.ts is the CLI; write-point-dictionary-entry.ts promote reuses `accounting`
// (and v3OpenLines).
//
// The draft is in the one shape (schemaVersion 3). Its points are decided by the classifier's own
// combiner (collectContributions + combineParts), and it gets the parts sections: word
// discovery, grammar samples, coverage per point, word clashes (one at a time),
// suffix-vs-description roles and the stream check (information).

import { asPartsDictionary, combinePoint, decidingEntries, V3_POINT_ENTRY } from "./dictionary-data";
import type { DataPoint } from "./dictionary-data";
import { draftEntries, getAt } from "./dictionary-draft";
import { ROLE_TAGS, SPATIAL_APPLIES_TO } from "./point-dictionary";
import { ductPathTags } from "./point-parts";
import type { Contribution, PointInput } from "./point-parts";
import { PART_TAGS } from "./tag-match";

export type ReviewReason = "contradiction" | "flagged" | "differs-from-pre-existing" | "gap" | "unsupported-pre-existing" | "data-only" | "agrees" | "new-entry" | "word-clash";

/** Brick tags that name an air or water stream. */
export const STREAM_TAGS = ["Supply", "Discharge", "Return", "Exhaust", "Outside", "Intake", "Relief", "Mixed", "Zone", "Building", "Bypass", "Leaving", "Entering"];
export interface Item {
  path: string;
  reason: ReviewReason;
  notes: string[];
}
export interface ReviewReport {
  oneAtATime: Item[];
  dataOnly: Item[];
  agrees: Item[];
  accounting: string[];
  info: string[];
  /** The one shape (schemaVersion 3) only. */
  v3?: V3Sections;
}
export interface WordCount {
  word: string;
  count: number;
  /** up to 3 point ids */
  samples: string[];
  /** a word entry's phrase holds it as a whole word, or accounting.ignoredWords records it */
  covered: boolean;
}
export interface V3Sections {
  /** true when there were no point inputs (no mapping files): word discovery then runs on the raw data
   * points, and every other list below is empty */
  skipped: boolean;
  wordMin: number;
  /** every distinct description word, most frequent first */
  wordDiscovery: WordCount[];
  /** open: words occurring at least wordMin times that nothing covers */
  uncoveredWords: WordCount[];
  grammarSamples: {
    tokens: Array<{ token: string; count: number; samples: string[] }>;
    suffixes: Array<{ part: string; count: number }>;
    letters: Array<{ letter: string; count: number }>;
  };
  coverage: {
    /** open: no role and no quantity after combining */
    noRoleNoQuantity: Array<{ id: string; description: string }>;
    /** information: the role comes only from the fallback */
    roleFallback: string[];
  };
  /** information: suffix and description give different roles */
  suffixVsDescription: string[];
  /** null when the points carry no image ductPath (no equipment inventory given) */
  streamCheck: { entrySpread: string[]; pointDisagrees: string[] } | null;
}
export interface ReviewInput {
  draft: any;
  current: any;
  others: Array<{ buildingId: string; dict: any }>;
  points: DataPoint[];
  /** The one shape: the points as the classifier sees them (pointInputsFromMapping). Absent: the parts
   * sections are skipped. */
  pointInputs?: PointInput[];
  /** The point inputs carry the image ductPath (an equipment inventory was given): run the stream check. */
  withDuctPaths?: boolean;
  /** Word discovery: a word occurring at least this many times must be covered (default WORD_MIN). */
  wordMin?: number;
}

export const WORD_MIN = 5;

export const DISPOSITIONS = /^(entry:.+|plant-id|point-id|meter-id|wildcard|not-in-data|not-a-token)$/;

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const tagList = (t: unknown): string[] => (Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : []);
/** R8: tags are compared only when both sides have them. */
const tagsDiffer = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b) && !sameTags(a, b);
const sameTags = (a: unknown, b: unknown): boolean => {
  const x = [...tagList(a)].sort();
  const y = [...tagList(b)].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
};
const fmt = (meaning: unknown, tags: unknown): string => `${String(meaning ?? "")} [${tagList(tags).join(", ")}]`;

export interface LegendIssue {
  index: number;
  row: unknown;
  text: unknown;
  disposition: unknown;
  note: string;
  /** false when the record is merely still open (status proposed); true for an invalid disposition or entry: target. */
  bad: boolean;
  /** the K2 message, naming accounting.legend[i] */
  message: string;
}

/** Every legend record needs a valid disposition; an entry: target must exist and cite the row in doc
 * evidence; a record still "proposed" is open (K2). */
export function legendIssues(d: any): LegendIssue[] {
  const out: LegendIssue[] = [];
  (d?.accounting?.legend ?? []).forEach((r: any, i: number) => {
    const at = `accounting.legend[${i}] (${r.file} row ${r.row})`;
    const add = (note: string, bad: boolean) => out.push({ index: i, row: r.row, text: r.text, disposition: r.disposition, note, bad, message: `${at}: ${note}` });
    if (r.status === "proposed") add("still open (status proposed)", false);
    if (typeof r.disposition !== "string" || !DISPOSITIONS.test(r.disposition)) {
      return void add(`disposition "${r.disposition ?? ""}" is not valid (entry:<path>, plant-id, point-id, meter-id, wildcard, not-in-data, not-a-token)`, true);
    }
    if (!r.disposition.startsWith("entry:")) return;
    const target = r.disposition.slice(6);
    const e = getAt(d, target);
    if (!isObj(e)) return void add(`entry target ${target} does not exist in the draft`, true);
    const cites = (Array.isArray(e.evidence) ? e.evidence : []).some(
      (ev: any) => ev?.kind === "doc" && ev.file === r.file && typeof ev.location === "string" && new RegExp(`\\brow\\s+${r.row}\\b`, "i").test(ev.location)
    );
    if (!cites) add(`${target} has no doc evidence citing file ${r.file} row ${r.row}`, true);
  });
  return out;
}

export const legendErrors = (d: any): string[] => legendIssues(d).map((x) => x.message);

/** What other buildings say about a token: their own entry for the same context, or a rule-shape
 * suffixRule whose pattern is exactly ^TOKEN or ^TOKEN\d. */
function otherDefinitions(others: ReviewInput["others"], ctx: string, token: string): Array<{ b: string; meaning: string; tags: string[]; hasTags: boolean }> {
  const out: Array<{ b: string; meaning: string; tags: string[]; hasTags: boolean }> = [];
  for (const { buildingId: b, dict } of others) {
    const own = dict?.[ctx]?.tokens?.[token] ?? dict?.tokens?.[ctx]?.[token];
    if (isObj(own) && typeof own.meaning === "string") out.push({ b, meaning: own.meaning, tags: tagList(own.tags), hasTags: Array.isArray(own.tags) });
    for (const r of Array.isArray(dict?.suffixRules) ? dict.suffixRules : []) {
      const m = typeof r?.pattern === "string" ? /^\^([A-Z]+)(\\d)?$/.exec(r.pattern) : null;
      if (m && m[1] === token && typeof r.meaning === "string") out.push({ b, meaning: r.meaning, tags: tagList(r.tags), hasTags: Array.isArray(r.tags) });
    }
  }
  return out;
}

const ARRAY_PATH = /^(.*)\[\d+\]$/;
const sameRule = (a: any, b: any): boolean => isObj(a) && isObj(b) && a.pattern === b.pattern && (a.flags ?? "") === (b.flags ?? "");

/** R9b: an array-section rule (suffixes, descriptionRules, ...) is the same rule when pattern and flags
 * match, wherever it sits in the array. Other paths are looked up by key. */
export function currentFor(current: any, p: string, entry: any): any {
  const m = ARRAY_PATH.exec(p);
  if (!m) return getAt(current, p);
  const arr = getAt(current, m[1]);
  return Array.isArray(arr) ? arr.find((r) => sameRule(r, entry)) : undefined;
}

/** Whether the draft carries the current entry at path p (by identity for array rules). */
function presentIn(draft: any, p: string, currentEntry: any): boolean {
  const m = ARRAY_PATH.exec(p);
  if (!m) return getAt(draft, p) !== undefined;
  const arr = getAt(draft, m[1]);
  return Array.isArray(arr) && arr.some((r) => sameRule(r, currentEntry));
}

export function reviewDraft(input: ReviewInput): ReviewReport {
  const { draft, current, others, points } = input;
  if (draft?.schemaVersion !== 3) throw new Error("the draft is not in the one shape (schemaVersion 3); older draft shapes are not supported");
  const report: ReviewReport = { oneAtATime: [], dataOnly: [], agrees: [], accounting: [], info: [] };
  const entries = draftEntries(draft);
  // The classifier's combiner decides the points; coverage per point and the stream check are the
  // per-point checks (parts sections below).
  const counterpart = (p: string, entry: any) => v3Counterpart(current, p, entry);

  // ---- buckets
  for (const { path: p, entry } of entries) {
    if (entry.status === "confirmed" || entry.status === "changed") continue;
    const evidence: any[] = Array.isArray(entry.evidence) ? entry.evidence : [];
    const has = (k: string) => evidence.some((e) => e?.kind === k);
    const notes: string[] = [];
    const cur = counterpart(p, entry);

    // cross-building notes (zone/plant token entries only)
    const tok = /^tokens\.(zone|plant)\.([^.\[\]]+)$/.exec(p);
    if (tok && typeof entry.meaning === "string") {
      const noDocData = !has("doc") && !has("data");
      // R9a: a human-only entry is the building's own decision; no suggestion
      const humanOnly = noDocData && has("human");
      for (const o of humanOnly ? [] : otherDefinitions(others, tok[1], tok[2])) {
        if (o.meaning === entry.meaning && !tagsDiffer(o.hasTags ? o.tags : undefined, entry.tags)) continue;
        notes.push(noDocData ? `seen in ${o.b}, not confirmed here: ${fmt(o.meaning, o.tags)}` : `${o.b} defines ${tok[2]} as ${fmt(o.meaning, o.tags)}`);
      }
    }

    let reason: ReviewReason;
    const reviewNote = typeof entry.review?.note === "string" ? entry.review.note : "";
    const flagged = entry.review?.flag === true;
    const diffs: string[] = [];
    if (isObj(cur)) {
      if (cur.meaning !== entry.meaning) diffs.push(`meaning: "${cur.meaning ?? ""}" -> "${entry.meaning ?? ""}"`);
      // the one shape has no category (meterReadings keeps its own)
      if (entry.category !== undefined && cur.category !== entry.category) diffs.push(`category: "${cur.category ?? ""}" -> "${entry.category ?? ""}"`);
      if (tagsDiffer(cur.tags, entry.tags)) diffs.push(`tags: [${tagList(cur.tags).join(", ")}] -> [${tagList(entry.tags).join(", ")}]`);
    }
    if (entry.review?.docVsData === "contradict") {
      reason = "contradiction";
      if (reviewNote !== "") notes.unshift(reviewNote);
    } else if (flagged) {
      reason = "flagged";
    } else if (diffs.length) {
      reason = "differs-from-pre-existing";
      notes.unshift(...diffs.map((d) => `differs from the pre-existing entry, ${d}`));
    } else if (!has("doc") && !has("data") && !has("human")) {
      reason = has("pre-existing") ? "unsupported-pre-existing" : "gap";
    } else if (!isObj(cur) && !(has("doc") && has("data") && entry.review?.docVsData === "agree")) {
      // R13: an entry with no current counterpart is new; only doc+data evidence that agrees is waved through
      reason = "new-entry";
    } else if (has("data") && !has("doc")) reason = "data-only";
    else reason = "agrees";

    if (reason === "flagged") {
      // the reason it would have had without the note stays visible
      const dflt: string = diffs.length ? "differs-from-pre-existing" : !has("doc") && !has("data") && !has("human") ? (has("pre-existing") ? "unsupported-pre-existing" : "gap") : !isObj(cur) && !(has("doc") && has("data") && entry.review?.docVsData === "agree") ? "new-entry" : has("data") && !has("doc") ? "data-only" : "agrees";
      notes.unshift(`flagged: ${reviewNote || "(no note)"}`, ...diffs.map((d) => `differs from the pre-existing entry, ${d}`), `otherwise: ${dflt}`);
    } else if (reason !== "contradiction" && reviewNote !== "") {
      notes.unshift(`note: ${reviewNote}`);
    }
    const item: Item = { path: p, reason, notes };
    (reason === "agrees" ? report.agrees : reason === "data-only" ? report.dataOnly : report.oneAtATime).push(item);
  }

  // ---- K1: a current key neither carried over nor accounted as removed
  const removed = new Set<string>((draft?.accounting?.removed ?? []).map((r: any) => r.path));
  for (const { path: p, entry: ce } of draftEntries(current)) {
    if (!removed.has(p) && !v3Present(draft, current, p, ce)) report.accounting.push(`K1: current entry ${p} is neither in the draft nor listed under accounting.removed`);
  }

  // ---- K2: legend
  report.accounting.push(...legendErrors(draft).map((m) => `K2: ${m}`));

  // ---- ignored words still open; then the parts sections (combiner per point)
  (Array.isArray(draft?.accounting?.ignoredWords) ? draft.accounting.ignoredWords : []).forEach((r: any, i: number) => {
    const at = `accounting.ignoredWords[${i}] ("${r?.word ?? ""}")`;
    if (typeof r?.word !== "string" || r.word.trim() === "") report.accounting.push(`${at}: word is empty`);
    if (typeof r?.reason !== "string" || r.reason.trim() === "") report.accounting.push(`${at}: reason is empty`);
    if (r?.status === "proposed") report.accounting.push(`${at}: still open (status proposed)`);
  });
  const s = partsSections(draft, input.pointInputs, points, input.withDuctPaths === true, input.wordMin ?? WORD_MIN);
  report.v3 = s.sections;
  report.oneAtATime.push(...s.clashes);
  if (!s.sections.skipped && (input.pointInputs ?? []).length > 0) {
    for (const { path: p } of entries) if (V3_POINT_ENTRY.test(p) && !s.used.has(p)) report.info.push(`${p} decides no point`);
  }
  const fallback = s.sections.coverage.roleFallback.length;
  if (fallback) report.info.push(`${fallback} point(s) get their role only from the fallback (quantity, no role: Sensor, low confidence)`);
  return report;
}

function testRe(pattern: unknown, flags: unknown, text: string): boolean {
  try {
    return typeof pattern === "string" && new RegExp(pattern, typeof flags === "string" ? flags : "").test(text);
  } catch {
    return false;
  }
}

/** The top-level alternatives of a regex source: split on `|` outside groups, classes and escapes. */
export function topLevelAlternatives(pattern: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      cur += c + (pattern[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const normDesc = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim().toLowerCase();
  return t === "" || t === "null" ? "(empty)" : t;
};

// ---------------------------------------------------------------------------
// The one shape (schemaVersion 3)
// ---------------------------------------------------------------------------


const ownKey = (o: unknown, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const sameCtx = (a: any, b: any): boolean => (a?.context ?? "any") === (b?.context ?? "any");

/** A rule alternative that starts with ^ and a literal letter prefix (^TR\d, ^FN): the letters. The
 * conversion turns such an alternative into a tokens.any entry. */
function literalPrefix(alt: string): string | null {
  const m = /^\^(\p{L}+)(.*)$/su.exec(alt);
  return !m || /^[?*+{]/.test(m[2]) ? null : m[1];
}

/** The current entry an entry of a one-shape draft stands for. A one-shape current: the same path
 * (array entries by pattern+flags+context, words by phrase+context). An old-shape current: the entry
 * the conversion made it from (tokens.<ctx>.T from <ctx>.tokens.T; tokens.any.T from the suffixRule with
 * a ^T alternative; a suffix from <ctx>.suffixes or the suffixRule holding its pattern; a word from the
 * descriptionRule that matches its phrase). units, plantTokens and plantOverrides are new. */
function v3Counterpart(current: any, p: string, entry: any): any {
  const arr = /^(suffixes|words|equipmentIdRules)\[\d+\]$/.exec(p);
  if (current?.schemaVersion === 3) {
    if (!arr) return getAt(current, p);
    const list = Array.isArray(current[arr[1]]) ? current[arr[1]] : [];
    return arr[1] === "words" ? list.find((w: any) => isObj(w) && w.phrase === entry.phrase && sameCtx(w, entry)) : list.find((r: any) => sameRule(r, entry) && sameCtx(r, entry));
  }
  let m: RegExpExecArray | null;
  if ((m = /^tokens\.(zone|plant)\.([^.]+)$/.exec(p))) return current?.[m[1]]?.tokens?.[m[2]];
  if ((m = /^tokens\.any\.([^.]+)$/.exec(p))) {
    const t = m[1];
    return (Array.isArray(current?.suffixRules) ? current.suffixRules : []).find((r: any) => typeof r?.pattern === "string" && topLevelAlternatives(r.pattern).some((a) => literalPrefix(a) === t));
  }
  if ((m = /^overrides\.(.+)$/.exec(p))) {
    for (const t of [current?.overrides, current?.zone?.overrides, current?.plant?.overrides]) if (ownKey(t, m[1])) return t[m[1]];
    return undefined;
  }
  if (arr?.[1] === "suffixes") {
    if (entry.context === "zone" || entry.context === "plant") return (current?.[entry.context]?.suffixes ?? []).find((r: any) => sameRule(r, entry));
    return (Array.isArray(current?.suffixRules) ? current.suffixRules : []).find(
      (r: any) => typeof r?.pattern === "string" && (r.flags ?? "") === (entry.flags ?? "") && topLevelAlternatives(r.pattern).includes(entry.pattern)
    );
  }
  if (arr?.[1] === "words") return (Array.isArray(current?.descriptionRules) ? current.descriptionRules : []).find((r: any) => testRe(r?.pattern, r?.flags, String(entry.phrase ?? "")));
  if (p === "meterReadings" || p.startsWith("meterReadings.")) return getAt(current, `plant.${p}`);
  if (p === "notEquipment") return current?.zone?.notEquipment ?? current?.plant?.notEquipment;
  if (arr?.[1] === "equipmentIdRules") return currentFor(current, p, entry);
  return undefined;
}

/** K1 for a one-shape draft: whether the current entry at p (in the current's own shape) is carried. */
function v3Present(draft: any, current: any, p: string, ce: any): boolean {
  const suffixes: any[] = Array.isArray(draft?.suffixes) ? draft.suffixes : [];
  if (current?.schemaVersion === 3) {
    const arr = /^(suffixes|words|equipmentIdRules)\[\d+\]$/.exec(p);
    if (!arr) return getAt(draft, p) !== undefined;
    const list = Array.isArray(draft?.[arr[1]]) ? draft[arr[1]] : [];
    return arr[1] === "words" ? list.some((w: any) => isObj(w) && w.phrase === ce.phrase && sameCtx(w, ce)) : list.some((r: any) => sameRule(r, ce) && sameCtx(r, ce));
  }
  let m: RegExpExecArray | null;
  if ((m = /^(zone|plant)\.tokens\.(.+)$/.exec(p))) return getAt(draft, `tokens.${m[1]}.${m[2]}`) !== undefined;
  if ((m = /^((zone|plant)\.)?overrides\.(.+)$/.exec(p))) return ownKey(draft?.overrides, m[3]);
  if ((m = /^(zone|plant)\.suffixes\[\d+\]$/.exec(p))) {
    const ctx = m[1];
    return suffixes.some((s) => sameRule(s, ce) && s.context === ctx);
  }
  if ((m = /^plant\.(meterReadings.*)$/.exec(p))) return getAt(draft, m[1]) !== undefined;
  if (/^(zone|plant)\.notEquipment$/.test(p)) return isObj(draft?.notEquipment);
  if (/^suffixRules\[\d+\]$/.test(p)) {
    if (typeof ce?.pattern !== "string") return false;
    return topLevelAlternatives(ce.pattern).every((a) => {
      const t = literalPrefix(a);
      return t !== null ? ownKey(draft?.tokens?.any, t) : suffixes.some((s) => s.pattern === a && (s.flags ?? "") === (ce.flags ?? ""));
    });
  }
  if (/^descriptionRules\[\d+\]$/.test(p)) return (Array.isArray(draft?.words) ? draft.words : []).some((w: any) => testRe(ce?.pattern, ce?.flags, String(w?.phrase ?? "")));
  return presentIn(draft, p, ce);
}

/** A description's words: split on non-letters (Danish letters are letters), lower-cased. */
export function descriptionWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w !== "");
}

const roleTags = (c: Contribution): string[] => c.tags.filter((t) => ROLE_TAGS.includes(t));
const streamOf = (tags: string[]): string[] => tags.filter((t) => PART_TAGS.stream.includes(t));
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t) => b.includes(t));
const count = <K>(m: Map<K, number>, k: K, n = 1): void => void m.set(k, (m.get(k) ?? 0) + n);

/** Word discovery over points' descriptions: every distinct word, most frequent first;
 * the uncovered ones occurring at least wordMin times are open. */
function wordSections(draft: any, points: Array<{ id: string; description: string }>, wordMin: number): Pick<V3Sections, "wordDiscovery" | "uncoveredWords"> {
  const wordCount = new Map<string, { count: number; samples: string[] }>();
  for (const p of points) {
    for (const w of descriptionWords(p.description)) {
      const g = wordCount.get(w) ?? { count: 0, samples: [] };
      g.count++;
      if (g.samples.length < 3 && !g.samples.includes(p.id)) g.samples.push(p.id);
      wordCount.set(w, g);
    }
  }
  const covered = new Set<string>();
  for (const w of Array.isArray(draft?.words) ? draft.words : []) if (typeof w?.phrase === "string" && !(Array.isArray(w.appliesTo) && w.appliesTo.some((a: unknown) => SPATIAL_APPLIES_TO.includes(a as string)))) for (const x of descriptionWords(w.phrase)) covered.add(x);
  for (const r of Array.isArray(draft?.accounting?.ignoredWords) ? draft.accounting.ignoredWords : []) if (typeof r?.word === "string") covered.add(r.word.trim().toLowerCase());
  const wordDiscovery = [...wordCount]
    .map(([word, g]) => ({ word, count: g.count, samples: g.samples, covered: covered.has(word) }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return { wordDiscovery, uncoveredWords: wordDiscovery.filter((w) => !w.covered && w.count >= wordMin) };
}

/** The parts sections, the word-clash items, and every entry that decides some point. Without point
 * inputs (no mapping files yet: the dictionary step comes before mapping) word discovery runs on the
 * building's raw data points and every other section is skipped. */
function partsSections(draft: any, inputs: PointInput[] | undefined, points: DataPoint[], withDuctPaths: boolean, wordMin: number): { sections: V3Sections; clashes: Item[]; used: Set<string> } {
  const sections: V3Sections = {
    skipped: inputs === undefined,
    wordMin,
    ...wordSections(draft, inputs ?? points.map((p) => ({ id: p.pointId, description: p.description })), wordMin),
    grammarSamples: { tokens: [], suffixes: [], letters: [] },
    coverage: { noRoleNoQuantity: [], roleFallback: [] },
    suffixVsDescription: [],
    streamCheck: inputs !== undefined && withDuctPaths ? { entrySpread: [], pointDisagrees: [] } : null,
  };
  const used = new Set<string>();
  const clashes: Item[] = [];
  if (inputs === undefined) return { sections, clashes, used };
  const dict = asPartsDictionary(draft);
  const words: any[] = dict.words;
  const phraseOf = (entry: string): string => {
    const m = /^words\[(\d+)\]$/.exec(entry);
    return m && typeof words[Number(m[1])]?.phrase === "string" ? ` "${words[Number(m[1])].phrase}"` : "";
  };

  const tokens = new Map<string, { count: number; samples: string[] }>();
  const suffixParts = new Map<string, number>();
  const letters = new Map<string, number>();
  const clashByDesc = new Map<string, { shown: string; detail: string; ids: string[] }>();
  const svd = new Map<string, { n: number; first: string }>();
  const spread = new Map<string, { stream: string[]; paths: Map<string, number> }>();

  for (const p of inputs) {
    // grammar samples: a suffix glued to the number (no separator) starts with the trailing letter
    const t = tokens.get(p.parts.token) ?? { count: 0, samples: [] };
    t.count++;
    if (t.samples.length < 10) t.samples.push(`${p.id}: token ${p.parts.token} · number ${p.parts.number || "-"} · suffix ${p.parts.suffix ?? "-"}`);
    tokens.set(p.parts.token, t);
    if (p.parts.suffix) {
      const parts = p.parts.suffix.split(p.separator).filter((x) => x !== "");
      const glued = !p.id.slice(0, p.id.length - p.parts.suffix.length).endsWith(p.separator);
      if (glued && parts.length > 0) count(letters, parts.shift()!);
      for (const x of parts) count(suffixParts, x);
    }

    const { cs, combined } = combinePoint(dict, p);
    for (const e of decidingEntries(cs, combined)) used.add(e);

    // coverage
    if (combined.flags.some((f) => f.kind === "no-role")) sections.coverage.noRoleNoQuantity.push({ id: p.id, description: p.description });
    if (combined.flags.some((f) => f.kind === "role-fallback")) sections.coverage.roleFallback.push(p.id);

    // word clashes, by distinct description
    const clash = combined.flags.find((f) => f.kind === "word-clash");
    if (clash) {
      const key = normDesc(p.description);
      const g = clashByDesc.get(key) ?? { shown: key, detail: clash.detail, ids: [] };
      g.ids.push(p.id);
      clashByDesc.set(key, g);
    }

    // suffix vs description, on the role
    const suf = cs.filter((c) => c.level === "suffix" && roleTags(c).length > 0).sort((a, b) => b.pos - a.pos)[0];
    const descs = cs.filter((c) => c.level === "desc" && roleTags(c).length > 0);
    if (suf && descs.length > 0 && descs.every((d) => sameSet(roleTags(d), roleTags(descs[0]))) && !sameSet(roleTags(suf), roleTags(descs[0]))) {
      const key = `${suf.entry} [${roleTags(suf).join(", ")}] vs ${descs[0].entry}${phraseOf(descs[0].entry)} [${roleTags(descs[0]).join(", ")}]`;
      const g = svd.get(key) ?? { n: 0, first: p.id };
      g.n++;
      svd.set(key, g);
    }

    // stream check
    if (sections.streamCheck && p.ductPath) {
      for (const c of cs) {
        const st = streamOf(c.tags);
        if (c.level === "ductPath" || st.length === 0) continue;
        const g = spread.get(c.entry) ?? { stream: st, paths: new Map<string, number>() };
        count(g.paths, p.ductPath);
        spread.set(c.entry, g);
      }
      const dp = streamOf(ductPathTags(p.ductPath));
      for (const c of cs.filter((x) => x.level === "desc" && streamOf(x.tags).length > 0)) {
        if (dp.length > 0 && !sameSet(dp, streamOf(c.tags))) {
          sections.streamCheck.pointDisagrees.push(`${p.id}: ductPath ${p.ductPath} [${dp.join(", ")}] vs ${c.entry}${phraseOf(c.entry)} [${streamOf(c.tags).join(", ")}]`);
        }
      }
    }
  }

  const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
  sections.grammarSamples.tokens = [...tokens].map(([token, g]) => ({ token, ...g })).sort(byCount);
  sections.grammarSamples.suffixes = [...suffixParts].map(([part, n]) => ({ part, count: n })).sort(byCount);
  sections.grammarSamples.letters = [...letters].map(([letter, n]) => ({ letter, count: n })).sort(byCount);

  for (const g of clashByDesc.values()) {
    clashes.push({
      path: `description "${g.shown}"`,
      reason: "word-clash",
      notes: [`words disagree on the role: ${g.detail}`, `${g.ids.length} point(s), e.g. ${g.ids.slice(0, 3).join(", ")}`, "resolve with a phrase entry for the whole description (or the words that belong together)"],
    });
  }
  for (const [key, g] of svd) sections.suffixVsDescription.push(`${key}: ${g.n} point(s), e.g. ${g.first}`);
  if (sections.streamCheck) {
    for (const [entry, g] of spread) {
      if (g.paths.size < 2) continue;
      sections.streamCheck.entrySpread.push(`${entry} [${g.stream.join(", ")}]: its points span ductPaths ${[...g.paths].map(([d, n]) => `${d} (${n})`).join(", ")}`);
    }
  }
  return { sections, clashes, used };
}

/** The open items of the parts sections that are not review items: frequent uncovered words and points
 * with neither role nor quantity. (Word clashes are in oneAtATime.) */
export function v3OpenLines(report: ReviewReport): string[] {
  const s = report.v3;
  if (!s) return [];
  return [
    ...s.uncoveredWords.map((w) => `word "${w.word}" occurs ${w.count} times (e.g. ${w.samples.join(", ")}) with no word entry and no accounting.ignoredWords record`),
    ...s.coverage.noRoleNoQuantity.map((x) => `coverage: ${x.id} has no role and no quantity after combining (description ${x.description.trim() === "" ? "(empty)" : `"${x.description}"`})`),
  ];
}

/** At most `max` lines, then a count of the rest. */
export function capLines(lines: string[], max = 50): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `... and ${lines.length - max} more`];
}
