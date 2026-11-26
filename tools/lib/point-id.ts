/**
 * point-id.ts -- point-name helpers shared by the timeseries mappers and the dictionary validator.
 */

import { compileRegex } from "./building-profile";
import type { BuildingProfile } from "./building-profile";

/**
 * The separator used to rebuild a BMS point id (`{parent}{sep}{token}`) for comparison with real
 * bmsPointIds: the building's naming.separator (both routes; an error when missing).
 */
export function pointIdSeparator(profile: BuildingProfile): { separator: string; note: string | null } {
  if (!profile.naming?.separator) {
    throw new Error(`${profile.buildingId}: ${profile.dataShape} profile has no naming.separator`);
  }
  return { separator: profile.naming.separator, note: null };
}

/** Compose a BMS point id from its parts with the building's separator. */
export function composePointId(separator: string, ...parts: string[]): string {
  return parts.join(separator);
}

/**
 * First owner (in list order, not `skip`ped) of a bmsPointId under `parentId`: the id after
 * `{parent}{sep}` starts with the owner's eqId and the rest is empty, starts with the separator (sibling or
 * subpoint, e.g. "TR1_SP"), or is a bare lowercase/digit tail ("V1c"). Null when the id is
 * not under the parent or no owner matches.
 */
export function matchPointOwner<T extends { eqId: string }>(
  bmsPointId: string,
  parentId: string,
  owners: T[],
  separator: string,
  skip?: (owner: T) => boolean
): T | null {
  const prefix = parentId + separator;
  if (!bmsPointId.startsWith(prefix)) return null;
  const suffix = bmsPointId.slice(prefix.length);
  for (const o of owners) {
    if (!suffix.startsWith(o.eqId)) continue;
    const rest = suffix.slice(o.eqId.length);
    if (rest === "" || rest.startsWith(separator) || /^[a-z0-9]+$/.test(rest)) {
      if (skip && skip(o)) continue;
      return o;
    }
  }
  return null;
}

/** True when a point's bmsPointId is not `{parent}{sep}{abbr}`, i.e. it is a flattened child of another point. */
export function isFlattenedChildPoint(
  bmsPointId: string | undefined,
  parentId: string,
  abbr: string,
  separator: string
): boolean {
  return !!bmsPointId && bmsPointId !== composePointId(separator, parentId, abbr);
}

/** Composed `{parent}{sep}{equipId}` ids of equipment whose id equals a bare point id of the same parent. */
export function collidingEntityIds(
  owners: { parentId: string; equipment: { id: string }[] }[],
  pointIds: Set<string>,
  separator: string
): Set<string> {
  const out = new Set<string>();
  for (const o of owners) {
    for (const eq of o.equipment) {
      const id = composePointId(separator, o.parentId, eq.id);
      if (pointIds.has(id)) out.add(id);
    }
  }
  return out;
}

/**
 * Equipment id a plant point belongs to: by abbreviation (exact, or id + lowercase/digit/underscore
 * tail), else by the machine-composed bmsPointId `{plant}{sep}{eqId}{sep}{abbr}`. `ids` must be
 * longest-first.
 */
export function correlateEquipmentId(
  ids: string[],
  plantId: string,
  pointAbbreviation: string,
  bmsPointId: string | undefined,
  separator: string
): string | null {
  for (const eqId of ids) {
    if (pointAbbreviation === eqId) return eqId;
    if (pointAbbreviation.startsWith(eqId) && /^[a-z0-9_]*$/.test(pointAbbreviation.slice(eqId.length))) return eqId;
  }
  if (bmsPointId) {
    for (const eqId of ids) {
      if (bmsPointId === composePointId(separator, plantId, eqId, pointAbbreviation)) return eqId;
    }
  }
  return null;
}

/** Group 1 of the building's pointToken match, else the whole name. */
export function extractPointToken(name: string, pointToken: RegExp): string {
  const m = pointToken.exec(name);
  return m ? m[1] : name;
}

