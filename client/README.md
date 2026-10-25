# Wudang desktop

The Electron host connects directly to the Rust server with native gRPC. The
sandboxed renderer uses a typed, allowlisted preload bridge; it never receives an
access token or refresh token.

## Run

1. Start the server using [`server/README.md`](../server/README.md). Local account
   creation requires `WUDANG_ALLOW_LOCAL_REGISTRATION=true`.
2. From `client/`:

   ```sh
   pnpm install
   pnpm dev
   ```

3. Sign in (or create a local account) in the sidebar. The default server is
   `http://127.0.0.1:50051`. To change the initial address:

   ```sh
   WUDANG_SERVER_URL=https://wudang.example:50051 pnpm dev
   ```

   Remote connections require TLS with normal certificate verification. For an
   internal certificate authority, supply `WUDANG_TLS_CA_PATH=/path/to/ca.pem` to
   the host. Plaintext is accepted only for literal `127.0.0.1` and `[::1]`.

4. Supply an organization UUID to list or create hosted repositories. Then open a
   document using workspace and document IDs. Using the same document ID on two
   desktops opens the same server document; a new ID starts empty. These IDs are
   server resource identifiers, **not local file paths**.
5. Edit and press **Save** or `Cmd/Ctrl+S`. The host sends a UTF-8 delta over
   `SyncDocument`, waits for the server acknowledgement, and displays the server's
   authoritative rendered snapshot. Other desktops receive live updates.

## Current boundaries

- This is explicit-save collaboration, not a complete local CRDT replica.
  Clean buffers follow server snapshots. Remote updates never replace a dirty
  draft: copy the draft before reopening the latest version. Disconnected streams
  become read-only and preserve the buffer; reopen explicitly to reconnect.
  Drafts are memory-only and are not recovered after closing/reloading the app.
- Credentials are memory-only in the host. Restarting the app requires signing in
  again. Logout revokes the refresh token; if the server is unavailable, local
  credentials are still cleared and the revocation failure is displayed.
- The server does not yet expose workspace file-tree/checkout APIs. Repository
  listing does not imply that hosted Git files have been imported into documents.
- Agent threads, runs, tool calls and review diffs remain clearly labelled UI
  previews. The Send action is disabled; no prompts are silently discarded or
  sent to an unrelated RPC. OAuth is not implemented by the server.
- Browser-only previews cannot access the native host and show an explicit notice.
- This connection work does not add organization/document authorization to the
  backend. Do not treat the existing authenticated MVP as a multi-tenant service.

## Protocol and validation

The canonical contracts are in `proto/`. `protocol:generate` embeds their
descriptor in the main-process bundle so production does not require the source
tree. It runs before `dev` and `build`; `protocol:check` detects drift.
`@grpc/grpc-js` and `@grpc/proto-loader` remain external Node runtime dependencies
and must be included when packaging the app.

```sh
pnpm typecheck
pnpm --filter @wudang/desktop protocol:check
pnpm --filter @wudang/desktop test
pnpm build
```

The integration test needs PostgreSQL tools (`initdb`, `postgres`, `pg_isready`)
on `PATH`, plus the built portable Rust server and Electron:

```sh
# From the repository root:
cargo build --manifest-path server/Cargo.toml -p wudangd
cd client
pnpm build
pnpm --filter @wudang/desktop test:e2e
```

It creates its own loopback PostgreSQL cluster under ignored `server/target/`,
uses random ports and in-memory secrets, and removes its state afterward. It
covers authentication/refresh, repositories, two-host Unicode edits, stale-version
rejection, restart recovery, and production Electron forms/preload/IPC/editor save.
It never uses or modifies an existing developer database.
