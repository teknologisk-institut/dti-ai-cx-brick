// tools/lib/point-list.ts
// Shared delimited point-list parser (RFC 4180 style quoting). Columns are found by
// header name, so column order does not matter.

export interface PointListFormat {
  delimiter: string;
  columns: { plant: string; point: string; description?: string; alarmClass?: string };
  nullValue?: string;
  skipRows?: Array<{ column: "plant" | "point" | "description" | "alarmClass"; equals: string }>;
}

export interface PointListRow {
  plant: string;
  point: string;
  description: string;
  alarmClass: string;
  /** Original raw record text, without the line terminator. */
  line: string;
}

export interface PointListResult {
  header: string;
  rows: PointListRow[];
  skipped: Record<string, number>;
  missingColumns: string[];
  /** Set when the file is malformed, e.g. "unterminated quote starting in record 7". */
  malformed?: string;
}

interface RawRecord {
  fields: string[];
  line: string;
}

/** Split text into records (quoted fields may contain delimiters, quotes, newlines). */
function splitRecords(text: string, delimiter: string): { records: RawRecord[]; unterminatedAt?: number } {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let start = 0;
  let quoteRecord = 0; // 1-based record in which the open quote started
  const n = text.length;

  const endRecord = (end: number) => {
    fields.push(field);
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    records.push({ fields, line });
    fields = [];
    field = "";
  };

  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
      quoteRecord = records.length + 1;
    } else if (text.startsWith(delimiter, i)) {
      fields.push(field);
      field = "";
      i += delimiter.length - 1;
    } else if (c === "\n") {
      endRecord(i);
      start = i + 1;
    } else if (c === "\r" && text[i + 1] === "\n") {
      // CRLF: the \n ends the record
    } else {
      field += c;
    }
  }
  if (start < n) endRecord(n);
  return inQuotes ? { records, unterminatedAt: quoteRecord } : { records };
}

export function parsePointList(text: string, fmt: PointListFormat): PointListResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const split = splitRecords(text, fmt.delimiter);
  const records = split.records.filter((r) => r.line.trim() !== "");
  const result: PointListResult = { header: "", rows: [], skipped: {}, missingColumns: [] };
  if (split.unterminatedAt !== undefined) result.malformed = `unterminated quote starting in record ${split.unterminatedAt}`;
  if (records.length === 0) {
    result.missingColumns = Object.values(fmt.columns).filter((v): v is string => !!v);
    return result;
  }

  const headerRec = records[0];
  result.header = headerRec.line;
  const index = (name: string | undefined): number => (name === undefined ? -1 : headerRec.fields.indexOf(name));

  const idx = {
    plant: index(fmt.columns.plant),
    point: index(fmt.columns.point),
    description: index(fmt.columns.description),
    alarmClass: index(fmt.columns.alarmClass),
  };
  for (const name of Object.values(fmt.columns)) {
    if (name !== undefined && !headerRec.fields.includes(name)) result.missingColumns.push(name);
  }

  const cell = (rec: RawRecord, i: number): string => {
    if (i < 0) return "";
    const v = rec.fields[i] ?? "";
    return fmt.nullValue !== undefined && v === fmt.nullValue ? "" : v;
  };

  for (const rec of records.slice(1)) {
    const row: PointListRow = {
      plant: cell(rec, idx.plant),
      point: cell(rec, idx.point),
      description: cell(rec, idx.description),
      alarmClass: cell(rec, idx.alarmClass),
      line: rec.line,
    };
    const rule = (fmt.skipRows ?? []).find((s) => row[s.column] === s.equals);
    if (rule) {
      const key = `${rule.column}=${rule.equals}`;
      result.skipped[key] = (result.skipped[key] ?? 0) + 1;
      continue;
    }
    result.rows.push(row);
  }
  return result;
}
