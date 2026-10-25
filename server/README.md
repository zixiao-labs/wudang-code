# Wudang server

Rust gRPC backend for Wudang. See
[`docs/backend-architecture.mdx`](../docs/backend-architecture.mdx) for the security,
storage, CRDT, Git, and `io_uring` design.

## Requirements

- Rust 1.99+
- PostgreSQL
- Linux kernel 5.10+ only for `wudangd-uring`

## Configure

Copy `.env.example` into your secret manager or shell environment. Do not commit populated
secret files.

Generate independent development secrets:

```sh
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

Use them for `WUDANG_JWT_SECRET_BASE64`, `WUDANG_STORAGE_KEY_BASE64`, and
`WUDANG_REFRESH_PEPPER_BASE64`. They must not reuse the same value.

Remote listeners require `WUDANG_TLS_CERT_PATH` and `WUDANG_TLS_KEY_PATH`. Without TLS the
server starts only on loopback.

## Run

Portable server:

```sh
cargo run -p wudangd
```

Linux server with dedicated `io_uring` Blob workers:

```sh
cargo run -p wudangd-uring
```

The service runs PostgreSQL migrations before opening its gRPC listener. Reflection is
enabled for development tools.

## Verify

```sh
cargo check --workspace
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

Run the ignored end-to-end test against an isolated local database:

```sh
createdb wudang_e2e
WUDANG_E2E_DATABASE_URL=postgresql://localhost/wudang_e2e \
  cargo test -p wudang-api --test e2e -- --ignored --nocapture
dropdb wudang_e2e
```

The test starts a real gRPC listener and covers local registration, JWT authentication,
Refresh Token rotation and replay rejection, hosted bare Git creation, Change Set
application, bidirectional CRDT streaming, and recovery from the encrypted PostgreSQL
journal after a server restart.

## Hosted Git

`RepositoryService.CreateHostedRepository` creates a standard bare repository under
`WUDANG_GIT_ROOT`. This is the control and storage layer; standard Git smart HTTP/SSH is a
separate transport and is not implemented yet. Leave `WUDANG_GIT_PUBLIC_BASE_URL` empty
until that transport is available.

Application-level AES-GCM protects CRDT journals and Blob objects. Bare Git repositories
must live on an encrypted volume so they remain compatible with ordinary Git tooling.
