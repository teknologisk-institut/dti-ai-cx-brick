/**
 * build-brick-relationship-index.ts
 *
 * Extracts structural relationship and external reference definitions from
 * a Brick TTL and outputs a compact relationship index for Phase 6
 * TTL generation.
 *
 * The classification index (brick-classification-index.json) tells you
 * WHAT things are. This relationship index tells you HOW things connect:
 *   - Structural relationships (feeds, hasPoint, hasPart, hasLocation…)
 *   - External reference types (TimeseriesReference, BACnetReference, IFCReference)
 *   - Domain/range constraints from SHACL shapes
 *   - Inverse relationship pairs
 *
 * Usage:
 *   npx ts-node tools/build-brick-relationship-index.ts <ttl_path> <output_path>
 *
 * Example:
 *   npx ts-node tools/build-brick-relationship-index.ts ontologies/Brick_nightly.ttl ontologies/brick-relationship-index.json
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, basename } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface RelationshipEntry {
  label: string;
  definition: string;
  inverse: string | null;
  symmetric: boolean;
  equivalentProperty: string | null;
  domain: string[];   // from SHACL shapes (what subjects use this)
  range: string[];    // from SHACL shapes (what objects are valid)
}

interface ExternalRefType {
  label: string;
  definition: string;
  parentClass: string;
  requiredProperties: { path: string; datatype: string; definition: string }[];
  optionalProperties: { path: string; datatype: string; definition: string }[];
}

interface RefProperty {
  label: string;
  definition: string;
  propertyType: "object" | "datatype";
  range: string | null;
  superProperty: string | null;
}

interface RecSpatialClass {
  label: string;
  comment: string;
  parent: string;             // rdfs:subClassOf
  deprecated: boolean;        // owl:deprecated (for brick: classes)
  replacedBy: string | null;  // brick:isReplacedBy (for deprecated brick: classes)
  properties: { path: string; datatype: string; description: string }[];
}

interface DeprecationMapping {
  deprecated: string;   // e.g. "brick:Building"
  replacement: string;  // e.g. "rec:Building"
  message: string;
}

interface RecSpatialIndex {
  hierarchy: Record<string, RecSpatialClass>;   // rec: spatial classes
  roomSubtypes: string[];                       // all rdfs:subClassOf rec:Room
  levelSubtypes: string[];                      // all rdfs:subClassOf rec:Level
  deprecations: DeprecationMapping[];           // brick: → rec: replacement map
  spatialProperties: Record<string, {
    label: string;
    definition: string;
    inverse: string | null;
    equivalentProperty: string | null;
    subPropertyOf: string | null;
  }>;
}

interface RelationshipIndex {
  meta: {
    source: string;
    generatedAt: string;
    totalRelationships: number;
    totalRefTypes: number;
    totalRefProperties: number;
    totalSpatialClasses: number;
    totalRoomSubtypes: number;
  };
  prefixes: Record<string, string>;
  relationships: Record<string, RelationshipEntry>;
  inversePairs: [string, string][];
  externalReferenceTypes: Record<string, ExternalRefType>;
  referenceProperties: Record<string, RefProperty>;
  spatial: RecSpatialIndex;
  patterns: {
    description: string;
    examples: {
      name: string;
      description: string;
      triples: string[];
    }[];
  };
}

// ─── TTL parsing helpers ────────────────────────────────────────────────────

function parsePrefixes(ttl: string): Record<string, string> {
  const prefixes: Record<string, string> = {};
  const re = /^@prefix\s+(\w*):\s+<([^>]+)>\s*\./gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ttl)) !== null) {
    prefixes[m[1]] = m[2];
  }
  return prefixes;
}

/**
 * Extract a multi-line Turtle block starting at a subject definition
 * and ending at the next `.` on its own or at indentation level 0.
 */
function extractTurtleBlocks(ttl: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = ttl.split("\n");
  let currentSubject: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentSubject && currentLines.length > 0) {
      blocks.set(currentSubject, currentLines.join("\n"));
    }
    currentSubject = null;
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("@prefix") || trimmed === "") {
      if (currentSubject) currentLines.push(line);
      continue;
    }

    // New top-level subject (no leading whitespace)
    const subjectMatch = trimmed.match(/^(brick:|rec:|ref:|bacnet:|bsh:|s223:)(\S+)\s/);
    if (subjectMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentSubject = subjectMatch[1] + subjectMatch[2];
    }

    if (currentSubject) currentLines.push(line);
    if (trimmed === "." && currentSubject) flush();
  }
  flush();

  return blocks;
}

// ─── Extract structural relationships ───────────────────────────────────────

