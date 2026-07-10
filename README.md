# deskpro-sqlite-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent query
**SQLite database files** on the local machine.

It uses Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
module, so there is **no native module to compile and no system SQLite to
install** — the only thing you need on the host is a recent Node.

## Requirements

- **Node.js 22.16 or newer** (which ships `node:sqlite` unflagged). Node 24+ is
  recommended.

Check with `node --version`.

## Install

The server is published to npm and is installed into your agent with
[`add-mcp`](https://github.com/neon-solutions/add-mcp):

```bash
npx add-mcp deskpro-sqlite-mcp
```

`add-mcp` detects your installed agents (Claude Code, Claude Desktop, Cursor,
VS Code, …) and registers the server as a local stdio command. Nothing is
cloned or installed globally — the command is fetched and run on demand.

You can also run it directly to sanity-check it:

```bash
npx -y deskpro-sqlite-mcp
```

It speaks MCP over stdio and waits for a client; there is nothing interactive to
see.

## Tools

Every tool takes the database as an argument — `path` should be an **absolute**
path to a `.db` / `.sqlite` file. The database is always opened **read-only**.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_tables` | `path` | The tables and views in the database. |
| `describe_table` | `path`, `table` | Columns, types, a boolean not-null flag, defaults and a boolean primary-key flag for one table or view. |
| `query` | `path`, `sql` | The rows returned by a single read-only SQL statement. |

### Output format

Results come back as **TSV**: a tab-separated header row of column names, one
line per row, then a blank line and a row count. This is used instead of JSON
because it does not repeat column names on every row, keeping the payload small.

- `NULL` is rendered as an empty field.
- Tabs, carriage returns, newlines and backslashes inside values are escaped
  (`\t`, `\r`, `\n`, `\\`). Other control characters are escaped as `\xNN`
  (e.g. NUL as `\x00`).
- BLOBs are rendered as a SQLite hex literal, e.g. `x'deadbeef'`.
- The `describe_table` `not_null` and `primary_key` columns are booleans (`true`/`false`).

### Read-only

The SQLite connection is opened read-only, so `INSERT` / `UPDATE` / `DELETE`
and schema changes fail at the engine level — not merely by convention. The
`query` tool runs a single statement per call and does **not** truncate
results, so a broad `SELECT *` on a large table can return a very large payload;
the tool description tells the agent to add a `LIMIT` and select only needed
columns.

### Security note

This is a local, trust-the-user tool. It will open **any** SQLite file the
operating-system user running the server can already read — there is no
allowlist or directory confinement.

## Development

```bash
npm install      # installs deps and builds via the "prepare" script
npm run build    # compile TypeScript to dist/
```

Source is TypeScript in `src/`; the published package ships compiled JavaScript
in `dist/` (the `bin` entry point). Consumers never run a build step.

### Publishing

`prepublishOnly` compiles before publish, so:

```bash
npm publish
```

## License

MIT
