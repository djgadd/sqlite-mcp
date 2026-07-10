/**
 * A query result: the ordered column names and the rows as positional value
 * arrays.
 *
 * Rows are arrays rather than keyed objects so that two output columns sharing
 * a name (common in joins, e.g. `SELECT * FROM t a JOIN t b`) each keep their
 * own value instead of collapsing to a single object property. `rows[i][j]` is
 * the value for `columns[j]`.
 */
export interface ResultSet {
  columns: string[];
  rows: unknown[][];
}

/**
 * Render a single cell value for TSV output.
 *
 * NULL becomes an empty string. BLOBs (Uint8Array) are rendered as a SQLite
 * hex literal. Backslashes and the structural delimiters (tab, CR, LF) are
 * escaped so that every row stays on exactly one line and the columns line up
 * unambiguously. Any remaining control characters (NUL, VT, FF, ESC, …) are
 * escaped as `\xNN` so they cannot corrupt terminal rendering or a downstream
 * parser; because a literal backslash is escaped first, these escapes stay
 * reversible.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) {
    return `x'${Buffer.from(value).toString("hex")}'`;
  }
  const text = typeof value === "bigint" ? value.toString() : String(value);
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * Serialise a result set as TSV: a header row of column names, one
 * tab-separated line per row, then a blank line and a row count.
 *
 * TSV is used instead of JSON because it does not repeat the column names on
 * every row, which keeps the payload small for a model to read. A result with
 * no columns degenerates gracefully to an empty header line followed by the
 * blank line and count, keeping the shape identical for every query.
 */
export function toTSV({ columns, rows }: ResultSet): string {
  const header = columns.join("\t");
  const body = rows.map((row) => row.map((value) => escapeCell(value)).join("\t"));
  const footer = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  return [header, ...body, "", footer].join("\n");
}