function extractRelationships(blocks: Map<string, string>): Record<string, RelationshipEntry> {
  const relationships: Record<string, RelationshipEntry> = {};

  for (const [subject, blockText] of blocks) {
    // Only brick: prefixed relationships
    if (!subject.startsWith("brick:")) continue;
    // Must be an ObjectProperty AND a brick:Relationship
    if (!blockText.includes("owl:ObjectProperty")) continue;
    if (!blockText.includes("brick:Relationship")) continue;

    const label = extractFirst(blockText, /rdfs:label\s+"([^"]+)"/);
    const definition = extractFirst(blockText, /skos:definition\s+"([^"]+)"/);
    const inverse = extractFirst(blockText, /owl:inverseOf\s+(brick:\w+)/);
    const symmetric = blockText.includes("owl:SymmetricProperty");
    const equivalentProperty = extractFirst(blockText, /owl:equivalentProperty\s+(rec:\w+)/);

    relationships[subject] = {
      label: label || subject.split(":")[1].replace(/_/g, " "),
      definition: definition || "",
      inverse,
      symmetric,
      equivalentProperty,
      domain: [],
      range: [],
    };
  }

  return relationships;
}

function extractFirst(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

// ─── Extract SHACL domain/range constraints ─────────────────────────────────

function enrichWithShaclConstraints(
  relationships: Record<string, RelationshipEntry>,
  blocks: Map<string, string>
): void {
  // Look for SHACL PropertyShapes that constrain relationship paths
  for (const [subject, blockText] of blocks) {
    if (!subject.startsWith("bsh:")) continue;
    if (!blockText.includes("sh:PropertyShape")) continue;

    // Find the relationship path
    const pathMatch = blockText.match(/sh:path\s+(brick:\w+)/);
    if (!pathMatch) continue;
    const relKey = pathMatch[1];
    if (!relationships[relKey]) continue;

    // Extract range classes from sh:class
    const classMatches = blockText.matchAll(/sh:class\s+(brick:\w+|rec:\w+)/g);
    for (const m of classMatches) {
      if (!relationships[relKey].range.includes(m[1])) {
        relationships[relKey].range.push(m[1]);
      }
    }

    // Extract range from sh:or with sh:class
    const orClassMatches = blockText.matchAll(/\[\s*sh:class\s+(brick:\w+|rec:\w+)\s*\]/g);
    for (const m of orClassMatches) {
      if (!relationships[relKey].range.includes(m[1])) {
        relationships[relKey].range.push(m[1]);
      }
    }

    // Extract domain from sh:targetClass
    const targetMatch = blockText.match(/sh:targetClass\s+(brick:\w+|rec:\w+)/);
    if (targetMatch && !relationships[relKey].domain.includes(targetMatch[1])) {
      relationships[relKey].domain.push(targetMatch[1]);
    }
  }
}

// ─── Extract external reference types ───────────────────────────────────────

function extractExternalRefTypes(blocks: Map<string, string>): Record<string, ExternalRefType> {
  const types: Record<string, ExternalRefType> = {};

  const refClasses = ["ref:ExternalReference", "ref:TimeseriesReference", "ref:BACnetReference", "ref:IFCReference"];

  for (const className of refClasses) {
    const blockText = blocks.get(className);
    if (!blockText) continue;

    const label = extractFirst(blockText, /rdfs:label\s+"([^"]+)"/) || className;
    const definition = extractFirst(blockText, /skos:definition\s+"([^"]+)"/) || "";
    const parent = extractFirst(blockText, /rdfs:subClassOf\s+(ref:\w+|s223:\w+)/) || "";

    // Extract properties from SHACL shapes
    const required: ExternalRefType["requiredProperties"] = [];
    const optional: ExternalRefType["optionalProperties"] = [];

    // Match property shapes within the block
    const propRegex = /sh:property\s+\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/gs;
    let pm: RegExpExecArray | null;
    while ((pm = propRegex.exec(blockText)) !== null) {
      const propBlock = pm[1];
      const propPath = extractFirst(propBlock, /sh:path\s+([\w:]+)/);
      const propDatatype = extractFirst(propBlock, /sh:datatype\s+([\w:]+)/) || "";
      const propDef = extractFirst(propBlock, /skos:definition\s+"([^"]+)"/) || "";
      const isRequired = propBlock.includes("sh:minCount 1");

      if (propPath) {
        const entry = { path: propPath, datatype: propDatatype, definition: propDef };
        if (isRequired) required.push(entry);
        else optional.push(entry);
      }
    }

    types[className] = { label, definition, parentClass: parent, requiredProperties: required, optionalProperties: optional };
  }

  return types;
}