// Point names that look splittable (contain the separator) but are one compound-word name,
// not a real base+suffix pair: listed in the profile's naming.unsplittablePointNames
// (passed here upper-cased) and compared case-insensitively.
export function splitPointSuffix(
  pointCol: string,
  separator: string,
  unsplittable: Set<string>
): { base: string; suffix: string | null } {
  if (unsplittable.has(pointCol.toUpperCase())) return { base: pointCol, suffix: null };
  const idx = pointCol.indexOf(separator);
  if (idx === -1) return { base: pointCol, suffix: null };
  return { base: pointCol.substring(0, idx), suffix: pointCol.substring(idx + separator.length) };
}

/** A point part split into its grammar parts: `V1c` -> token V, number 1, suffix c. */
export interface IdParts {
  token: string;
  number: string;
  suffix: string | null;
}

/**
 * The building's point-part grammar. Timeseries: from separator, pointToken and
 * unsplittablePointNames. Bacnet: from naming.pointParts and naming.separator (required).
 */
export function pointGrammar(profile: BuildingProfile): { split: (pointPart: string) => IdParts; separator: string } {
  const naming = profile.naming;
  if (profile.dataShape === "timeseries") {
    if (!naming?.separator || !naming.pointToken) {
      throw new Error(`${profile.buildingId}: timeseries profile needs naming.separator and naming.pointToken`);
    }
    const separator = naming.separator;
    const tokenRe = compileRegex(naming.pointToken);
    const unsplittable = new Set((naming.unsplittablePointNames ?? []).map((n) => n.toUpperCase()));
    return {
      separator,
      split: (pointPart) => {
        if (unsplittable.has(pointPart.toUpperCase())) return { token: pointPart, number: "", suffix: null };
        const { base, suffix } = splitPointSuffix(pointPart, separator, unsplittable);
        const token = extractPointToken(base, tokenRe);
        const number = base.startsWith(token) ? (/^\d*/.exec(base.slice(token.length)) as RegExpExecArray)[0] : "";
        return { token, number, suffix };
      },
    };
  }
  if (!naming?.pointParts) throw new Error(`${profile.buildingId}: bacnet profile has no naming.pointParts`);
  const re = compileRegex(naming.pointParts);
  const { separator } = pointIdSeparator(profile);
  return {
    separator,
    split: (pointPart) => {
      const m = re.exec(pointPart);
      if (!m || !m.groups) throw new Error(`${profile.buildingId}: point part "${pointPart}" does not match naming.pointParts`);
      const rest = m.groups.rest ?? "";
      const stripped = rest.startsWith(separator) ? rest.slice(separator.length) : rest;
      return { token: m.groups.token, number: m.groups.number, suffix: stripped === "" ? null : stripped };
    },
  };
}

/**
 * Tails of a suffix starting at part boundaries (the whole suffix, then after each separator).
 * `offset` is the suffix's start in the full point part; `start`/`end` are positions in the full
 * point part, so a consumer ranks a part by `start` + its match end (the part nearer the end of
 * the id wins).
 */
export function suffixTails(
  suffix: string,
  separator: string,
  offset = 0
): Array<{ text: string; start: number; end: number }> {
  const end = offset + suffix.length;
  const tails = [{ text: suffix, start: offset, end }];
  let i = suffix.indexOf(separator);
  while (i !== -1) {
    const from = i + separator.length;
    const text = suffix.slice(from);
    if (text !== "") tails.push({ text, start: offset + from, end });
    i = suffix.indexOf(separator, from);
  }
  return tails;
}

/** Group 1 of the building's plantToken match on a plant id, or null (no plantToken, or no match). */
export function plantTokenOf(profile: BuildingProfile, plantId: string): string | null {
  const spec = profile.naming?.plantToken;
  if (!spec) return null;
  const m = compileRegex(spec).exec(plantId);
  return m ? m[1] : null;
}

/**
 * A BACnet point's physical-device base: `{token}{number}` from its id parts. Null when the token or the
 * number is empty (the point names no numbered device).
 */
export function bmsDeviceBase(parts: IdParts): string | null {
  return parts.token && parts.number ? `${parts.token}${parts.number}` : null;
}

/**
 * True when an equipment item id is the parent's own trailing device part: the parent id equals it or ends
 * with `{separator}{itemId}` (the plant or zone *is* the device, so it gets no item of its own).
 */
export function isSelfDevice(parentId: string, itemId: string, separator: string): boolean {
  return parentId === itemId || parentId.endsWith(`${separator}${itemId}`);
}
