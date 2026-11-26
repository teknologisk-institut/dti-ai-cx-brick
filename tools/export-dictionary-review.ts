// tools/export-dictionary-review.ts
//
// Exports dictionary drafts, their review (reviewDraft), Brick class tag sets with definitions and Brick
// substances as one JSON, or fills the interactive review page template with it. Not yet part of the
// official pipeline.
//
// Usage (npx ts-node tools/export-dictionary-review.ts ...):
//   <out.json|out.html> <b> [<b> ...] [--exclude <b,...>]
//   out.html fills tools/review-page/dictionary-review.template.html (or $REVIEW_TEMPLATE).
//   --exclude  buildings left out of the cross-building notes (e.g. a legacy copy of a building)
import * as fs from "fs";
import * as path from "path";
import { dataRoot, loadProfile } from "./lib/building-profile";
import { loadDataPoints } from "./lib/dictionary-data";
import { draftEntries, readDraft } from "./lib/dictionary-draft";
import { currentFor, legendIssues, reviewDraft } from "./lib/dictionary-review";

const argv = process.argv.slice(2);
const USAGE = "usage: <out.json|out.html> <b> [<b> ...] [--exclude <b,...>]";
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));

function others(root: string, exclude: string[], b: string) {
  return fs.readdirSync(root)
    .filter((n) => n !== b && !exclude.includes(n) && fs.existsSync(path.join(root, n, "point-dictionary.json")))
    .map((n) => ({ buildingId: n, dict: readJson(path.join(root, n, "point-dictionary.json")) }));
}

const pick = (e: any) => (e && typeof e === "object" ? {
  meaning: e.meaning, category: e.category, tags: e.tags, danishGloss: e.danishGloss, source: e.source,
  pattern: e.pattern, flags: e.flags, abbreviations: e.abbreviations, prefixes: e.prefixes, type: e.type,
} : null);

