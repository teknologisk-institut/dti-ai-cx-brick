// Water side positions on equipment items (equipment-inventory/SKILL.md, "Water positions on items").
// An interface plant (a heat exchanger, a hot-water tank with a coil) puts each item on a side:
// primary_* (district/heating side), secondary_* (building side of an exchanger) or dhw_* (domestic side).
// classify-all.ts reads the side for a point's direction and host; update-equipment.ts --validate warns
// when the data cannot support that.

const INTERFACE_SIDE = /^(primary|secondary|dhw)_/;

/** True for a ductPath on a side of a water interface (primary_, secondary_ or dhw_ prefix). */
export function isInterfaceSide(dp: string | undefined | null): boolean {
  return !!dp && INTERFACE_SIDE.test(dp);
}

/** The host role a side gives: primary_ is the district-facing port (inverted polarity), secondary_ and
 *  dhw_ the downstream port; anything else gives none. */
export function sideRole(dp: string | undefined | null): "boundary-primary" | "boundary" | null {
  if (!dp) return null;
  if (dp.startsWith("primary_")) return "boundary-primary";
  if (dp.startsWith("secondary_") || dp.startsWith("dhw_")) return "boundary";
  return null;
}

export interface SidePlant {
  plantId: string;
  ductOrientation?: { referenceEquipment?: string; legend?: Record<string, string> };
  equipment: { id: string; ductPath?: string | null }[];
}

/** --validate warnings: (a) a legend naming interface sides while items carry plain water positions;
 *  (b) items on interface sides while the reference device is not an item. */
export function waterSideWarnings(plants: SidePlant[]): string[] {
  const out: string[] = [];
  for (const p of plants) {
    const sideKeys = Object.keys(p.ductOrientation?.legend ?? {}).filter(isInterfaceSide);
    const plain = p.equipment.filter((e) => e.ductPath === "water_supply" || e.ductPath === "water_return").map((e) => e.id);
    if (sideKeys.length > 0 && plain.length > 0) {
      out.push(`WARN: ${p.plantId} legend names interface sides (${sideKeys.join(", ")}) but items carry plain water positions: ${plain.join(", ")}`);
    }
    if (p.equipment.some((e) => isInterfaceSide(e.ductPath))) {
      const ref = p.ductOrientation?.referenceEquipment;
      if (!p.ductOrientation) out.push(`WARN: ${p.plantId} items carry interface sides but the plant has no ductOrientation (no reference device)`);
      else if (!ref || !p.equipment.some((e) => e.id === ref)) out.push(`WARN: ${p.plantId} items carry interface sides but referenceEquipment ${ref ?? "(none)"} is not an item`);
    }
  }
  return out;
}
