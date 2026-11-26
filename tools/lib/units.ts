// tools/lib/units.ts
// BMS unit string -> QUDT URI mapping, shared by the TTL generator and its reports.

export const unitMap: Record<string, string> = {
  // Timeseries symbol forms (from objects.json)
  '°C': 'unit:DEG_C',
  '%': 'unit:PERCENT',
  'ppm': 'unit:PPM',
  'Pa': 'unit:PA',
  'm³/h': 'unit:M3-PER-HR',
  '%RH': 'unit:PERCENT_RH',
  'bar': 'unit:BAR',
  // BACnet engineering-unit names (from the per-device scrape).
  // 'no-units' is intentionally omitted — no brick:hasUnit emitted.
  'percent': 'unit:PERCENT',
  'degrees-celsius': 'unit:DEG_C',
  'parts-per-million': 'unit:PPM',
  'cubic-meters-per-hour': 'unit:M3-PER-HR',
  'liters-per-hour': 'unit:L-PER-HR',
  'cubic-meters': 'unit:M3',
  'pascals': 'unit:PA',
  'kilowatts': 'unit:KiloW',
  'watts': 'unit:W',
  'kilowatt-hours': 'unit:KiloW-HR',
  'megawatt-hours': 'unit:MegaW-HR',
  'seconds': 'unit:SEC',
  'minutes': 'unit:MIN',
  'hours': 'unit:HR',
  'degrees-angular': 'unit:DEG',
  'luxes': 'unit:LUX',
  'volts': 'unit:V',
  'ohms': 'unit:OHM',
  'amperes': 'unit:A',
  'percent-relative-humidity': 'unit:PERCENT_RH',
  'revolutions-per-minute': 'unit:REV-PER-MIN',
  'meters-per-second': 'unit:M-PER-SEC',
}

/** BACnet's "no-units" engineering-unit value means no unit (the raw value stays in the data). */
function isNoUnits(u: string): boolean {
  return (u ?? '').trim().toLowerCase() === 'no-units'
}

/** QUDT URI for a BMS unit string, or undefined (own keys only, so "constructor" is unmapped). */
export function unitUri(u: string): string | undefined {
  if (isNoUnits(u)) return undefined
  return Object.prototype.hasOwnProperty.call(unitMap, u) ? unitMap[u] : undefined
}

/** Non-empty unit strings with no unitMap entry, as unit -> occurrence count. */
export function unmappedUnits(units: string[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  for (const u of units) {
    if (!u || isNoUnits(u) || Object.prototype.hasOwnProperty.call(unitMap, u)) continue
    counts[u] = (counts[u] || 0) + 1
  }
  return counts
}

// Standard BACnet engineering-unit names -> quantity tag (a fixed standard list, not building-specific).
const unitQuantityTable: Record<string, string> = {
  'degrees-celsius': 'Temperature',
  'pascals': 'Pressure',
  'kilopascals': 'Pressure',
  'bars': 'Pressure',
  'cubic-meters-per-hour': 'Flow',
  'liters-per-hour': 'Flow',
  'liters-per-second': 'Flow',
  'parts-per-million': 'CO2',
  'percent-relative-humidity': 'Humidity',
  'watts': 'Power',
  'kilowatts': 'Power',
  'kilowatt-hours': 'Energy',
  'megawatt-hours': 'Energy',
  'luxes': 'Illuminance',
  'cubic-meters': 'Volume',
  // Brick tags outside the decided quantity part (a union tag on the point)
  'amperes': 'Current',
  'revolutions-per-minute': 'Speed',
  'meters-per-second': 'Speed',
  'volts': 'Voltage',
}

/**
 * Quantity tags for a unit string. Dictionary `units` entries win over the generic table; `%`,
 * `percent`, `no-units` and empty give no tags (known); anything else is unknown (never blocks).
 */
export function unitQuantity(
  u: string,
  dictUnits: Record<string, { tags: string[] }>
): { tags: string[]; known: boolean } {
  const s = (u ?? '').trim()
  if (isNoUnits(s)) return { tags: [], known: true }
  if (Object.prototype.hasOwnProperty.call(dictUnits, s)) return { tags: [...dictUnits[s].tags], known: true }
  const key = s.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(unitQuantityTable, key)) return { tags: [unitQuantityTable[key]], known: true }
  if (key === '' || key === '%' || key === 'percent' || key === 'no-units') return { tags: [], known: true }
  return { tags: [], known: false }
}
