// tools/lib/point-parts.ts
//
// A point's contributions: every dictionary source that has something to say about one point, as
// separate tagged entries. The combiner decides per part which level wins; nothing is decided here.

import type { IdParts } from "./point-id";
import { suffixTails, pointGrammar } from "./point-id";
import type { BuildingProfile } from "./building-profile";
import type { PartsDictionary, PartEntry } from "./point-dictionary";
import { unitQuantity } from "./units";

export type Level = "override" | "ductPath" | "suffix" | "desc" | "token" | "unit" | "plant";
export interface Contribution { level: Level; entry: string; tags: string[]; pos: number; span?: [number, number] }
export interface PointInput {
  id: string; context: "zone" | "plant"; parts: IdParts; separator: string;
  description: string; units: string; objectType: string; stateTexts: string[];
  ductPath?: string;            // the point's own, else its base point's (caller resolves)
  plantTags: string[];          // medium tags of the owning plant's Brick class (caller resolves)
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive spans of `phrase` in `text` (whitespace normalised; inner spaces match \s+). */
export function wordSpans(phrase: string, text: string): Array<[number, number]> {
  const words = phrase.trim().toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  const body = words.map(escapeRegex).join("\\s+");
  const re = new RegExp(`(?<!\\p{L})${body}(?!\\p{L})`, "giu");
  const norm = text.replace(/\s+/g, " ").trim();
  const spans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return spans;
}

const DUCT_PATH_TAGS: Record<string, string[]> = {
  supply: ["Air", "Supply"],
  preheat: ["Air", "Supply"],
  return: ["Air", "Return"],
  exhaust: ["Air", "Exhaust"],
  intake: ["Air", "Outside", "Intake"],
  water_supply: ["Water", "Supply"],
  water_return: ["Water", "Return"],
};

/** Medium and stream tags for an image ductPath value; unknown values give none. */
export function ductPathTags(dp: string): string[] {
  return hasOwn(DUCT_PATH_TAGS, dp) ? [...DUCT_PATH_TAGS[dp]] : [];
}

const ctxApplies = (entryCtx: string | undefined, ctx: string) => !entryCtx || entryCtx === "any" || entryCtx === ctx;

export function collectContributions(dict: PartsDictionary, p: PointInput): Contribution[] {
  const out: Contribution[] = [];
  const add = (level: Level, entry: string, e: Pick<PartEntry, "tags">, pos = 0, span?: [number, number]) => {
    out.push(span ? { level, entry, tags: [...e.tags], pos, span } : { level, entry, tags: [...e.tags], pos });
  };

  if (hasOwn(dict.overrides, p.id)) add("override", `overrides.${p.id}`, dict.overrides[p.id]);

  if (p.ductPath) {
    const tags = ductPathTags(p.ductPath);
    if (tags.length > 0) add("ductPath", `ductPath:${p.ductPath}`, { tags });
  }

  // Suffix: tested on each tail; pos = tail start + end of the match in the tail, so the part nearer
  // the end of the id has the larger pos. One contribution per entry, at its largest pos.
  if (p.parts.suffix) {
    const tails = suffixTails(p.parts.suffix, p.separator);
    dict.suffixes.forEach((s, i) => {
      if (!ctxApplies(s.context, p.context)) return;
      const re = new RegExp(s.pattern, s.flags);
      let best = -1;
      for (const t of tails) {
        const m = re.exec(t.text);
        if (m) best = Math.max(best, t.start + m.index + m[0].length);
      }
      if (best >= 0) add("suffix", `suffixes[${i}]`, s, best);
    });
  }

  // Words: description and state texts.
  dict.words.forEach((w, i) => {
    if (!ctxApplies(w.context, p.context)) return;
    const applies = w.appliesTo ?? ["description"];
    if (applies.includes("description")) {
      const spans = wordSpans(w.phrase, p.description);
      if (spans.length > 0) add("desc", `words[${i}]`, w, spans[0][1] - spans[0][0], spans[0]);
    }
    if (applies.includes("stateText") && p.stateTexts.some((t) => wordSpans(w.phrase, t).length > 0)) {
      add("unit", `words[${i}]`, w);
    }
  });

  const tokenTables = [dict.tokens[p.context], dict.tokens.any];
  for (const [ctxName, table] of [[p.context, tokenTables[0]], ["any", tokenTables[1]]] as const) {
    if (table && hasOwn(table, p.parts.token)) {
      add("token", `tokens.${ctxName}.${p.parts.token}`, table[p.parts.token]);
      break;
    }
  }

  const uq = unitQuantity(p.units, dict.units);
  if (uq.tags.length > 0) {
    const key = p.units.trim();
    add("unit", hasOwn(dict.units, key) ? `units.${key}` : `unit:${key}`, { tags: uq.tags });
  }

  if (p.plantTags.length > 0) add("plant", "plant", { tags: p.plantTags });

  return out;
}

/**
 * A point's id parts: the id after "<groupId><separator>" (the whole id when it does not start so),
 * split by the building's grammar. A point part the grammar does not match is all token.
 */
export function idPartsFor(grammar: { split: (pointPart: string) => IdParts; separator: string }, groupId: string, bmsPointId: string): IdParts {
  const prefix = groupId + grammar.separator;
  const pointPart = bmsPointId.startsWith(prefix) ? bmsPointId.slice(prefix.length) : bmsPointId;
  try {
    return grammar.split(pointPart);
  } catch {
    return { token: pointPart, number: "", suffix: null };
  }
}

/**
 * A point's English label (semanticMeaning), first that applies: the override's meaning; the suffix
 * entry matching nearest the end of the id, `{base}` = the token meaning (the token text when there is
 * none) and `{1}`..`{9}` its capture groups; the token meaning, as `<token meaning> (<suffix>)` when the id has a suffix no entry matches; the first
 * word entry found whole-word in the description; the description (the id when the description is
 * empty). `entry` is the dictionary entry the label came from; `unmatchedSuffix` the unmatched suffix.
 */
export function pointLabel(
  dict: PartsDictionary,
  p: { id: string; context: "zone" | "plant"; parts: IdParts; separator: string; description: string }
): { meaning: string; from: "override" | "suffix" | "token" | "word" | "description"; entry?: PartEntry; unmatchedSuffix?: string } {
  if (hasOwn(dict.overrides, p.id)) return { meaning: dict.overrides[p.id].meaning, from: "override", entry: dict.overrides[p.id] };

  let tokenEntry: PartEntry | undefined;
  for (const table of [dict.tokens[p.context], dict.tokens.any]) {
    if (table && hasOwn(table, p.parts.token)) {
      tokenEntry = table[p.parts.token];
      break;
    }
  }
  const tokenMeaning = tokenEntry?.meaning;

  if (p.parts.suffix) {
    let best: { pos: number; entry: PartEntry & { meaning: string }; m: RegExpExecArray } | null = null;
    const tails = suffixTails(p.parts.suffix, p.separator);
    for (const s of dict.suffixes) {
      if (!ctxApplies(s.context, p.context)) continue;
      const re = new RegExp(s.pattern, s.flags);
      for (const t of tails) {
        const m = re.exec(t.text);
        if (!m) continue;
        const pos = t.start + m.index + m[0].length;
        if (!best || pos > best.pos) best = { pos, entry: s, m };
      }
    }
    if (best) {
      const { m } = best;
      const meaning = best.entry.meaning.replace(/\{(base|[1-9])\}/g, (_, k: string) => (k === "base" ? tokenMeaning ?? p.parts.token : m[Number(k)] ?? ""));
      return { meaning, from: "suffix", entry: best.entry };
    }
  }

  // A suffix no suffix entry matches is reported (unmatchedSuffix) and shown in the label.
  const unmatchedSuffix = p.parts.suffix ? p.parts.suffix : undefined;
  const un = unmatchedSuffix ? { unmatchedSuffix } : {};
  if (tokenMeaning !== undefined) {
    const meaning = unmatchedSuffix ? `${tokenMeaning} (${unmatchedSuffix})` : tokenMeaning;
    return { meaning, from: "token", ...(tokenEntry ? { entry: tokenEntry } : {}), ...un };
  }

  for (const w of dict.words) {
    if (!ctxApplies(w.context, p.context) || !(w.appliesTo ?? ["description"]).includes("description")) continue;
    if (wordSpans(w.phrase, p.description).length > 0) return { meaning: w.meaning, from: "word", entry: w, ...un };
  }
  return { meaning: p.description || p.id, from: "description", ...un };
}

/**
 * PointInputs for every point of the plant and zone mapping files (parsed objects, no file IO).
 * The point part is the id after "<groupId><separator>", split by the building's id grammar (or the
 * point's own idParts). ductPath comes from the equipment inventory like classify-all: the plant
 * item named by the point's abbreviation, else (a suffix point) its base point's item.
 * plantClassTags gives the medium tags of a plant's Brick class.
 */
export function pointInputsFromMapping(
  profile: BuildingProfile,
  plantMapping: any,
  zoneMapping: any,
  equipmentInventory: any,
  plantClassTags: (brickClass: string) => string[]
): PointInput[] {
  const { split, separator } = pointGrammar(profile);
  const ductPaths = new Map<string, string>();
  for (const pe of equipmentInventory?.plantEquipment ?? []) {
    for (const eq of pe.equipment ?? []) if (eq.ductPath) ductPaths.set(`${pe.plantId}:${eq.id}`, eq.ductPath);
  }
  const out: PointInput[] = [];
  const add = (context: "zone" | "plant", groupId: string, point: any, plantTags: string[]): void => {
    const id: string = point.bmsPointId;
    const parts: IdParts = point.idParts ?? idPartsFor({ split, separator }, groupId, id);
    let ductPath: string | undefined;
    if (context === "plant") {
      ductPath = ductPaths.get(`${groupId}:${point.pointAbbreviation}`) ?? ductPaths.get(`${groupId}:${parts.token}${parts.number}`);
    }
    const tsdb = point.tsdb ?? {};
    out.push({
      id, context, parts, separator,
      description: point.danishDescription ?? "",
      units: tsdb.units ?? "",
      objectType: tsdb.objectType ?? "",
      stateTexts: Array.isArray(tsdb.stateTexts) ? tsdb.stateTexts : [],
      ...(ductPath ? { ductPath } : {}),
      plantTags,
    });
  };
  for (const plant of plantMapping?.plants ?? []) {
    const tags = plant.brickClass ? plantClassTags(plant.brickClass) : [];
    for (const p of plant.points ?? []) add("plant", plant.plantId, p, tags);
  }
  for (const zone of zoneMapping?.zones ?? []) for (const p of zone.points ?? []) add("zone", zone.zoneId, p, []);
  // Device points (controller-wide): plant context, no plant tags, grouped under the device name.
  for (const device of plantMapping?.devices ?? []) for (const p of device.points ?? []) add("plant", device.deviceName, p, []);
  return out;
}
