/**
 * bacnet-objects.ts -- BACnet per-device object CSV readers shared by map-bacnet-points.ts
 * and the dictionary validator.
 */
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Minimal RFC-4180 CSV line parser
// Handles quoted fields, commas inside quotes, and doubled "" escapes —
// both devices.csv (e.g. a vendor name such as "Example Controls, Inc.") and the object CSVs
// (e.g. a description with doubled quotes, `"Set ""1"" for on"`, or a
// state-text list `"['Off', 'On']"`).
// Assumes no embedded newlines within a field (true for this data).
// ---------------------------------------------------------------------------

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(field);
        field = "";
      } else {
        field += ch;
      }
    }
  }
  out.push(field);
  return out;
}

export function readCsvRows(filePath: string): string[][] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return content
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map(parseCsvLine);
}

// ---------------------------------------------------------------------------
// Object CSVs
// ---------------------------------------------------------------------------

/** Object CSV file filter: objects_<deviceInstance>_*.csv */
export const OBJECT_FILE_RE = /^objects_\d+_.*\.csv$/i;

export interface ObjectRow {
  objectType: string;
  objectInstance: number;
  objectName: string;
  description: string;
  units: string;
  /** state-text items, then active-text, then inactive-text; empty values dropped */
  stateTexts: string[];
  /** the present-value column ("" when the column is absent) */
  presentValue: string;
}

/** One state-text cell as its items: a list literal "['Off', 'On']" gives each item, any other
 * value is one item. */
function stateTextItems(cell: string): string[] {
  const v = cell.trim();
  if (!(v.startsWith("[") && v.endsWith("]"))) return [v];
  const items: string[] = [];
  for (const m of v.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)) items.push((m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
  return items;
}

export function readObjectRows(filePath: string): ObjectRow[] {
  const rows = readCsvRows(filePath);
  const header = rows[0];
  const iType = header.indexOf("object_type");
  const iInst = header.indexOf("object_instance");
  const iName = header.indexOf("object-name");
  const iDesc = header.indexOf("description");
  const iUnits = header.indexOf("units");
  const iPv = header.indexOf("present-value");
  const [iState, iActive, iInactive] = ["state-text", "active-text", "inactive-text"].map((c) => header.indexOf(c));

  const out: ObjectRow[] = [];
  for (const r of rows.slice(1)) {
    const objectName = (r[iName] || "").trim();
    if (!objectName) continue; // skip blank-named placeholders
    out.push({
      objectType: (r[iType] || "").trim(),
      objectInstance: parseInt(r[iInst], 10),
      objectName,
      description: (r[iDesc] || "").trim(),
      units: (r[iUnits] || "").trim(),
      presentValue: iPv !== -1 ? (r[iPv] || "").trim() : "",
      stateTexts: [
        ...(iState !== -1 ? stateTextItems(r[iState] || "") : []),
        ...[iActive, iInactive].filter((i) => i !== -1).map((i) => r[i] || ""),
      ]
        .map((t) => t.trim())
        .filter((t) => t !== ""),
    });
  }
  return out;
}

/** One record per object row of every object CSV in objectsDir (sorted by file name). */
export function readBacnetObjects(objectsDir: string): Array<{ file: string; objectName: string; description: string }> {
  const out: Array<{ file: string; objectName: string; description: string }> = [];
  for (const file of fs.readdirSync(objectsDir).filter((f) => OBJECT_FILE_RE.test(f)).sort()) {
    for (const o of readObjectRows(path.join(objectsDir, file))) {
      out.push({ file, objectName: o.objectName, description: o.description });
    }
  }
  return out;
}
