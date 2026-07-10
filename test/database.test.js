import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, runQuery, listTables, describeTable } from "../dist/database.js";

let dir;
let dbPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-mcp-test-"));
  dbPath = join(dir, "test.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE t(id TEXT, name TEXT)");
  seed.exec("INSERT INTO t VALUES ('a', 'n1'), ('b', 'n2')");
  seed.exec("CREATE TABLE composite(a, b, c, PRIMARY KEY(a, b))");
  seed.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT NOT NULL, nick TEXT)");
  seed.exec("CREATE VIEW v AS SELECT id, name FROM t WHERE id = 'a'");
  // A row whose integer is beyond Number.MAX_SAFE_INTEGER (2^53 - 1) plus a BLOB,
  // to exercise the setReadBigInts wiring and BLOB read path through a real query.
  seed.exec("CREATE TABLE big(n INTEGER, data BLOB)");
  seed.exec("INSERT INTO big VALUES (9007199254740993, x'deadbeef')");
  seed.close();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a self-join keeps every duplicate-named column's value", () => {
  const db = openDatabase(dbPath);
  try {
    const { columns, rows } = runQuery(db, "SELECT * FROM t x JOIN t y ORDER BY x.id, y.id");
    assert.deepEqual(columns, ["id", "name", "id", "name"]);
    // Every one of the 4 output columns retains its own value — object mode
    // would collapse the two `id`/`name` pairs and lose the left-hand values.
    assert.deepEqual(rows, [
      ["a", "n1", "a", "n1"],
      ["a", "n1", "b", "n2"],
      ["b", "n2", "a", "n1"],
      ["b", "n2", "b", "n2"],
    ]);
  } finally {
    db.close();
  }
});

test("aliased duplicate columns keep every value", () => {
  const db = openDatabase(dbPath);
  try {
    const { columns, rows } = runQuery(db, "SELECT id, id AS id, name AS id FROM t ORDER BY id");
    assert.deepEqual(columns, ["id", "id", "id"]);
    assert.deepEqual(rows[0], ["a", "a", "n1"]);
  } finally {
    db.close();
  }
});

test("empty and populated results of the same query share a header", () => {
  const db = openDatabase(dbPath);
  try {
    const populated = runQuery(db, "SELECT id, id AS id, name AS id FROM t");
    const empty = runQuery(db, "SELECT id, id AS id, name AS id FROM t WHERE 1 = 0");
    assert.deepEqual(populated.columns, empty.columns);
    assert.equal(empty.rows.length, 0);
  } finally {
    db.close();
  }
});

test("empty / comment-only SQL gives a clear error", () => {
  const db = openDatabase(dbPath);
  try {
    for (const sql of ["", "   ", "-- just a comment", "/* nothing */", "\n\t"]) {
      assert.throws(() => runQuery(db, sql), /no SQL statement to run/, `sql=${JSON.stringify(sql)}`);
    }
  } finally {
    db.close();
  }
});

test("a genuine SQL error keeps its own message", () => {
  const db = openDatabase(dbPath);
  try {
    assert.throws(() => runQuery(db, "SELECT * FROM nope"), /no such table/);
  } finally {
    db.close();
  }
});

test("read-only connection rejects writes at the engine level", () => {
  const db = openDatabase(dbPath);
  try {
    assert.throws(() => runQuery(db, "INSERT INTO t VALUES ('c', 'n3')"), /readonly|read-only|read only/i);
  } finally {
    db.close();
  }
});

test("listTables excludes sqlite internal objects", () => {
  const db = openDatabase(dbPath);
  try {
    const { columns, rows } = listTables(db);
    assert.deepEqual(columns, ["name", "type"]);
    const names = rows.map((row) => row[0]);
    assert.ok(names.includes("t"));
    assert.ok(!names.some((n) => String(n).startsWith("sqlite_")));
  } finally {
    db.close();
  }
});

test("describeTable exposes a boolean primary_key flag", () => {
  const db = openDatabase(dbPath);
  try {
    const { columns, rows } = describeTable(db, "composite");
    assert.deepEqual(columns, ["name", "type", "not_null", "default_value", "primary_key"]);
    const pkByName = new Map(rows.map((row) => [row[0], row[4]]));
    assert.equal(pkByName.get("a"), true);
    assert.equal(pkByName.get("b"), true);
    assert.equal(pkByName.get("c"), false);
    for (const value of pkByName.values()) assert.equal(typeof value, "boolean");
  } finally {
    db.close();
  }
});

// describeTable's classic `PRAGMA table_info(...)` fallback only runs when the
// preferred `pragma_table_info(?)` table-valued function is unavailable. On
// every supported Node runtime (>=22.16) that function is present and succeeds,
// so the fallback catch branch is unreachable here and cannot be exercised
// without a runtime that lacks table-valued PRAGMAs. Noted rather than forced.
test("describeTable PRAGMA table_info fallback (unreachable on this runtime)", { skip: "pragma_table_info(?) is always available on Node >=22.16" }, () => {});

test("listTables and describeTable cover a view", () => {
  const db = openDatabase(dbPath);
  try {
    const listed = listTables(db);
    const byName = new Map(listed.rows.map((row) => [row[0], row[1]]));
    assert.equal(byName.get("v"), "view");
    // describe_table is documented to work on a view, not just a table.
    const { columns, rows } = describeTable(db, "v");
    assert.deepEqual(columns, ["name", "type", "not_null", "default_value", "primary_key"]);
    assert.deepEqual(
      rows.map((row) => row[0]),
      ["id", "name"],
    );
  } finally {
    db.close();
  }
});

test("a real query preserves a BigInt-range integer and returns a BLOB", () => {
  const db = openDatabase(dbPath);
  try {
    const { columns, rows } = runQuery(db, "SELECT n, data FROM big");
    assert.deepEqual(columns, ["n", "data"]);
    // setReadBigInts keeps the value exact as a BigInt; without it node:sqlite
    // would throw ERR_OUT_OF_RANGE for an integer this large.
    assert.equal(rows[0][0], 9007199254740993n);
    assert.equal(typeof rows[0][0], "bigint");
    assert.ok(rows[0][1] instanceof Uint8Array);
    assert.deepEqual([...rows[0][1]], [0xde, 0xad, 0xbe, 0xef]);
  } finally {
    db.close();
  }
});

test("describeTable exposes not_null as a boolean, consistent with primary_key", () => {
  const db = openDatabase(dbPath);
  try {
    const { rows } = describeTable(db, "u");
    const byName = new Map(rows.map((row) => [row[0], row]));
    // not_null (index 2) and primary_key (index 4) are both real booleans.
    assert.equal(byName.get("email")[2], true);
    assert.equal(byName.get("nick")[2], false);
    assert.equal(byName.get("id")[4], true);
    for (const row of rows) {
      assert.equal(typeof row[2], "boolean", `not_null for ${row[0]}`);
      assert.equal(typeof row[4], "boolean", `primary_key for ${row[0]}`);
    }
  } finally {
    db.close();
  }
});
