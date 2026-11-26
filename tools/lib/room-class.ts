// tools/lib/room-class.ts
// Room / storey classes, exclusions and storey numbering, driven only by the building's
// dictionary word entries (appliesTo roomName/storeyName/useGroup/spaceCategory).

import { PartsDictionary, WordEntry } from "./point-dictionary";
import { wordSpans } from "./point-parts";

export type BrickIndex = { classes: Record<string, { parents?: string[] }> };

type Target = "roomName" | "storeyName" | "useGroup" | "spaceCategory";

export function levelId(n: number): string {
  return n < 0 ? `level-m${-n}` : `level-${n}`;
}

/** Length of the longest whole-word match of `phrase` in `text` (0 = no match). */
function matchLen(phrase: string, text: string): number {
  let best = 0;
  for (const [s, e] of wordSpans(phrase, text)) best = Math.max(best, e - s);
  return best;
}

/** Longest-phrase entry among those for `target` that satisfy `accept`; earlier entry wins ties. */
function bestEntry(
  target: Target,
  text: string | null,
  dict: PartsDictionary,
  accept: (e: WordEntry) => boolean,
): { entry: WordEntry; index: number } | null {
  if (text == null || text.trim() === "") return null;
  let best: { entry: WordEntry; index: number } | null = null;
  let bestLen = 0;
  dict.words.forEach((entry, index) => {
    if (!entry.appliesTo || !entry.appliesTo.includes(target) || !accept(entry)) return;
    const len = matchLen(entry.phrase, text);
    if (len > bestLen) {
      bestLen = len;
      best = { entry, index };
    }
  });
  return best;
}

export function storeyClass(name: string, elevation_mm: number | null, dict: PartsDictionary): string {
  const hit = bestEntry("storeyName", name, dict, (e) => !!e.recClass);
  if (hit) return hit.entry.recClass as string;
  return elevation_mm != null && elevation_mm < 0 ? "rec:BasementLevel" : "rec:Level";
}

export function roomClass(name: string | null, dict: PartsDictionary): { recClass: string; entry?: string } {
  const hit = bestEntry("roomName", name, dict, (e) => !!e.recClass);
  if (hit) return { recClass: hit.entry.recClass as string, entry: `words[${hit.index}]` };
  return { recClass: "rec:Room" };
}

export function isExcluded(kind: "storeyName" | "spaceCategory", value: string | null, dict: PartsDictionary): string | undefined {
  const hit = bestEntry(kind, value, dict, (e) => e.exclude === true);
  return hit ? `words[${hit.index}]` : undefined;
}

export function useGroupClasses(value: string, dict: PartsDictionary): { classes: string[]; entry: string } | null {
  const hit = bestEntry("useGroup", value, dict, (e) => !!e.recClasses && e.recClasses.length > 0);
  return hit ? { classes: hit.entry.recClasses as string[], entry: `words[${hit.index}]` } : null;
}

export function classWithin(cls: string, allowed: string[], index: BrickIndex): boolean {
  if (allowed.includes(cls)) return true;
  const parents = index.classes[cls]?.parents ?? [];
  return parents.some((p) => allowed.includes(p));
}

export function numberStoreys(
  storeys: Array<{ guid: string; name: string; elevation_mm: number | null }>,
  dict: PartsDictionary,
): {
  floors: Array<{ id: string; guid: string; name: string; elevation_mm: number | null; levelNumber: number; levelType: "Level" | "BasementLevel" | "RoofLevel"; recClass: string }>;
  excluded: Array<{ name: string; entry: string }>;
  issues: string[];
} {
  const issues: string[] = [];
  const excluded: Array<{ name: string; entry: string }> = [];
  const kept: Array<{ guid: string; name: string; elevation_mm: number | null }> = [];
  for (const s of storeys) {
    const entry = isExcluded("storeyName", s.name, dict);
    if (entry) excluded.push({ name: s.name, entry });
    else kept.push(s);
  }
  const elev = (s: { elevation_mm: number | null }) => s.elevation_mm ?? 0;
  for (const s of kept) if (s.elevation_mm == null) issues.push(`storey ${s.name} has no elevation`);
  const sorted = [...kept].sort((a, b) => elev(a) - elev(b));

  let zero = sorted.findIndex((s) => elev(s) === 0);
  if (zero < 0) zero = sorted.findIndex((s) => elev(s) > 0);
  if (zero < 0) {
    if (sorted.length > 0) issues.push("no storey at or above elevation 0; level 0 set to the lowest storey");
    zero = 0;
  }

  const floors = sorted.map((s, i) => {
    const levelNumber = i - zero;
    const recClass = storeyClass(s.name, s.elevation_mm, dict);
    const t = recClass.replace(/^rec:/, "");
    const levelType: "Level" | "BasementLevel" | "RoofLevel" = t === "RoofLevel" || t === "BasementLevel" ? t : "Level";
    return { id: levelId(levelNumber), guid: s.guid, name: s.name, elevation_mm: s.elevation_mm, levelNumber, levelType, recClass };
  });
  return { floors, excluded, issues };
}

export function checkRecClasses(dict: PartsDictionary, index: BrickIndex): string[] {
  const errors: string[] = [];
  dict.words.forEach((e, i) => {
    const values = [...(e.recClass ? [e.recClass] : []), ...(e.recClasses ?? [])];
    for (const v of values) if (!index.classes[v]) errors.push(`words[${i}] (${e.phrase}): class ${v} not in the index`);
  });
  return errors;
}
