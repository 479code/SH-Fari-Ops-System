/**
 * csv.ts — spreadsheet-safe CSV serialisation for report exports.
 *
 * Text cells that begin with a formula trigger (= + - @ tab CR) are prefixed with
 * an apostrophe so a malicious customer name cannot execute in Excel. Numbers are
 * written raw so they stay numeric when opened.
 */

export interface CsvColumn {
  key: string;
  label: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: CsvColumn[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map((c) => cell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(","));
  // BOM so Excel detects UTF-8 (₦ and accented names).
  return "﻿" + lines.join("\r\n") + "\r\n";
}
