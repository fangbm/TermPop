import type { TermDictionaryEntry, TermType } from "./types";

const MAX_TERM_LENGTH = 160;
const TERM_TYPES: ReadonlySet<TermType> = new Set(["Tech", "Brand", "Person", "Place", "Acronym", "Custom"]);

export interface DictionaryImportResult {
  entries: TermDictionaryEntry[];
  skipped: number;
}

export function parseDictionaryImport(fileName: string, content: string): DictionaryImportResult {
  const csv = fileName.toLocaleLowerCase().endsWith(".csv");
  return csv ? parseCsvDictionary(content) : parseTextDictionary(content);
}

export function mergeUserDictionary(
  existing: TermDictionaryEntry[],
  imported: TermDictionaryEntry[]
): { entries: TermDictionaryEntry[]; added: number } {
  const entries = [...existing];
  const keys = new Set(entries.map((entry) => termKey(entry.term)));
  let added = 0;

  for (const entry of imported) {
    const key = termKey(entry.term);
    if (!key || keys.has(key)) {
      continue;
    }
    keys.add(key);
    entries.push(entry);
    added += 1;
  }

  return { entries, added };
}

function parseTextDictionary(content: string): DictionaryImportResult {
  const entries: TermDictionaryEntry[] = [];
  let skipped = 0;

  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const entry = normalizeEntry(line);
    if (entry) {
      entries.push(entry);
    } else {
      skipped += 1;
    }
  }

  return { entries, skipped };
}

function parseCsvDictionary(content: string): DictionaryImportResult {
  const rows = parseCsvRows(content.replace(/^\uFEFF/, "")).filter((row) => row.some((value) => value.trim()));
  if (!rows.length) {
    return { entries: [], skipped: 0 };
  }

  const headers = rows[0].map((value) => value.trim().toLocaleLowerCase());
  const termIndex = headers.indexOf("term");
  const hasHeader = termIndex >= 0;
  const kindIndex = headers.indexOf("kind");
  const typeIndex = headers.indexOf("term_type");
  const confidenceIndex = headers.indexOf("confidence");
  const entries: TermDictionaryEntry[] = [];
  let skipped = 0;

  for (const row of hasHeader ? rows.slice(1) : rows) {
    if (hasHeader && kindIndex >= 0) {
      const kind = row[kindIndex]?.trim().toLocaleLowerCase();
      if (kind && kind !== "user_dictionary") {
        continue;
      }
    }
    const entry = normalizeEntry(
      row[hasHeader ? termIndex : 0] ?? "",
      hasHeader ? row[typeIndex] : undefined,
      hasHeader ? row[confidenceIndex] : undefined
    );
    if (entry) {
      entries.push(entry);
    } else if (row.some((value) => value.trim())) {
      skipped += 1;
    }
  }

  return { entries, skipped };
}

function normalizeEntry(term: string, rawType?: string, rawConfidence?: string): TermDictionaryEntry | undefined {
  const normalizedTerm = term.replace(/\s+/g, " ").trim();
  if (!normalizedTerm || normalizedTerm.length > MAX_TERM_LENGTH || /[\u0000-\u001f\u007f]/.test(normalizedTerm)) {
    return undefined;
  }

  const candidateType = rawType?.trim() as TermType | undefined;
  const confidence = Number(rawConfidence);
  return {
    term: normalizedTerm,
    term_type: candidateType && TERM_TYPES.has(candidateType) ? candidateType : "Custom",
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 1
  };
}

function termKey(term: string): string {
  return term.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}
