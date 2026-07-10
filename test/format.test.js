import { test } from "node:test";
import assert from "node:assert/strict";
import { toTSV } from "../dist/format.js";

test("renders header, body and a pluralised row count", () => {
  const tsv = toTSV({
    columns: ["id", "name"],
    rows: [
      [1, "a"],
      [2, "b"],
    ],
  });
  assert.equal(tsv, "id\tname\n1\ta\n2\tb\n\n2 rows");
});

test("uses the singular 'row' for exactly one row", () => {
  const tsv = toTSV({ columns: ["x"], rows: [[1]] });
  assert.equal(tsv, "x\n1\n\n1 row");
});

test("empty and non-empty results share the same header", () => {
  const columns = ["id", "id", "name"];
  const empty = toTSV({ columns, rows: [] });
  const full = toTSV({ columns, rows: [["a", "b", "c"]] });
  assert.equal(empty.split("\n")[0], "id\tid\tname");
  assert.equal(full.split("\n")[0], "id\tid\tname");
});

test("NULL/undefined become empty fields", () => {
  const tsv = toTSV({ columns: ["a", "b"], rows: [[null, undefined]] });
  assert.equal(tsv, "a\tb\n\t\n\n1 row");
});

test("BigInt values are stringified without loss", () => {
  const big = 9007199254740993n;
  const tsv = toTSV({ columns: ["n"], rows: [[big]] });
  assert.equal(tsv.split("\n")[1], "9007199254740993");
});

test("BLOBs render as SQLite hex literals", () => {
  const tsv = toTSV({ columns: ["b"], rows: [[new Uint8Array([0xde, 0xad, 0xbe, 0xef])]] });
  assert.equal(tsv.split("\n")[1], "x'deadbeef'");
});

test("delimiters and backslashes are escaped", () => {
  const tsv = toTSV({ columns: ["v"], rows: [["a\tb\nc\rd\\e"]] });
  assert.equal(tsv.split("\n")[1], "a\\tb\\nc\\rd\\\\e");
});

test("other control characters are escaped as \\xNN", () => {
  const tsv = toTSV({ columns: ["v"], rows: [["a\x00b\x1bc\x7f"]] });
  assert.equal(tsv.split("\n")[1], "a\\x00b\\x1bc\\x7f");
});

test("booleans render as true/false", () => {
  const tsv = toTSV({ columns: ["pk"], rows: [[true], [false]] });
  assert.equal(tsv, "pk\ntrue\nfalse\n\n2 rows");
});

test("a result with no columns still follows the documented shape", () => {
  const tsv = toTSV({ columns: [], rows: [] });
  assert.equal(tsv, "\n\n0 rows");
});
