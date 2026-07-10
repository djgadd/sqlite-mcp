#!/usr/bin/env node
import "./bootstrap.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { describeTable, listTables, openDatabase, runQuery } from "./database.js";
import { toTSV } from "./format.js";

// Single source of truth for the version: read it from the package manifest
// (which npm always ships) relative to this module, rather than duplicating the
// literal and risking drift on a version bump.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * The MCP SDK's CallToolResult type is structurally "loose" (it carries a
 * `[k: string]: unknown` index signature), so a named interface must include
 * the same catch-all to be assignable to it. We deliberately keep the typed
 * fields above it for the shape we actually return; the index signature exists
 * only for that SDK compatibility, not as an invitation to add fields.
 */
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Turn a low-level SQLite/filesystem error into a message the model can act on. */
function describeError(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unable to open|ENOENT|no such file|cannot open/i.test(message)) {
    return `could not open "${path}" — file not found or not readable. Pass an absolute path to an existing SQLite database file.`;
  }
  if (/not a database|file is encrypted|malformed/i.test(message)) {
    return `"${path}" is not a valid SQLite database file.`;
  }
  // Any other open-time failure (e.g. a directory path, which SQLite reports as
  // "disk I/O error") is unclassified; still surface the raw engine message,
  // but prefix it with the path so the caller has context like the cases above.
  return `could not open "${path}": ${message}`;
}

/**
 * Open the database read-only, run `fn`, and always close the handle.
 *
 * Open/filesystem failures are classified by `describeError` into an
 * actionable message; errors thrown while `fn` runs the query are genuine
 * SQLite/engine errors, so their real message is surfaced verbatim. All three
 * tools share this handling.
 */
function withDatabase(path: string, fn: (db: DatabaseSync) => ToolResult): ToolResult {
  let db: DatabaseSync;
  try {
    db = openDatabase(path);
  } catch (error) {
    return errorResult(describeError(error, path));
  }
  try {
    return fn(db);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      db.close();
    } catch {
      /* ignore errors closing the handle */
    }
  }
}

const server = new McpServer({
  name: "deskpro-sqlite-mcp",
  version,
});

server.registerTool(
  "list_tables",
  {
    title: "List tables",
    description:
      "List the names of all tables and views in a SQLite database file. `path` must be an absolute filesystem path to the .db/.sqlite file.",
    inputSchema: {
      path: z.string().describe("Absolute path to the SQLite database file."),
    },
  },
  async ({ path }) => withDatabase(path, (db) => textResult(toTSV(listTables(db)))),
);

server.registerTool(
  "describe_table",
  {
    title: "Describe table",
    description:
      "Describe the schema of a single table or view: its columns, declared types, a boolean not-null flag (true when the column is NOT NULL), default values and a boolean primary-key flag (true when the column is part of the primary key). `path` must be an absolute path; `table` is the table or view name.",
    inputSchema: {
      path: z.string().describe("Absolute path to the SQLite database file."),
      table: z.string().describe("Name of the table or view to describe."),
    },
  },
  async ({ path, table }) =>
    withDatabase(path, (db) => {
      const result = describeTable(db, table);
      if (result.rows.length === 0) {
        return errorResult(`no such table or view: "${table}"`);
      }
      return textResult(toTSV(result));
    }),
);

server.registerTool(
  "query",
  {
    title: "Run a read-only SQL query",
    description:
      "Run a single read-only SQL statement against a SQLite database file and return the rows as TSV (a tab-separated header row of column names, then one line per row). " +
      "The database is opened read-only, so INSERT/UPDATE/DELETE and schema changes will fail. " +
      "Exercise caution: results are NOT truncated, so a broad query like `SELECT * FROM big_table` can return an enormous result set — add a LIMIT and select only the columns you need. " +
      "`path` must be an absolute filesystem path; `sql` must be a single statement.",
    inputSchema: {
      path: z.string().describe("Absolute path to the SQLite database file."),
      sql: z.string().describe("A single read-only SQL statement to execute."),
    },
  },
  async ({ path, sql }) => withDatabase(path, (db) => textResult(toTSV(runQuery(db, sql)))),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The stdio transport normally closes on stdin EOF; also exit cleanly if the
  // host signals termination. Database handles are opened and closed per call,
  // so there is no long-lived state to unwind here.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error("Fatal error starting deskpro-sqlite-mcp:", error);
  process.exit(1);
});