// ─── Extract reference properties (ref: namespace) ──────────────────────────

function extractRefProperties(blocks: Map<string, string>): Record<string, RefProperty> {
  const props: Record<string, RefProperty> = {};

  const refPropNames = [
    "ref:hasExternalReference",
    "ref:hasTimeseriesReference",
    "ref:hasTimeseriesId",
    "ref:storedAt",
    "ref:preferred",
  ];

  for (const propName of refPropNames) {
    const blockText = blocks.get(propName);
    if (!blockText) continue;

    const label = extractFirst(blockText, /rdfs:label\s+"([^"]+)"/) || propName;
    const definition = extractFirst(blockText, /skos:definition\s+"([^"]+)"/) || "";
    const isObject = blockText.includes("owl:ObjectProperty");
    const range = extractFirst(blockText, /rdfs:range\s+([\w:]+)/);
    const superProp = extractFirst(blockText, /rdfs:subPropertyOf\s+([\w:]+)/);

    props[propName] = {
      label,
      definition,
      propertyType: isObject ? "object" : "datatype",
      range,
      superProperty: superProp,
    };
  }

  return props;
}

// ─── Build inverse pairs ────────────────────────────────────────────────────

function buildInversePairs(relationships: Record<string, RelationshipEntry>): [string, string][] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();

  for (const [key, rel] of Object.entries(relationships)) {
    if (rel.inverse && !seen.has(key) && !seen.has(rel.inverse)) {
      pairs.push([key, rel.inverse]);
      seen.add(key);
      seen.add(rel.inverse);
    }
  }

  return pairs.sort((a, b) => a[0].localeCompare(b[0]));
}

// ─── Extract REC spatial hierarchy ───────────────────────────────────────

function extractRecSpatialIndex(blocks: Map<string, string>, ttl: string): RecSpatialIndex {
  const hierarchy: Record<string, RecSpatialClass> = {};
  const roomSubtypes: string[] = [];
  const levelSubtypes: string[] = [];
  const deprecations: DeprecationMapping[] = [];

  // --- Extract rec: spatial classes ---
  const recSpatialClasses = [
    "rec:Space", "rec:Architecture", "rec:Building", "rec:Site", "rec:Region",
    "rec:Wing", "rec:Level", "rec:BasementLevel", "rec:MezzanineLevel",
    "rec:RoofLevel", "rec:Room",
  ];

  for (const className of recSpatialClasses) {
    const blockText = blocks.get(className);
    if (!blockText) continue;

    const label = extractFirst(blockText, /rdfs:label\s+"([^"]+)"/) || className.split(":")[1];
    const comment = extractFirst(blockText, /rdfs:comment\s+"([^"]+)"/) || "";
    const parent = extractFirst(blockText, /rdfs:subClassOf\s+(rec:\w+|rdfs:\w+)/) || "";

    // Extract SHACL properties
    const properties: RecSpatialClass["properties"] = [];
    const propRegex = /sh:property\s+\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/gs;
    let pm: RegExpExecArray | null;
    while ((pm = propRegex.exec(blockText)) !== null) {
      const propBlock = pm[1];
      const propPath = extractFirst(propBlock, /sh:path\s+([\w:]+)/);
      const propDatatype = extractFirst(propBlock, /sh:datatype\s+([\w:]+)/) ||
                           extractFirst(propBlock, /sh:class\s+([\w:]+)/) || "";
      const propDesc = extractFirst(propBlock, /skos:definition\s+"([^"]+)"/) ||
                       extractFirst(propBlock, /rdfs:comment\s+"([^"]+)"/) || "";
      if (propPath) {
        properties.push({ path: propPath, datatype: propDatatype, description: propDesc });
      }
    }

    hierarchy[className] = { label, comment, parent, deprecated: false, replacedBy: null, properties };
  }

  // --- Find all rec:Room subtypes ---
  for (const [subject, blockText] of blocks) {
    if (!subject.startsWith("rec:")) continue;
    if (blockText.includes("rdfs:subClassOf rec:Room")) {
      roomSubtypes.push(subject);
    }
    if (blockText.includes("rdfs:subClassOf rec:Level")) {
      levelSubtypes.push(subject);
    }
  }
  roomSubtypes.sort();
  levelSubtypes.sort();

  // --- Find deprecated brick: location classes and their rec: replacements ---
  const deprecatedLocationClasses = [
    "brick:Building", "brick:Floor", "brick:Storey", "brick:Room",
    "brick:Space", "brick:Site", "brick:Region", "brick:Wing", "brick:Location",
  ];

  for (const className of deprecatedLocationClasses) {
    const blockText = blocks.get(className);
    if (!blockText) continue;

    const isDeprecated = blockText.includes("owl:deprecated true");
    const replacedBy = extractFirst(blockText, /brick:isReplacedBy\s+(rec:\w+)/);
    const message = extractFirst(blockText, /brick:deprecationMessage\s+"([^"]+)"/) || "";

    if (isDeprecated && replacedBy) {
      deprecations.push({ deprecated: className, replacement: replacedBy, message });
    }
  }

  // --- Extract rec: spatial properties ---
  const spatialProperties: RecSpatialIndex["spatialProperties"] = {};
  const recPropNames = [
    "rec:locatedIn", "rec:isLocationOf", "rec:hasPart", "rec:isPartOf", "rec:includes",
  ];

  for (const propName of recPropNames) {
    const blockText = blocks.get(propName);
    if (!blockText) continue;

    const label = extractFirst(blockText, /rdfs:label\s+"([^"]+)"/) || propName;
    const definition = extractFirst(blockText, /skos:definition\s+"([^"]+)"/) || "";
    const inverse = extractFirst(blockText, /owl:inverseOf\s+([\w:]+)/);
    const equivalentProperty = extractFirst(blockText, /owl:equivalentProperty\s+([\w:]+)/);
    const subPropertyOf = extractFirst(blockText, /rdfs:subPropertyOf\s+([\w:]+)/);

    spatialProperties[propName] = { label, definition, inverse, equivalentProperty, subPropertyOf };
  }

  return { hierarchy, roomSubtypes, levelSubtypes, deprecations, spatialProperties };
}