function main(): void {
const unknown = argv.find((a) => a.startsWith("--") && a !== "--exclude");
if (unknown) throw new Error(`unknown flag ${unknown} (known: --exclude)
${USAGE}`);
const xi = argv.indexOf("--exclude");
const exclude = xi === -1 ? [] : (argv[xi + 1] ?? "").split(",").filter(Boolean);
const [out, ...buildings] = xi === -1 ? argv : [...argv.slice(0, xi), ...argv.slice(xi + 2)];
if (!out || buildings.length === 0) throw new Error(USAGE);
const root = dataRoot();
// The page's category choice: the categories the drafts' entries carry (only meterReadings readings keep one).
const categories = new Set<string>();
const result: any = { generatedAt: new Date().toISOString(), categories: [], buildings: [] };
for (const b of buildings) {
  loadProfile(b);
  const draft = readDraft(b);
  const curFile = path.join(root, b, "point-dictionary.json");
  const current = fs.existsSync(curFile) ? readJson(curFile) : {};
  const report = reviewDraft({ draft, current, others: others(root, exclude, b), points: loadDataPoints(b) });
  const bucketOf = new Map<string, any>();
  for (const [bucket, list] of [["one", report.oneAtATime], ["dataOnly", report.dataOnly], ["agrees", report.agrees]] as const) {
    for (const it of list) bucketOf.set(it.path, { bucket, reason: it.reason, notes: it.notes });
  }
  for (const { entry } of draftEntries(draft)) if (typeof entry.category === "string") categories.add(entry.category);
  const items = draftEntries(draft).map(({ path: p, entry }) => ({
    path: p,
    ...(bucketOf.get(p) ?? { bucket: "done", reason: entry.status, notes: [] }),
    status: entry.status,
    proposal: pick(entry),
    current: pick(currentFor(current, p, entry)),
    evidence: entry.evidence ?? [],
    review: entry.review ?? {},
  }));
  result.buildings.push({
    id: b,
    items,
    legend: legendIssues(draft).map((x) => ({ index: x.index, row: x.row, text: x.text, disposition: x.disposition, note: x.note, bad: x.bad, file: (draft.accounting?.legend?.[x.index] ?? {}).file })),
    accounting: report.accounting.filter((l) => !l.startsWith("K2")),
    info: report.info,
  });
}
result.categories = [...categories].sort();
const idx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ontologies", "brick-classification-index.json"), "utf-8"));
const tagSet = new Set<string>();
for (const e of Object.values<any>(idx.classes)) for (const t of e.tags || []) tagSet.add(t);
result.brickTags = [...tagSet].sort();
// Class tag sets + definitions (the page matches entry tags against them) and substances (air/water stream meanings).
result.brickClasses = Object.fromEntries(Object.entries<any>(idx.classes)
  .filter(([k, e]) => k.startsWith("brick:") && (e.category === "Point" || e.category === "Equipment") && (e.tags || []).length)
  .map(([k, e]) => [k.slice(6), { t: e.tags.filter((t: string) => t !== "Point" && t !== "Equipment"), d: e.definition || "", c: e.category }]));
result.substances = idx.substances || {};
// Per entry: the Brick classes its tags fit (all class tags minus Point/Equipment present), most specific first.
const fitsFor = (tags: string[]) => {
  const s = new Set(tags);
  return Object.entries<any>(result.brickClasses).filter(([, e]) => e.t.length && e.t.every((t: string) => s.has(t)))
    .sort((a, b) => (b[1].t.length - a[1].t.length) || a[0].localeCompare(b[0])).slice(0, 3)
    .map(([k, e]) => ({ class: k, tags: e.t, definition: e.d }));
};
for (const bd of result.buildings) {
  // Plant tokens: image-derived ductPath of the equipment ids carrying the token (step 4 output, if present).
  const inv = path.join(root, bd.id, "inputs", "equipment-inventory.json");
  const dp = new Map<string, Record<string, number>>();
  if (fs.existsSync(inv)) {
    for (const pl of readJson(inv).plantEquipment ?? []) for (const eq of pl.equipment ?? []) {
      const m = /^([A-ZÆØÅ]+)\d+$/.exec(eq.id ?? "");
      if (!m || !eq.ductPath) continue;
      const c = dp.get(m[1]) ?? {};
      c[`${eq.id.slice(m[1].length)}:${eq.ductPath}`] = (c[`${eq.id.slice(m[1].length)}:${eq.ductPath}`] ?? 0) + 1;
      dp.set(m[1], c);
    }
  }
  for (const it of bd.items) {
    it.fits = fitsFor(it.proposal?.tags || []);
    const t = /^tokens\.plant\.([^.]+)$/.exec(it.path);
    if (t && dp.has(t[1])) it.ductPaths = dp.get(t[1]);
  }
}
// Entries touched by the extract/exhaust air question: Exhaust/Return tags, or extract/exhaust wording (in the local language) in their text.
for (const bd of result.buildings) {
  bd.airQuestion = bd.items.filter((it: any) => {
    const tags: string[] = it.proposal?.tags || [];
    const p = it.proposal || {};
    return (tags.some((t) => t === "Exhaust" || t === "Return") && !tags.includes("Water"))
      || /udsug|afkast/i.test([p.meaning, p.danishGloss, p.pattern].join(" "));
  }).map((it: any) => it.path);
}
if (out.endsWith(".html")) {
  const tpl = fs.readFileSync(process.env.REVIEW_TEMPLATE || path.join(__dirname, "review-page", "dictionary-review.template.html"), "utf-8");
  fs.writeFileSync(out, tpl.replace("/*__DATA__*/", () => JSON.stringify(result).replace(/</g, "\\u003c")));
} else fs.writeFileSync(out, JSON.stringify(result));
console.log(`wrote ${out}: ` + result.buildings.map((x: any) => `${x.id} ${x.items.length} items, ${x.legend.length} legend, ${x.accounting.length} accounting, ${x.airQuestion.length} air-question`).join("; ")
  + `; ${Object.keys(result.brickClasses).length} classes, ${Object.keys(result.substances).length} substances`);
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
