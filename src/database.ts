import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isAbsolute, resolve } from "node:path";
import type { ResultSet } from "./format.js";

/**
 * Open a SQLite database file read-only.
 *
 * The connection is opened with `readOnly: true`, so any INSERT/UPDATE/DELETE
 * or schema change fails at the SQLite engine level rather than relying on
 * convention. Relative paths are resolved against the server process's working
 * directory as a best effort, but callers should pass an absolute path. The
 * file must already exist — read-only mode never creates it.
 *
 * A read-only `DatabaseSync` opens lazily: a missing file fails at
 * construction, but a file that exists yet is not a valid SQLite database
 * (corrupt, encrypted, or plain non-SQLite bytes) only fails on first access.
 * We force that access here with a cheap `PRAGMA schema_version` probe so every
 * file-level problem surfaces at open time and callers can classify it as an
 * open error, keeping the open-vs-query error split intact.
 */
export function openDatabase(path: string): DatabaseSync {
  const location = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const db = new DatabaseSync(location, { readOnly: true });
  try {
    db.exec("PRAGMA schema_version");
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore errors closing a handle we are already rejecting */
    }
    throw error;
  }
  return db;
}

/**
 * Prepare a statement and configure it for our output needs:
 *
 *  - `setReadBigInts(true)` reads INTEGER values as BigInt, avoiding an
 *    ERR_OUT_OF_RANGE crash when a column holds an integer larger than
 *    Number.MAX_SAFE_INTEGER (e.g. a big id or timestamp).
 *  - `setReturnArrays(true)` returns each row as a positional value array
 *    rather than a keyed object, so two output columns sharing a name (common
 *    in joins) each keep their value instead of collapsing to one property.
 *
 * These setters — and `columns()`, which `runQuery` calls alongside them to
 * read the header — are all present on any runtime meeting this package's
 * `>=22.16.0` Node engines floor, so they are called directly rather than
 * feature-detected.
 */
function prepare(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  return statement;
}

/**
 * Read every row of a statement as a positional value array aligned to
 * `columns`. When the runtime returned arrays (see `prepare`) they are used
 * as-is; otherwise each object is read by column name as a fallback — correct
 * except for the rare duplicate-column case that array mode fixes.
 */
function readRows(statement: StatementSync, columns: string[], ...params: unknown[]): unknown[][] {
  const raw = statement.all(...(params as never[])) as unknown[];
  return raw.map((row) =>
    Array.isArray(row) ? row : columns.map((column) => (row as Record<string, unknown>)[column]),
  );
}

/**
 * Run a single SQL statement and return its columns and rows.
 *
 * `db.prepare` compiles only the first statement in the string, so a caller
 * that passes multiple statements only executes the first — matching the
 * one-statement-per-call contract. The header is taken authoritatively from
 * the prepared statement's `columns()` metadata (ordered, and preserving
 * duplicate names), so it is identical whether or not any rows match.
 */
export function runQuery(db: DatabaseSync, sql: string): ResultSet {
  let statement: StatementSync;
  let columns: string[];
  try {
    statement = prepare(db, sql);
    columns = statement.columns().map((column) => column.name);
  } catch (error) {
    // node:sqlite does NOT reject empty, whitespace-only, or comment-only SQL
    // at `prepare()`: it returns a statement that compiled to nothing, and the
    // first method call on that statement (a setter inside `prepare`, or
    // `columns()` here) throws an opaque "statement has been finalized"
    // (ERR_INVALID_STATE). We guard the whole prepare+columns sequence so the
    // no-statement case is caught wherever it trips, and turn it into something
    // the caller can act on; other errors (syntax, unknown table) carry a
    // useful message already and are rethrown untouched.
    if (isNoStatementError(error)) {
      throw new Error("no SQL statement to run: `sql` is empty or contains only comments.");
    }
    throw error;
  }
  const rows = readRows(statement, columns);
  return { columns, rows };
}

/** True when `db.prepare` failed because the input held no compilable statement. */
function isNoStatementError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return code === "ERR_INVALID_STATE" || /statement has been finalized/i.test(message);
}

/**
 * List the tables and views in the database, excluding SQLite's internal
 * objects.
 */
export function listTables(db: DatabaseSync): ResultSet {
  return runQuery(
    db,
    `SELECT name, type
       FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  );
}

/**
 * Describe one table or view: its columns, declared types, a not-null flag,
 * default values and primary-key membership.
 *
 * Prefers the `pragma_table_info` table-valued function with a bound parameter
 * (no string interpolation of the table name). Falls back to a classic
 * `PRAGMA table_info(...)` with a safely quoted identifier on runtimes/builds
 * where the table-valued form is unavailable. An empty result means the table
 * or view does not exist.
 *
 * PRAGMA reports both `notnull` and `pk` as integers (`notnull` is 0/1; `pk`
 * is the column's 1-based position within the primary key, 0 if it is not part
 * of it). Both are exposed here as plain booleans — `not_null` and
 * `primary_key` — so the two boolean-like columns present consistently.
 */
export function describeTable(db: DatabaseSync, table: string): ResultSet {
  const columns = ["name", "type", "not_null", "default_value", "primary_key"];
  // Indexes within `columns` of the two values that PRAGMA reports as integers
  // but that we surface as the boolean flags the column names advertise.
  const NOT_NULL_INDEX = 2;
  const PK_INDEX = 4;
  let rows: unknown[][];
  try {
    const statement = prepare(
      db,
      `SELECT name,
              type,
              "notnull"  AS not_null,
              dflt_value AS default_value,
              pk         AS primary_key
         FROM pragma_table_info(?)`,
    );
    // Aliased in `columns` order, so the array rows already line up.
    rows = readRows(statement, columns, table);
  } catch (error) {
    // Only fall back when the table-valued function is unavailable, which
    // surfaces as a SQLite compile error. Anything else (corruption, an
    // out-of-memory condition, …) is a genuine failure and is rethrown rather
    // than masked by silently switching query paths.
    if ((error as { code?: unknown } | null)?.code !== "ERR_SQLITE_ERROR") {
      throw error;
    }
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const statement = prepare(db, `PRAGMA table_info(${quoted})`);
    // PRAGMA table_info columns are [cid, name, type, notnull, dflt_value, pk];
    // pick the ones we expose, in `columns` order.
    rows = readRows(statement, ["cid", "name", "type", "notnull", "dflt_value", "pk"]).map((row) => [
      row[1],
      row[2],
      row[3],
      row[4],
      row[5],
    ]);
  }
  for (const row of rows) {
    row[NOT_NULL_INDEX] = Number(row[NOT_NULL_INDEX]) !== 0;
    row[PK_INDEX] = Number(row[PK_INDEX]) !== 0;
  }
  return { columns, rows };
}