// ─── Build usage patterns section ───────────────────────────────────────────

function buildPatterns(): RelationshipIndex["patterns"] {
  return {
    description:
      "Common triple patterns for AI-CX building models. " +
      "Use these as templates when generating TTL in Phase 6.",
    examples: [
      {
        name: "Equipment → Point (sensor/setpoint linkage)",
        description:
          "Every sensor, setpoint, command, or status is a brick:Point attached " +
          "to its parent Equipment or Location via brick:hasPoint.",
        triples: [
          "bldg:VE01 a brick:Air_Handling_Unit .",
          "bldg:VE01_TI1 a brick:Supply_Air_Temperature_Sensor .",
          "bldg:VE01 brick:hasPoint bldg:VE01_TI1 .",
        ],
      },
      {
        name: "Equipment composition (hasPart)",
        description:
          "Physical containment — a damper, valve, or fan is part of an AHU or VAV.",
        triples: [
          "bldg:VE01 a brick:Air_Handling_Unit .",
          "bldg:VE01_SF1 a brick:Supply_Fan .",
          "bldg:VE01 brick:hasPart bldg:VE01_SF1 .",
        ],
      },
      {
        name: "Flow topology (feeds)",
        description:
          "Upstream/downstream flow — heating plant feeds AHU feeds Zone.",
        triples: [
          "bldg:VA07 brick:feeds bldg:VE01 .",
          "bldg:VE01 brick:feeds bldg:Z_101 .",
        ],
      },
      {
        name: "Spatial location (hasLocation)",
        description:
          "Equipment or zones located in a physical space.",
        triples: [
          "bldg:VE01 brick:hasLocation bldg:level_1 .",
          "bldg:Z_101 brick:hasLocation bldg:room_1_01 .",
        ],
      },
      {
        name: "Timeseries reference (TSDB linkage)",
        description:
          "Connects a Brick Point to its timeseries data in TimescaleDB. " +
          "This is the critical link between the semantic model and live data. " +
          "ref:hasTimeseriesId holds the object name from objects.json (tsdb.id).",
        triples: [
          "bldg:Z_102_TS1 a brick:Zone_Air_Temperature_Sensor .",
          'bldg:Z_102_TS1 ref:hasExternalReference [',
          '    a ref:TimeseriesReference ;',
          '    ref:hasTimeseriesId "Z_102_TS1" ;',
          '] .',
        ],
      },
      {
        name: "Metering (meters)",
        description:
          "A meter measures consumption/production of a substance for an entity.",
        triples: [
          "bldg:VA07_QM1 a brick:Thermal_Power_Meter .",
          "bldg:VA07_QM1 brick:meters bldg:VA07 .",
        ],
      },
      {
        name: "Spatial hierarchy (REC containment)",
        description:
          "Building → Level → Room containment uses rec: classes (brick: location classes " +
          "are deprecated in 1.4.4). Space-to-space uses rec:isPartOf/rec:hasPart.",
        triples: [
          "bldg:Building a rec:Building .",
          "bldg:level_1 a rec:Level ; rec:levelNumber 1 ; rec:isPartOf bldg:Building .",
          "bldg:room_1_02 a rec:Office ; rec:isPartOf bldg:level_1 .",
        ],
      },
      {
        name: "Zone/equipment placement (hasLocation)",
        description:
          "Non-spatial entities (zones, equipment) placed in a space use " +
          "brick:hasLocation (equivalent to rec:locatedIn), not rec:isPartOf.",
        triples: [
          "bldg:Z_102 a brick:HVAC_Zone ; brick:hasLocation bldg:room_1_02 .",
          "bldg:VE01 a brick:Air_Handling_Unit ; brick:hasLocation bldg:level_1 .",
        ],
      },
    ],
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: npx ts-node tools/build-brick-relationship-index.ts <ttl_path> <output_path>"
    );
    console.error(
      "Example: npx ts-node tools/build-brick-relationship-index.ts ontologies/Brick_nightly.ttl ontologies/brick-relationship-index.json"
    );
    process.exit(1);
  }

  const ttlPath = resolve(args[0]);
  const outputPath = resolve(args[1]);

  console.log(`Reading: ${ttlPath}`);
  const ttl = readFileSync(ttlPath, "utf-8");
  console.log(`File size: ${(ttl.length / 1024 / 1024).toFixed(1)}MB`);

  const prefixes = parsePrefixes(ttl);
  console.log(`Prefixes found: ${Object.keys(prefixes).join(", ")}`);

  console.log("Extracting Turtle blocks...");
  const blocks = extractTurtleBlocks(ttl);
  console.log(`Total blocks: ${blocks.size}`);

  console.log("Extracting structural relationships...");
  const relationships = extractRelationships(blocks);
  console.log(`  Structural relationships: ${Object.keys(relationships).length}`);

  console.log("Enriching with SHACL domain/range constraints...");
  enrichWithShaclConstraints(relationships, blocks);

  console.log("Extracting external reference types...");
  const externalReferenceTypes = extractExternalRefTypes(blocks);
  console.log(`  External reference types: ${Object.keys(externalReferenceTypes).length}`);

  console.log("Extracting reference properties...");
  const referenceProperties = extractRefProperties(blocks);
  console.log(`  Reference properties: ${Object.keys(referenceProperties).length}`);

  const inversePairs = buildInversePairs(relationships);
  console.log(`  Inverse pairs: ${inversePairs.length}`);

  console.log("Extracting REC spatial hierarchy...");
  const spatial = extractRecSpatialIndex(blocks, ttl);
  console.log(`  Spatial classes:  ${Object.keys(spatial.hierarchy).length}`);
  console.log(`  Room subtypes:    ${spatial.roomSubtypes.length}`);
  console.log(`  Level subtypes:   ${spatial.levelSubtypes.length}`);
  console.log(`  Deprecations:     ${spatial.deprecations.length}`);
  console.log(`  Spatial props:    ${Object.keys(spatial.spatialProperties).length}`);

  const patterns = buildPatterns();

  const output: RelationshipIndex = {
    meta: {
      source: basename(ttlPath),
      generatedAt: new Date().toISOString(),
      totalRelationships: Object.keys(relationships).length,
      totalRefTypes: Object.keys(externalReferenceTypes).length,
      totalRefProperties: Object.keys(referenceProperties).length,
      totalSpatialClasses: Object.keys(spatial.hierarchy).length,
      totalRoomSubtypes: spatial.roomSubtypes.length,
    },
    prefixes: {
      brick: prefixes["brick"] || "https://brickschema.org/schema/Brick#",
      rec: prefixes["rec"] || "https://w3id.org/rec#",
      ref: prefixes["ref"] || "https://brickschema.org/schema/Brick/ref#",
    },
    relationships,
    inversePairs,
    externalReferenceTypes,
    referenceProperties,
    spatial,
    patterns,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\nRelationship index written: ${outputPath}`);
  console.log(`  Relationships:    ${output.meta.totalRelationships}`);
  console.log(`  Ref types:        ${output.meta.totalRefTypes}`);
  console.log(`  Ref properties:   ${output.meta.totalRefProperties}`);
  console.log(`  Spatial classes:  ${output.meta.totalSpatialClasses}`);
  console.log(`  Room subtypes:    ${output.meta.totalRoomSubtypes}`);
  console.log(`  Inverse pairs:    ${inversePairs.length}`);
  console.log(`  Usage patterns:   ${patterns.examples.length}`);
  console.log(`  Output size:      ~${(JSON.stringify(output).length / 1024).toFixed(0)}KB`);
}

main();
