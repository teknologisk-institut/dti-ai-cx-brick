// tools/lib/plant-class.ts
//
// A plant's Brick class from its parts: the plant override, else the
// plant-token entry + the plant's own name words + the parent plant's medium, matched against
// Brick's Equipment and System class tags; the image equipment composition decides when there is
// no token entry and is the check when there is one.

import type { PartsDictionary } from './point-dictionary'
import type { PointClass, Flag } from './tag-match'
import { CONVENTION_ONLY } from './tag-match'
import { wordSpans } from './point-parts'

export interface PlantClassResult { brickClass: string; flags: Flag[]; sources: string[]; tags: string[] }

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** The plant class the captured equipment types imply (classify-all's former Rule 1), or null. */
export function equipmentComposition(types: string[]): string | null {
  const hasSupplyFan = types.includes('supply_fan')
  const hasReturnFan = types.includes('return_fan') || types.includes('exhaust_fan')
  const hasCoil = types.some(t => ['heating_coil', 'cooling_coil', 'heat_exchanger'].includes(t))
  if (hasSupplyFan && (hasReturnFan || hasCoil)) return 'Air_Handling_Unit'
  if (types.includes('exhaust_fan') && !hasSupplyFan) return 'Exhaust_Fan'
  if (types.includes('fire_damper') && types.every(t => t === 'fire_damper')) return 'Fire_Safety_Equipment'
  if (types.some(t => ['chiller_compressor', 'cooling_unit'].includes(t))) return 'Chiller'
  return null
}

/**
 * The class carrying every own tag (convention-only tags such as District are not matched), most
 * parent tags kept, then fewest tags (besides Equipment/System). Equal rank: own tags before an alias, then by name; a tie
 * with a non-equivalent class is reported.
 */
function matchPlantClass(own: string[], parent: string[], classes: PointClass[]): { cls: PointClass; tie: string[] } | null {
  const want = own.filter(t => !CONVENTION_ONLY.has(t))
  if (want.length === 0) return null
  // The category tags (Equipment, System) are not on every class in the index, so they do not count.
  const size = (c: PointClass) => [...c.tags].filter(t => t !== 'Equipment' && t !== 'System').length
  const elig = classes.filter(c => want.every(t => c.tags.has(t)))
    .map(c => ({ c, kept: parent.filter(t => c.tags.has(t)).length, size: size(c) }))
  if (elig.length === 0) return null
  type E = typeof elig[number]
  const rank = (a: E, b: E) => b.kept - a.kept || a.size - b.size
  elig.sort((a, b) => rank(a, b) || Number(!!a.c.alias) - Number(!!b.c.alias) || (a.c.key < b.c.key ? -1 : a.c.key > b.c.key ? 1 : 0))
  const pick = elig[0]
  const isEquiv = (a: PointClass, b: PointClass) => !!a.equivalents?.includes(b.key) || !!b.equivalents?.includes(a.key)
  const tie = elig.filter(x => x !== pick && rank(x, pick) === 0 && !isEquiv(x.c, pick.c)).map(x => x.c.key)
  return { cls: pick.c, tie }
}

export function classifyPlant(
  dict: PartsDictionary,
  plant: { plantId: string },
  opts: { token: string | null; plantName: string; parentTags: string[]; equipmentTypes: string[] },
  classes: PointClass[]
): PlantClassResult {
  const flags: Flag[] = []
  const id = plant.plantId

  if (hasOwn(dict.plantOverrides, id)) {
    const tags = [...dict.plantOverrides[id].tags]
    const m = matchPlantClass(tags, [], classes)
    if (!m) return { brickClass: 'Equipment', flags: [{ kind: 'no-source', detail: `no Equipment or System class carries [${tags.join(',')}]` }], sources: [`plantOverrides.${id}`], tags }
    if (m.tie.length > 0) flags.push({ kind: 'tie', detail: [m.cls.key, ...m.tie].join(' = ') })
    return { brickClass: m.cls.key, flags, sources: [`plantOverrides.${id}`], tags }
  }

  // Own tags: the token entry and the plant's own name words.
  const own = new Set<string>()
  const ownSources: string[] = []
  const tokenEntry = opts.token !== null && hasOwn(dict.plantTokens, opts.token) ? dict.plantTokens[opts.token] : null
  if (tokenEntry) { for (const t of tokenEntry.tags) own.add(t); ownSources.push(`plantTokens.${opts.token}`) }
  dict.words.forEach((w, i) => {
    if (w.context === 'zone' || !(w.appliesTo ?? []).includes('plantName')) return
    if (wordSpans(w.phrase, opts.plantName).length === 0) return
    for (const t of w.tags) own.add(t)
    ownSources.push(`words[${i}]`)
  })

  const m = matchPlantClass([...own], opts.parentTags, classes)
  const keptParent = m ? opts.parentTags.filter(t => m.cls.tags.has(t)) : []
  const tagClass = m?.cls.key ?? null
  const comp = equipmentComposition(opts.equipmentTypes)

  let brickClass: string
  if (tagClass && (tokenEntry || !comp)) {
    brickClass = tagClass
    if (comp && comp !== tagClass) flags.push({ kind: 'level-conflict', detail: `token/name ${tagClass} vs equipment ${comp}` })
  } else if (comp) {
    brickClass = comp
    if (tagClass && tagClass !== comp) flags.push({ kind: 'level-conflict', detail: `equipment ${comp} vs name ${tagClass}` })
  } else {
    brickClass = 'Equipment'
    flags.push({ kind: 'no-source', detail: own.size > 0 ? `no Equipment or System class carries [${[...own].join(',')}]` : 'no plant override, token entry, name word or equipment' })
  }
  if (m && brickClass === tagClass && m.tie.length > 0) flags.push({ kind: 'tie', detail: [m.cls.key, ...m.tie].join(' = ') })

  const sources: string[] = []
  if (brickClass === tagClass) { sources.push(...ownSources); if (keptParent.length > 0) sources.push('parent') }
  if (brickClass === comp) sources.push('equipment')
  const tags = [...own]
  for (const t of keptParent) if (!own.has(t)) tags.push(t)
  return { brickClass, flags, sources, tags }
}
