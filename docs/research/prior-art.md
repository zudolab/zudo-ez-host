# Prior-art distillation

This memo records the verified mechanisms that are most relevant to ez-host. It
uses the repository snapshots below; statements labelled **Inference** are the
design conclusions drawn for ez-host rather than claims made by the source.

| System                    | Verified snapshot                                                                                                                                     | Primary reference                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| zudo-file-sync            | `4e5093754405c14bfeb5b8fdf4f89cd541cbcd21`                                                                                                            | [zudolab/zudo-file-sync](https://github.com/zudolab/zudo-file-sync/tree/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21)                         |
| zudo-text                 | current `3346d5b92caa4409d7b2cc486222f9302760b730`; lineage `efd63990158dd0e3df4d56b3893b10ffef67120b` and `ad69fa7198f04d2da71cb556c9debea557e07913` | [zudolab/zudo-text](https://github.com/zudolab/zudo-text/tree/3346d5b92caa4409d7b2cc486222f9302760b730)                                   |
| zudo-doc-cloud            | `06a1cd18dca48511c8b533ac5fa42b6669c08131`                                                                                                            | [zudolab/zudo-doc-cloud](https://github.com/zudolab/zudo-doc-cloud/tree/06a1cd18dca48511c8b533ac5fa42b6669c08131)                         |
| zfb-example-password-gate | `72d2fbb5c9992e9125e66fde519422fff834926f`                                                                                                            | [Takazudo/zfb-example-password-gate](https://github.com/Takazudo/zfb-example-password-gate/tree/72d2fbb5c9992e9125e66fde519422fff834926f) |

## zudo-file-sync: a Cloudflare-only bidirectional file sync

Source: [github.com/zudolab/zudo-file-sync](https://github.com/zudolab/zudo-file-sync), verified at commit [`4e5093754405c14bfeb5b8fdf4f89cd541cbcd21`](https://github.com/zudolab/zudo-file-sync/commit/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21). The repository was archived on 2026-05-07. The paths below are the checked-out source paths, not inferred package names.

### Storage and diff protocol

`packages/sync-worker/CLAUDE.md` documents the storage contract:

- `FILES_BUCKET` is an R2 bucket containing file bytes at
  `{vaultId}/{filePath}`.
- `VAULT_META` is a KV namespace. It stores `user:{userId}:vaults`,
  `vault:{id}`, `vault:{vaultId}:files`, `vault:{vaultId}:status`, and
  `vault:{vaultId}:last-sync-hashes`.
- Every sync-worker route is authenticated with a JWT before the handler runs.

The implementation in
[`packages/sync-worker/src/handlers/files.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-worker/src/handlers/files.ts)
hashes uploaded bytes with `hashContent`, writes the bytes to R2, and stores a
`SyncFile` record (`path`, SHA-256 `hash`, size, `lastModified`, and `vaultId`)
in KV. File paths are validated before forming the R2 key.

[`packages/sync-worker/src/handlers/sync.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-worker/src/handlers/sync.ts)
implements `POST /vaults/:id/sync`. A client sends a manifest of path/hash/size/
timestamp entries. The handler loads the server manifest and the
`last-sync-hashes` baseline, unions all paths, and returns a `SyncDiff` with:

- `toUpload` when the client has a new or changed file;
- `toDownload` when the server has a new or changed file;
- `toTrash` when a server deletion should propagate to an unchanged client;
- `conflicts` when both sides changed since the same baseline.

The baseline is deliberately not advanced for unresolved conflicts or paths
still pending transfer. That avoids turning a client crash between diff and
transfer into a false clean baseline.

[`packages/sync-worker/src/utils/conflict.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-worker/src/utils/conflict.ts)
defines the three conflict types in `packages/sync-worker/src/types/sync.ts`:

- `both-modified`: local and remote hashes both differ from the baseline;
- `modify-delete`: the remote side is absent/deleted while local changed;
- `delete-modify`: local is absent/deleted while remote changed.

If only one side changed, that side wins. The portable client exposes
`use-local`, `use-remote`, `save-as-both`, and callback-based `merge` in
[`packages/sync-client/src/conflict.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-client/src/conflict.ts).

### Soft delete and retention

`DELETE /vaults/:id/files/*` in `files.ts` does not remove the R2 object. It
sets `deletedAt` in the KV `SyncFile` record. Listing hides these records by
default and accepts `includeDeleted=true`; `PATCH` clears `deletedAt` to
restore the file. The sync diff uses `toTrash` to tell an unchanged client to
apply the same soft deletion.

The scheduled handler in
[`packages/sync-worker/src/handlers/scheduled.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-worker/src/handlers/scheduled.ts)
uses a 30-day cutoff, paginates `vault:*:files` keys, batch-deletes expired
objects from R2, rewrites the KV file list, and removes stale baseline hashes.
[`packages/sync-worker/wrangler.toml`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-worker/wrangler.toml)
binds that handler to the `0 3 * * *` cron.

### Auth and portable client

The separate
[`packages/auth-worker`](https://github.com/zudolab/zudo-file-sync/tree/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/auth-worker)
is an Auth0 authorization-code OAuth worker. `handlers/login.ts` creates a
random state, redirects to `AUTH0_DOMAIN/authorize`, and stores the state in a
short-lived HttpOnly/Secure/Lax cookie. `handlers/callback.ts` verifies the
state, exchanges the code at `/oauth/token`, then signs a 15-minute access JWT
and a 7-day refresh JWT into cookies. `AUTH0_CLIENT_SECRET` and `JWT_SECRET`
are worker configuration/secret inputs. This is an important historical detail:
the current house stack does not use this Auth0 boundary.

[`packages/sync-client/src/client.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-client/src/client.ts)
is a portable TypeScript SDK for Node and browsers. `syncVault` hashes local
content, posts the manifest, then performs the returned uploads/downloads.
The worker's `SyncDiff` includes `toTrash`, but this client snapshot's
`SyncDiff` type and `syncVault` implementation do not consume that field; a
caller that needs deletion propagation must handle it explicitly.
[`packages/sync-client/src/hash.ts`](https://github.com/zudolab/zudo-file-sync/blob/4e5093754405c14bfeb5b8fdf4f89cd541cbcd21/packages/sync-client/src/hash.ts)
uses `crypto.subtle.digest("SHA-256", ...)`, so hashing is independent of a
Node-only crypto API.

### Why it was superseded

The lineage is directly visible in zudo-text:

- Commit [`efd63990158dd0e3df4d56b3893b10ffef67120b`](https://github.com/zudolab/zudo-text/commit/efd63990158dd0e3df4d56b3893b10ffef67120b)
  ports `packages/sync-client/src/{client,hash,conflict,types}.ts` into the
  `@takazudo/sync-client` workspace package. The files were read with
  `git show efd639901:<path>`.
- The package then grew through follow-up commits: review fixes in
  [`989406dabfbc512a142cda62ead95673906964f8`](https://github.com/zudolab/zudo-text/commit/989406dabfbc512a142cda62ead95673906964f8), package/dependency cleanup in
  [`ed61c0a5221e488cafa06e2e228456ed9643dc3f`](https://github.com/zudolab/zudo-text/commit/ed61c0a5221e488cafa06e2e228456ed9643dc3f), structured logging in
  [`4308195f41423c2a33c86249772daebd7f482d43`](https://github.com/zudolab/zudo-text/commit/4308195f41423c2a33c86249772daebd7f482d43), and iOS conflict/device policy work in
  [`3d2f239194c9336922c61892d9912b656ba99a23`](https://github.com/zudolab/zudo-text/commit/3d2f239194c9336922c61892d9912b656ba99a23) and
  [`bc405df998f85bb5166b716c58f89c4790bb1420`](https://github.com/zudolab/zudo-text/commit/bc405df998f85bb5166b716c58f89c4790bb1420). This is the concrete PR-era growth that preceded retirement.
- Commit [`eb6c60d7b0f0e160e5288730258c981a98e18a31`](https://github.com/zudolab/zudo-text/commit/eb6c60d7b0f0e160e5288730258c981a98e18a31)
  adds the product-owned cloud-sync architecture: `packages/cloud-sync`,
  `packages/cloud-crypto`, and `workers/sync-server`, including WebSockets,
  Durable Objects, E2E encryption, and version history.
- Commit [`ad69fa7198f04d2da71cb556c9debea557e07913`](https://github.com/zudolab/zudo-text/commit/ad69fa7198f04d2da71cb556c9debea557e07913)
  explicitly converges on cloud sync and removes the file-mode path and the
  `@takazudo/sync-client` package. `git show ad69fa719:<path>` confirms the old
  client files are absent while `packages/cloud-sync` remains.
- The Better Auth cutover is recorded by merge commit
  [`b037b30674eae55acdf6c53e84a44f784df81d`](https://github.com/zudolab/zudo-text/commit/b037b30674eae55acdf6c53e84a44f784df81d).
  Current `workers/sync-server/src/better-auth.ts` builds Better Auth per
  request, and migration `workers/sync-server/migrations/0014_better_auth.sql`
  creates its `user`, `session`, `account`, `verification`, and `jwks` tables.

**Inference:** the standalone service was superseded because sync became a
product capability in zudo-text's own monorepo and the product's auth boundary
moved from Auth0 to Better Auth. The durable lesson is to build ez-host's
publish/sync behavior in the product's own control plane, rather than creating
another detached Auth0-backed service.

### What ez-host takes from this

- Use explicit manifests, content hashes, and a named diff/status result when a
  reconciliation step is needed; they make pending work and conflicts visible.
- Keep the hash implementation portable (`crypto.subtle`) and make deletion a
  deliberate, recoverable state with a separately reviewed retention window.
- Do not introduce Auth0 or copy the old auth-worker boundary. Route identity
  through the house Better Auth boundary.
- Do not import bidirectional device-sync machinery into a one-way publish path:
  ez-host can borrow deterministic identity and retention ideas without adding
  vault manifests, local/remote merge UI, or a second auth service.

## zudo-text: the replacement cloud-sync shape and color-token source

Source: local checkout `$HOME/repos/myoss/zudo-text` (resolved to
`/Users/takazudo/repos/myoss/zudo-text`), remote
[github.com/zudolab/zudo-text](https://github.com/zudolab/zudo-text), current
commit [`3346d5b92caa4409d7b2cc486222f9302760b730`](https://github.com/zudolab/zudo-text/tree/3346d5b92caa4409d7b2cc486222f9302760b730).

### Old file-sync lineage and current replacement

The old lineage is the exact `@takazudo/sync-client` port described above:
`efd63990158dd0e3df4d56b3893b10ffef67120b` adds it, and
`ad69fa7198f04d2da71cb556c9debea557e07913` removes it. The latter commit's
message says the product now has one cloud sync path, not a selectable file-sync
mode.

The replacement is split into three product-owned pieces:

- `packages/cloud-sync/src/cloud-sync-client.ts` exposes workspace/device
  operations plus cursor-based `/sync/push`, `/sync/pull`, and paginated
  `/sync/snapshot` operations. `packages/cloud-sync/src/types.ts` carries
  encrypted paths, content hashes, versions, device IDs, cursors, and
  `concurrent-edit`/`edit-delete`/`delete-edit` conflict types.
- `packages/cloud-sync/src/ws-manager.ts` maintains a reconnecting WebSocket.
  It can exchange a bearer for a short-lived single-use ticket before putting
  credentials in the URL; the client sends a cursor/device hello and receives
  change notifications. `workers/sync-server/src/durable-objects/sync-room.ts`
  uses the WebSocket Hibernation API and `getWebSockets("workspace")` to fan out
  `{ type: "changes" }` messages. The room holds no per-connection JS state.
- `workers/sync-server/src/handlers/file-handlers.ts` keeps ciphertext in R2
  under a content-hash-derived key and commits the file row, version row, and
  change-log row in one D1 batch. `sync-handlers.ts` checks changes after a
  client's `baseCursor`, returns conflicts, and supports cursor-based pull and
  fresh-device snapshot bootstrap. Web Push separately wakes backgrounded
  devices.

`packages/cloud-crypto` is the E2E layer used by `cloud-sync`: the verified
current files are `src/key-derivation.ts` (PBKDF2-SHA-256 derives independent
AES-256-GCM content, HMAC-SHA-256 integrity, and AES-256-GCM path keys),
`src/encrypt.ts`/`src/decrypt.ts` (random-IV authenticated content encryption),
and `src/path-encrypt.ts` (deterministic encrypted paths for server-side
matching without plaintext paths). The normal derived `CryptoKey` objects are
non-extractable. The server works with encrypted paths and ciphertext rather
than document plaintext.

**Inference:** this shape is appropriate for a multi-device editable product:
there are replicas, cursors, device identity, encrypted payloads, change
fan-out, offline bootstrap, and conflict resolution. ez-host's publish action is
different: a user submits one accepted Current, then the system builds and
promotes a public artifact. It needs durable acceptance, idempotency, and
build/promotion status, but not a local replica protocol, device cursor, E2E
workspace keys, WebSocket room, or three-way merge UI.

### Color tokens to port later

The future webapp epic should copy these exact source files from the verified
zudo-text tree:

1. `packages/color-themes/src/color-themes.ts`
2. `packages/color-themes/src/color-settings.ts`
3. `packages/color-themes/src/theme.ts`
4. `packages/color-themes/src/color-utils.ts`
5. `packages/ui-components/src/tokens.css`

`color-themes.ts` is the TypeScript source of truth. It defines the raw base,
accent, and state ramps, semantic ramp references, the two built-in schemes
`default-dark` and `default-light`, and `defaultThemeName = "default-dark"`.
`color-settings.ts` resolves those references into `ColorSettings`, owns the
key-to-CSS-variable table (`--theme-*`), and writes semantic values with
`applyColors()`.

This is a two-layer design:

1. **TS source layer:** `color-themes.ts` defines ramps/maps; `color-settings.ts`
   resolves a selected scheme to semantic values; `theme.ts`'s `applyRamps()`
   and `applyTheme()` write the selected palette to `document.documentElement`.
2. **CSS fallback layer:** `tokens.css` defines `--palette-*` and
   `--theme-*` custom properties for first paint, before JavaScript has loaded.
   Its Tier 1 palette and Tier 2 semantic fallbacks must mirror
   `default-dark` (especially its `#1c1c1c` base, `#ae8556` accent, and tuned
   border/selection values) so splash/initial render does not flash a different
   hue. `applyColors()` then overwrites those custom properties at runtime.

The switch is imperative JavaScript: `applyTheme()`/`applyRamps()` and
`resolveScheme()`/`applyColors()` update CSS custom properties and
`dispatchSchemeChanged()` emits `zudotext:scheme-changed`. The verified source
does not use a `prefers-color-scheme` media query; it supports exactly the two
named schemes and applies the user's choice.

### What ez-host takes from this

- Port the five files above as one unit in the later webapp epic; do not copy
  only the CSS or only the TypeScript. Keep the TS map and CSS fallback names in
  lockstep.
- Preserve the default-dark-first-paint invariant and the imperative two-scheme
  switch. A system-preference media query would change the source behavior.
- Model publish as a product-owned, durable one-way pipeline. Borrow the
  replacement's explicit state/cursor discipline where asynchronous build and
  promotion need it, while leaving multi-device E2E sync to zudo-text.

## zudo-doc-cloud: hosted static sites with separated planes

Source: local checkout `$HOME/repos/zp/zudo-doc-cloud` (resolved to
`/Users/takazudo/repos/zp/zudo-doc-cloud`), remote
[github.com/zudolab/zudo-doc-cloud](https://github.com/zudolab/zudo-doc-cloud),
verified at commit [`06a1cd18dca48511c8b533ac5fa42b6669c08131`](https://github.com/zudolab/zudo-doc-cloud/tree/06a1cd18dca48511c8b533ac5fa42b6669c08131).

### Three planes and request flow

The hosted subsystem makes the separation a security boundary, as documented
in [`ops/hosted-sites/product.md`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/ops/hosted-sites/product.md):

- **Control plane:** one hosting-control D1 is authoritative for desired,
  active, suspended, and tombstoned state. It stores opaque project/site/
  artifact/source references, guarded state, events, and outbox records, but no
  owner identity, source body, generated bytes, or artifact bucket binding.
- **Private source plane:** frozen Markdown and asset bytes live in a separate
  private R2 bucket. The builder reads it; responders have no binding to it.
- **Public artifact plane:** validated immutable build output lives in a
  separate artifact R2 bucket. Responders read it; they do not bind D1 directly.

Publish accepts the source and writes a bounded delivery intent atomically;
asynchronous Workflow/Container work freezes source, builds, validates, uploads,
and promotes. Until a new immutable artifact is verified, the previous
last-good artifact remains public. That makes "source accepted, old site still
live" an expected partial-success state.

### Secretless public Worker and host grammar

[`packages/zudo-doc-cloud-public-worker/src/host.ts`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/packages/zudo-doc-cloud-public-worker/src/host.ts)
is a pure boundary parser. It accepts only a lower-case ASCII host under the
configured sites domain, rejects ports/percent escapes/trailing dots/nested
labels, rejects internal opaque incarnation IDs at the public host boundary,
and classifies a host as a document site or a personal-index handle. The public
Worker entrypoint in `src/index.ts` uses `SITES_DOMAIN`, transform-rule and
operator-approval readiness flags, the artifact R2 binding, and named service
bindings for public resolution/integrity signals. It has no secret, authoring
credential, authoring D1/R2, session, source, or build binding.

The resolver returns a bounded authorization tuple (site ID, public label,
origin, artifact ID, canonical build hash, artifact content hash, and manifest
ID). The handler validates that tuple, asks a tuple-confined artifact reader for
bytes, and performs fresh control authorization before every immutable-byte
cache read, including HEAD, Range, and conditional requests. Hidden or invalid
sites receive the same generic public failure response.

### DNS, certificates, and two-domain split

The exact recipe is in [`ops/hosted-sites/README.md`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/ops/hosted-sites/README.md):

- Create a proxied wildcard `AAAA` record with content `100::` (the reserved
  discard address for a Worker route with no origin), then add the matching
  Workers Route. Production uses `*.zudo-doc.com/*`; staging uses
  `*.staging.zudo-doc.com/*`. The MCP route is a separate, more-specific
  `https://*.<environment>.zudo-doc.com/mcp*` route.
- Universal SSL covers the zone apex and one label below it. It therefore covers
  production `<siteId>.zudo-doc.com` and the authoring attachment, but not
  `<siteId>.staging.zudo-doc.com`.
- Deeper labels require ACM. The documented pack in `zudo-doc.com` includes
  `zudo-doc.com`, `*.zudo-doc.com`, and `*.staging.zudo-doc.com`.
- The authoring and public products use distinct registrable domains:
  `zudo-doc.app` is authoring and `zudo-doc.com` is public. Public content must
  not be placed on a sibling subdomain of the authoring domain, and the
  authoring session cookie has no `Domain` attribute.

These are separately approved Cloudflare control-plane operations. They are not
implicit `wrangler deploy` mutations; DNS, routes, custom domains, and
certificates must be verified before enabling a live environment.

### Subdomain-label grammar

[`packages/zudo-doc-cloud-artifact-response/src/vanity-label.ts`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/packages/zudo-doc-cloud-artifact-response/src/vanity-label.ts)
defines the V1 namespace:

- handles are 3–20 ASCII lower-case letters/digits, with no hyphen;
- document slugs are 1–42 DNS-label characters, with internal hyphens only;
- the combined handle/slug label is at most 63 characters;
- ASCII uppercase is normalized only for classification; Unicode, whitespace,
  punctuation, trailing dots, and full hostnames are rejected;
- exact legacy entropy IDs are classified before vanity labels, preventing
  ambiguous interpretation;
- `zri-` plus 32 lowercase hex characters identifies an opaque internal
  incarnation. Handle-only labels are never artifact identities.

Artifact identity checks require canonical spelling and bind the site identity,
public label, and exact HTTPS public origin together. That stops a valid label
from being rebound to another origin or internal site incarnation.

### Content-addressed artifacts

[`packages/zudo-doc-cloud-artifact-response/src/storage.ts`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/packages/zudo-doc-cloud-artifact-response/src/storage.ts)
defines the V1 storage layout. A manifest or output object is stored as:

```text
sites/{siteId}/artifacts/sha256/{artifactContentHash}/{manifests|objects}/{sha256}
```

The builder validates each byte's length and SHA-256, writes immutable objects,
and attaches exact custom metadata for kind, site, artifact-content hash, hash,
and byte length. The manifest additionally carries artifact ID and canonical
build hash. The retention docs call
`sites/{siteId}/artifacts/sha256/{artifactContentHash}/` the storage scope:
two different canonical build hashes can share byte-identical output, so a
scope is collected only after every contributing artifact record is collected
and unprotected.

### Named-entrypoint RPC least privilege

[`packages/zudo-doc-cloud-hosting-control/README.md`](https://github.com/zudolab/zudo-doc-cloud/blob/06a1cd18dca48511c8b533ac5fa42b6669c08131/packages/zudo-doc-cloud-hosting-control/README.md)
requires explicit named service entrypoints. The default Worker export is only
cron/HTTP and is unavailable as an RPC surface. The relevant matrix is:

| Named entrypoint         | Capability                                                 |
| ------------------------ | ---------------------------------------------------------- |
| `HostedPublicResolver`   | anonymous current-site resolution only                     |
| `HostedOwnerCommands`    | project-scoped publish/unpublish and admission reads       |
| `HostedBuildCommands`    | artifact/deployment orchestration and promotion            |
| `HostedOperatorCommands` | inspection, audit, suspension/resume, takedown, collection |
| `HostedOutboxDispatcher` | bounded outbox lease/ack/retry/park/cancel                 |

The public Worker binds `HOSTING_CONTROL` specifically to
`HostedPublicResolver` and `HOSTED_INTEGRITY_SIGNALS` to the enqueue-only
`HostedIntegritySignals` entrypoint; it cannot call owner, build, operator, or
outbox commands. The artifact attestor is another named RPC-only service: it
can read the immutable artifact bucket and sign/validate, but has no D1,
responder, source, or authoring binding. Its HTTP fetch returns an unavailable
response. This keeps a compromised caller from acquiring a broader control
capability by binding the same Worker under a different name.

### Offline credential-free integration proof

The package is
`@takazudo/zudo-doc-cloud-hosted-platform-tests` at
`packages/zudo-doc-cloud-hosted-platform-tests`. Its `confirm:backend` script
typechecks and runs Vitest; the repository-level `pnpm hosted:confirm` also
typechecks/tests the public MCP sibling before running it. The confirmation gate
is deterministic, binds no ports, touches no Cloudflare account, and needs no
operator input. Its fixture drives saved Current through publish, artifact
reuse/rebuild, and anonymous live-site delivery.

The proof deliberately substitutes four seams: in-memory R2 for frozen source
and public artifacts, a test-drained queue for Workflow, `SimulatedHostedSandbox`
for the Cloudflare Container, and an in-memory control adapter for hosting
control D1. It proves the deterministic control/storage/response contracts and
the public bytes, but not a real container image, Cloudflare Workflow quotas,
real D1 migrations, or real R2 conditional-write behavior. A real staging
container build remains an operator prerequisite.

### What ez-host takes from this

- Make control metadata, private source, and public artifacts separate planes;
  give the public responder only the minimum resolution RPC and artifact read
  binding it needs.
- Keep the public Worker secretless and fail closed. Authorize through a named
  control entrypoint before reading or caching immutable bytes.
- Use a strict, versioned host-label grammar and bind label, origin, and internal
  site identity. Plan wildcard DNS, Worker routes, Universal SSL, and ACM as
  explicit environment operations.
- Store generated output under content-addressed, immutable scopes and collect
  scopes only after all artifact records that share them are safe to release.
- Ship a deterministic, credential-free integration proof that exercises the
  whole publish-to-anonymous-delivery path, while documenting the real-account
  seams it cannot prove.
- Keep authoring and public domains distinct (`zudo-doc.app` vs
  `zudo-doc.com` in the reference topology); never let public delivery inherit
  authoring session or source authority.

## zfb-example-password-gate: a hand-rolled static Worker gate

Source: [github.com/Takazudo/zfb-example-password-gate](https://github.com/Takazudo/zfb-example-password-gate), verified at commit [`72d2fbb5c9992e9125e66fde519422fff834926f`](https://github.com/Takazudo/zfb-example-password-gate/tree/72d2fbb5c9992e9125e66fde519422fff834926f). The organization is `Takazudo`, not `zudolab`; this source was shallow-cloned because no local copy exists.

### The load-bearing asset-ordering setting

[`wrangler.toml`](https://github.com/Takazudo/zfb-example-password-gate/blob/72d2fbb5c9992e9125e66fde519422fff834926f/wrangler.toml)
sets:

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
run_worker_first = true
```

`run_worker_first = true` is the security boundary. With the default `false`,
Workers Static Assets can answer a request for an existing file before the
hand-written Worker runs, so `/` may look gated while real static files bypass
the password. Once authorized, `src/index.ts` calls `env.ASSETS.fetch(request)`.

### Gate, marker, and comparison

[`src/index.ts`](https://github.com/Takazudo/zfb-example-password-gate/blob/72d2fbb5c9992e9125e66fde519422fff834926f/src/index.ts)
uses `POST /__auth` for login and a fixed marker cookie named
`zfb_preview_gate`. A successful password check emits the marker with:

- `HttpOnly`;
- `SameSite=Lax`;
- `Secure` except for local plain-HTTP development hosts; and
- a one-year `Max-Age`.

The marker is not a user identity or session. The README explicitly describes
the gate as a shared-password preview boundary: anyone with the password or the
fixed marker value can use the site until expiry. `SITE_PASSWORD` is a Worker
secret, not a committed Wrangler variable; local development has a documented
fallback password, which must never be accepted for a real deployment.

`timingSafeEqual()` hashes both the provided and expected strings with
SHA-256, XORs every byte, folds in the length difference, and compares only the
final accumulator. It therefore avoids an early-return plaintext comparison.

### Redirect hardening and smoke coverage

`sanitizeNext()` accepts only a single-origin path beginning with `/`. It rejects
protocol-relative `//` values, absolute URLs, backslashes, and C0/DEL control
characters. The login page HTML-escapes the resulting value before placing it in
the form.

[`scripts/smoke.mjs`](https://github.com/Takazudo/zfb-example-password-gate/blob/72d2fbb5c9992e9125e66fde519422fff834926f/scripts/smoke.mjs)
checks the live site with TLS verification enabled. It requires `GET /` to
return the 401 login page, then discovers a real CSS/JS file under `dist/` and
requires that asset path to return the same 401 login page. It also checks that
wrong-password `POST /__auth` returns 401 without a marker cookie. Testing a
real deployed asset, rather than an invented missing path, is what catches a
`run_worker_first` regression. The unit tests in `src/index.test.ts` cover the
marker flow, wrong marker, timing-safe comparison, redirect sanitization, and
asset-fetch boundary.

### Multi-tenant adaptation

The example's one `SITE_PASSWORD` secret cannot represent multiple projects in
one public Worker. A multi-tenant variant needs:

1. a per-project password (or a verifier/rotatable gate credential) in the
   control plane, scoped to the validated project/site identity; it must not be
   a Worker secret shared by every tenant;
2. the gate check inside the public Worker, after host/site resolution and
   before artifact lookup or byte/cache delivery; and
3. an explicit cache policy. Login and failure responses should be
   `no-store` and vary on the marker cookie. Authenticated/gated artifact
   responses must not be served from a public cache to an unauthenticated
   request: either bypass caching or partition the cache key by the validated
   project and gate state, with authorization still checked before every read.

**Inference:** the fixed marker remains a useful low-friction preview pattern,
but it provides no per-user identity or individual revocation. It must not be
mistaken for production authentication, and its one-year lifetime means
credential rotation must account for already-issued markers.

### What ez-host takes from this

- Treat `run_worker_first = true` as a release invariant and keep a smoke test
  that gates a real deployed asset, not merely `/`.
- Keep the Worker secretless with respect to tenant credentials: resolve a
  per-project verifier from control, gate before cache/artifact reads, and make
  revocation/rotation a control-plane concern.
- Preserve constant-time credential comparison and strict `next` sanitization.
- Make cache behavior part of the security contract. A successful gate must not
  turn a public immutable cache into a bypass for unauthenticated visitors.
- Document clearly that a shared marker is preview access, not user identity,
  roles, audit, or production authentication.
