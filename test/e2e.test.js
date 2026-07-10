import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end coverage for src/index.ts: spawn the built server over MCP stdio
// with the SDK client and exercise every tool handler, the friendly open-error
// classification (missing file vs non-SQLite file), the "no such table" path,
// the empty-SQL path and read-only write rejection. index.ts is otherwise
// untested, and the missing-vs-invalid-file assertions guard the lazy-open
// regression (a non-SQLite file must still get the friendly, path-including
// message, not a bare "file is not a database").

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let dir;
let dbPath;
let badPath;
let missingPath;
let client;
let transport;

/** Concatenate a tool result's text content. */
function textOf(result) {
  return result.content.map((part) => part.text).join("");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sqlite-mcp-e2e-"));
  dbPath = join(dir, "test.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE t(id TEXT, name TEXT)");
  seed.exec("INSERT INTO t VALUES ('a', 'n1'), ('b', 'n2')");
  seed.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT NOT NULL, nick TEXT)");
  seed.exec("CREATE VIEW v AS SELECT id, name FROM t WHERE id = 'a'");
  // A row whose integer exceeds Number.MAX_SAFE_INTEGER plus a BLOB, so the
  // query tool exercises the setReadBigInts wiring and BLOB rendering end to end.
  seed.exec("CREATE TABLE big(n INTEGER, data BLOB)");
  seed.exec("INSERT INTO big VALUES (9007199254740993, x'deadbeef')");
  seed.close();

  // An existing file that is not a SQLite database. A read-only open of this
  // succeeds lazily, so only the open-time probe forces the error at open time.
  badPath = join(dir, "not-a-db.sqlite");
  writeFileSync(badPath, "this is plain text, definitely not a SQLite database\n");

  missingPath = join(dir, "does-not-exist.db");

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "ignore",
  });
  client = new Client({ name: "e2e-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("list_tables returns the tables as TSV", async () => {
  const result = await client.callTool({ name: "list_tables", arguments: { path: dbPath } });
  assert.notEqual(result.isError, true);
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], "name\ttype");
  const names = lines.slice(1, -2).map((line) => line.split("\t")[0]);
  assert.ok(names.includes("t"));
  assert.ok(names.includes("u"));
});

test("describe_table renders not_null and primary_key as booleans", async () => {
  const result = await client.callTool({
    name: "describe_table",
    arguments: { path: dbPath, table: "u" },
  });
  assert.notEqual(result.isError, true);
  const text = textOf(result);
  assert.equal(text.split("\n")[0], "name\ttype\tnot_null\tdefault_value\tprimary_key");
  // email is NOT NULL, so not_null is the boolean true; id is the primary key.
  assert.match(text, /^email\tTEXT\ttrue\t\tfalse$/m);
  assert.match(text, /^nick\tTEXT\tfalse\t\tfalse$/m);
  assert.match(text, /^id\tINTEGER\tfalse\t\ttrue$/m);
});

test("query returns rows as TSV", async () => {
  const result = await client.callTool({
    name: "query",
    arguments: { path: dbPath, sql: "SELECT id, name FROM t ORDER BY id" },
  });
  assert.notEqual(result.isError, true);
  assert.equal(textOf(result), "id\tname\na\tn1\nb\tn2\n\n2 rows");
});

test("list_tables reports a view with its type", async () => {
  const result = await client.callTool({ name: "list_tables", arguments: { path: dbPath } });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /^v\tview$/m);
});

test("describe_table works on a view", async () => {
  const result = await client.callTool({
    name: "describe_table",
    arguments: { path: dbPath, table: "v" },
  });
  assert.notEqual(result.isError, true);
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], "name\ttype\tnot_null\tdefault_value\tprimary_key");
  const names = lines.slice(1, -2).map((line) => line.split("\t")[0]);
  assert.deepEqual(names, ["id", "name"]);
});

test("query returns a BigInt-range integer intact and a BLOB as a hex literal", async () => {
  const result = await client.callTool({
    name: "query",
    arguments: { path: dbPath, sql: "SELECT n, data FROM big" },
  });
  assert.notEqual(result.isError, true);
  // The large integer round-trips exactly (setReadBigInts avoids ERR_OUT_OF_RANGE
  // and float rounding), and the BLOB renders as a SQLite hex literal.
  assert.equal(textOf(result), "n\tdata\n9007199254740993\tx'deadbeef'\n\n1 row");
});

test("a missing file gives the friendly open error with the path", async () => {
  const result = await client.callTool({
    name: "list_tables",
    arguments: { path: missingPath },
  });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /could not open/);
  assert.ok(text.includes(missingPath), "message should include the path");
});

test("a non-SQLite file gives the friendly not-a-valid-database error (guards lazy-open regression)", async () => {
  for (const name of ["list_tables", "query"]) {
    const args =
      name === "query" ? { path: badPath, sql: "SELECT 1" } : { path: badPath };
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} should error`);
    const text = textOf(result);
    assert.match(text, /is not a valid SQLite database file/, `${name} message`);
    assert.ok(text.includes(badPath), `${name} message should include the path`);
  }
});

test("describe_table reports a clear error for an unknown table", async () => {
  const result = await client.callTool({
    name: "describe_table",
    arguments: { path: dbPath, table: "does_not_exist" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no such table or view/);
});

test("query rejects writes because the connection is read-only", async () => {
  const result = await client.callTool({
    name: "query",
    arguments: { path: dbPath, sql: "INSERT INTO t VALUES ('c', 'n3')" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /readonly|read-only|read only/i);
});

test("query gives a clear error for empty SQL", async () => {
  const result = await client.callTool({
    name: "query",
    arguments: { path: dbPath, sql: "   " },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no SQL statement to run/);
});
