// tools/lib/plant-system.ts
// Plant Brick class -> system type, the context the equipment classifier and the equipment audit
// both use. Anything not listed (or undefined) has no system type.

const PLANT_SYSTEM: Record<string, string> = {
  Air_Handling_Unit: 'ventilation',
  Exhaust_Fan: 'ventilation',
  Hot_Water_System: 'heating',
  Chilled_Water_System: 'chilled',
  Chiller: 'chilled',
  Domestic_Hot_Water_System: 'dhw',
  Heat_Pump: 'heating',
}

export function getPlantSystem(plantBrickClass: string | undefined): string | null {
  return (plantBrickClass && PLANT_SYSTEM[plantBrickClass]) || null
}
