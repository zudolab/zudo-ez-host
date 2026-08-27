# ADR 0001: Initial architecture

- Status: Accepted
- Date: 2026-08-27
- Decision owners: initial-boot epic
- Inputs: `docs/research/hosting-and-domains.md`,
  `docs/research/sync-auth-desktop.md`, and `docs/research/prior-art.md`

## Context

zudo-ez-host turns each immediate child directory of a user-selected Mac sync
root into an independently hosted static site. The desktop app must make
publication feel automatic, while the cloud service must isolate untrusted site
content from the authenticated product, never expose a partial upload, and make
cross-machine updates understandable.

This ADR fixes the boundaries that the product specifications and implementation
must share. Values called out as provisional product limits are intentionally
conservative launch safeguards and may only change through a later decision.

## Decisions

### Public URL scheme and identity

**Decision:** a project's canonical public URL is:

```text
https://<project-slug>--<user-handle>.<public-content-domain>/
```

This intentionally differs from issue #1's literal
`<project>.<user>.zudo-ez-host.app` scheme. The UI still presents project and
user as separate concepts; only the DNS representation combines them.

The single label uses this versioned V1 grammar:

- Both components are canonical lowercase ASCII and match
  `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`.
- Neither component may contain `--`, and neither may begin with `xn--`.
- Handles are 3–20 characters. Project slugs are 1–41 characters, and the full
  label, including the two-character delimiter, may not exceed 63 octets.
- A centrally versioned reserved-name list includes at least `www`, `api`,
  `app`, `admin`, `auth`, `login`, `logout`, `account`, `billing`, `support`,
  `status`, `docs`, `cdn`, `assets`, `static`, `mail`, `ftp`, `localhost`,
  `staging`, `preview`, `internal`, `root`, and `system`, plus permanent-ID
  prefixes.
- Allocation is an atomic unique insert mapped to opaque owner and project IDs.
  A hostname is never evidence of ownership.
- Renaming a display name does not move a URL. A future canonical alias may be
  added, but an old label remains an alias or tombstone forever and is never
  reassigned.

**Rationale:** Universal SSL covers the apex and one label beneath it. A single
label therefore gives constant certificate operations, one wildcard DNS record
and Worker route, and no certificate object per user or project. Project-per-host
origins also contain service-worker scope. Opaque IDs and immutable aliases
prevent rename or deletion from becoming account-takeover paths.

**Rejected alternatives:**

- The issue #1 form, `<project>.<user>.zudo-ez-host.app`, is technically
  feasible but is not the default. Per-user ACM wildcard certificates allow 50
  hosts per certificate, with the apex consuming one slot, and published
  Enterprise ACM capacity of up to 100 edge certificates yields only 4,900 user
  wildcard SANs before a different contract. Self-service ACM starts at
  **$10/month**. Total TLS can issue exact certificates but requires one proxied
  DNS hostname and certificate lifecycle per project and has no published
  unlimited-tenancy guarantee.
- Cloudflare for SaaS exact custom hostnames include 100 hostnames and then cost
  **$0.10/hostname/month**, with a 50,000-hostname self-service maximum. Thus
  10,000 projects are about **$990/month** beyond the first 100, before other
  services. Wildcard custom hostnames are Enterprise-only with custom pricing.
- `<project>--<user>.zudo-ez-host.app` would solve TLS cost but would put hostile
  content on the same registrable domain as authenticated product cookies and
  SameSite decisions.
- Path tenancy such as `sites.example/project/user/` shares one origin across
  tenants and gives service workers and browser state an unacceptable shared
  boundary.

### Domain strategy

**Decision:** use two registrable domains. `zudo-ez-host.app` is exclusively the
authenticated control plane and marketing site. A second registration is
exclusively for user-controlled public content. Do not use a sibling such as
`sites.zudo-ez-host.app`.

The exact public-content registration remains a named deployment prerequisite,
not an architectural guess. Before production, a human owner must choose an
available domain, verify both first-year and renewal prices, approve and buy it,
and record renewal ownership and recovery. The same prerequisite covers the
planned purchase of `zudo-ez-host.app`. Enable registrar lock, DNSSEC,
auto-renew, verified contacts, monitored billing, and expiry alerts. Record the
selected public domain in environment configuration and replace
`<public-content-domain>` in user-facing examples before launch.

**Rationale:** untrusted HTML and JavaScript must be cross-site, not merely
cross-origin, from authenticated sessions. Control-plane cookies use a
`__Host-` prefix, `Secure`, `HttpOnly`, `Path=/`, no `Domain`, and an appropriate
`SameSite` value. Credentialed control-plane CORS allows only the exact control
origin and is paired with Origin/CSRF validation. Public content receives no
control-plane authority. Because `.app` is HSTS-preloaded, production DNS, TLS,
and HTTPS smoke checks are hard prerequisites; local development uses
`localhost`.

**Rejected alternatives:** one registrable domain with separate subdomains is
cross-origin but remains same-site, so domain-cookie mistakes and same-site
requests cross the trust boundary. A Public Suffix List submission could later
improve project-to-project isolation but is unnecessary for protecting the
control plane and adds governance and compatibility work.

### Hosting primitive and plane boundaries

**Decision:** serve every public project through one trusted, secrets-free
public Worker backed by immutable, content-addressed objects in a private R2
bucket. A narrow named service entrypoint resolves current publication and gate
authorization. The responder has R2 read access and public verification
material only: no authoring credential, D1 binding, password verifier/pepper,
signing key, source bucket, or write capability.

The planes are:

1. The **control plane** owns accounts, projects, hostname allocation,
   publication heads, quotas, gates, and audit state in D1.
2. The **private upload/staging plane** accepts authenticated publication
   attempts and immutable objects before promotion.
3. The **public artifact plane** holds validated immutable artifacts in R2 and
   exposes them only through the public responder after current authorization.

Production ingress uses a proxied wildcard DNS record, a wildcard Workers
route, and verified one-label certificate coverage. `r2.dev` and public-bucket
access stay disabled so there is no bypass. Authorization occurs before any
cache or artifact read. Public bytes use artifact-hash-aware cache keys;
fingerprinted assets may be immutable, while mutable HTML entry points
revalidate. Gated content is excluded from shared caching in V1.

**Workers for Platforms verdict:** do **not** use Workers for Platforms in V1.
It is designed for uploading and dispatching customer Worker code, whereas
zudo-ez-host tenants provide files. It currently starts at **$25/month** with
20 million requests, 60 million CPU-ms, and 1,000 scripts; dispatch lifecycle,
tenant scripts, and compute isolation do not improve the storage-key or
authorization isolation needed here. Reconsider only if customers may deploy
executable Worker code or need tenant-specific runtime bindings/limits.

**Rejected alternatives:** direct R2 public/custom-domain serving cannot enforce
per-host resolution, gate checks, custom 404/SPA rules, or takedown without a
Worker and creates a bypass. One shared Workers Static Assets bundle couples
every tenant deployment and is bounded by per-version asset limits. A Worker or
Workers-for-Platforms deployment per tenant adds lifecycle, cost, and
observability work without a V1 capability benefit.

### Static hosting and password gates

**Decision:** the artifact manifest carries a serving-semantics version. V1:

- content accepts `GET` and `HEAD`; other methods return 405, except the narrow
  gate-login `POST`;
- `/` and paths ending `/` resolve `index.html`; `/docs` redirects with 308 to
  `/docs/` only when `docs/index.html` exists; exact files are case-sensitive
  and do not gain implicit `.html`;
- a root `404.html` is served with status 404 when present; otherwise a generic
  platform 404 reveals no project state;
- normalized paths reject malformed encoding, NUL, backslash, encoded
  separators, dot segments, symlinks, and portable case/normalization
  collisions;
- platform-derived MIME metadata is stored in the manifest, unknown types are
  `application/octet-stream`, and responses set `X-Content-Type-Options:
nosniff`;

- SPA fallback defaults off. A reserved explicit project flag may enable it
  only for unmatched HTML navigation; missing asset-like requests remain 404;
- dot-prefixed segments are excluded by default. A future exact allowlist may
  admit safe `.well-known/*` paths, but never repository, environment, editor,
  or credential files.

Per-project password protection defaults off. When enabled, a private gate
service owns a slow salted verifier and any pepper/signing secret. Successful
verification yields a short-lived, host- and project-bound signed capability
with a gate-version epoch. The public Worker verifies it using a pinned public
key and stores it in a `__Host-`, `Secure`, `HttpOnly`, `Path=/`,
`SameSite=Strict` cookie. Gate changes increment the epoch. Login and denial are
`no-store`; all gated artifact responses bypass shared cache. This is shared
preview access, not identity, roles, or audit.

**Rationale:** deterministic serving parity avoids filesystem-dependent output,
and gate-before-cache prevents an authenticated request from warming a public
bypass.

**Rejected alternatives:** trusting upload headers or raw paths creates content
sniffing and traversal risks. An unconditional SPA fallback hides missing
assets. A single Worker secret or fixed marker shared across tenants makes one
responder compromise global. Cache partitioning by cookie is deferred because
cache bypass is the simpler auditable V1 rule.

### Atomic publication and multi-machine concurrency

**Decision:** a publication is an immutable canonical artifact plus one mutable
D1 project-head pointer. Publication has three phases:

1. `prepare` validates a canonical manifest, records the current
   `baseGeneration`, reserves quota, and returns upload contracts for missing
   content hashes;
2. the app uploads immutable objects and the service verifies completeness and
   writes the canonical artifact manifest;
3. idempotent `commit` atomically promotes the head only when its generation is
   still `baseGeneration`, and records artifact hash, stable machine ID,
   machine-name snapshot, counts, and timestamp.

The public Worker reads only a promoted artifact. Failed attempts leave
unreachable immutable objects for safe later collection and never expose a
partial site. Retain promoted publications for a provisional 30-day whole-site
rollback window.

Optimistic concurrency is the correctness rule. A stale commit returns
`409 publication_head_changed` with the newer generation and publishing machine
name. The app rescans and requires explicit user confirmation before preparing
an overwrite against that generation. A short expiring commit-only lease may
serialize verification and promotion; it never spans uploads. Machine renames
affect future stamps only.

**Rationale:** compare-and-swap prevents a slow older machine from silently
replacing a newer site and avoids crash-prone upload-length locks.

**Rejected alternatives:** last-writer-wins silently loses a newer publication.
A long exclusive upload lease blocks healthy publishers after sleep, network
loss, or a crash. Mutating a live prefix in place permits mixed old/new bytes.

### One-way sync protocol, deletion, and quotas

**Decision:** the selected local directory is always the source of truth. The
Mac app submits a versioned canonical manifest sorted by normalized relative
path, with SHA-256, size, local mtime cache hint, and platform-derived content
type. The server returns missing content hashes and upload contracts only. It
does not download remote files, propagate per-file trash, or merge edits.

Watcher events are hints. A complete rescan is the correctness boundary on
launch, wake, root change, watcher overflow/error, and a periodic safety pass;
ordinary events use a 500 ms quiet period and 5 second maximum batch delay.
Only one reconciliation per project runs at once, with a dirty bit requesting
one follow-up scan. A path omitted from the next promoted manifest disappears
from the live site but is never deleted locally. A rename is remove-plus-add
and reuses identical content by hash. Recovery is whole-publication rollback,
provisionally retained 30 days, not cloud per-file trash.

Hard ignores are `.DS_Store`, `.git/`, `.hg/`, `.svn/`, and app metadata.
A root `.ezhostignore` adds documented gitignore-style rules but cannot undo
hard exclusions. For serving safety, dot-prefixed content remains excluded by
V1 policy even if the ignore matcher would otherwise include it. Symlinks are
reported and never published.

V1 safeguards are provisional but binding until superseded:

| Limit                                      |                 V1 value |
| ------------------------------------------ | -----------------------: |
| File                                       |                  100 MiB |
| Project/artifact                           |   20,000 files and 2 GiB |
| Active published data/account              |                   10 GiB |
| Retained plus staged physical data/account |                   20 GiB |
| Canonical manifest body                    |                   10 MiB |
| Open attempts                              | 3/project and 20/account |
| Client upload concurrency                  |           8 PUTs/machine |

Missing bytes upload directly to project-scoped content-addressed R2 keys via
10-minute presigned PUT URLs authorized by the Worker. Sign exact key, method,
content type, and supported MD5 transport checksum; verify length, transport
integrity, attempt ownership, and completeness before promotion. Presigning
does not prove that a SHA-256 label matches bytes, so server-side SHA-256
recomputation is explicitly deferred. V1 needs no multipart because the file
limit is 100 MiB. Exact quota reservation and attempt limits live in D1;
eventually consistent rate limiting is abuse damping only.

**Rationale:** full manifests recover from lost watcher events and make the
entire published state explicit, while immutable hash reuse minimizes transfer.

**Rejected alternatives:** bidirectional sync adds remote replicas, conflict
merging, download, and per-file trash that static publication does not need.
Event-only streaming still needs reconciliation and a crash journal. rsync
rolling blocks add CPU/protocol complexity but cannot patch R2 objects in place.
Proxying all bytes through a Worker adds a hop and limits large uploads.

### Authentication and desktop credentials

**Decision:** the control Worker creates Better Auth per request against D1 via
the Drizzle adapter and `nodejs_compat`. The product supports email/password and
Google login. Browser sessions use secure host-only HTTP-only cookies, exact
trusted origins, and origin/CSRF checks. Authentication never replaces
owner-scoping on project and upload queries.

The Mac app uses the system browser, not shared WebView cookies. It generates
state and PKCE, opens `/desktop/authorize`, and receives a random single-use
authorization code through an ephemeral loopback callback. The code expires in
60 seconds and is bound to user, exact redirect, challenge, requested `publish`
scope, and machine record. The app validates state and exchanges code plus
verifier over TLS. No session or long-lived bearer appears in the callback URL.

The issued machine credential is random, mint-once, prefix/versioned for this
product, hash-stored server-side, revocable, machine-scoped, limited to project
and publish operations, and has a one-year maximum lifetime. The raw value is
shown once and stored only in macOS Keychain. It cannot manage tokens or perform
account-destructive actions. The webapp lists and revokes machines; sign-out can
revoke the current one.

**Rationale:** this follows native-app external-user-agent and PKCE practice,
keeps browser ambient authority out of the app, and makes stolen machine access
individually revocable.

**Rejected alternatives:** Auth0 and the old separate auth service duplicate the
current product boundary. Sharing browser cookies with a WebView is fragile and
over-broad. Returning a long-lived token in a deep link or loopback URL leaks it
to logs/history. Storing a raw credential in settings leaves it unprotected.

### Mac application framework

**Decision:** use a Tauri v2 macOS accessory/menu-bar app. A Rust-owned engine
uses `notify` watcher events to trigger the scan state machine. The main setup,
status, errors, account, and preferences window is hidden by default; closing
it hides rather than exits. Explicit Quit stops watchers. Launch at login is an
opt-in, reversible LaunchAgent preference and starts hidden.

Each immediate child of the selected root is one project; root-level loose
files are ignored with a visible explanation. Select the root with a native
folder picker and store access through a `resolve root -> access guard -> path`
bookmark abstraction. Implement security-scoped bookmark handling before
claiming Mac App Store compatibility. Direct releases use signed Tauri updates,
Developer ID, hardened runtime, notarization, and stapling. App Store builds use
separate sandbox entitlements, Apple Distribution/App Store updates, and no
direct updater.

**Rationale:** Tauri matches the house stack, supports tray/menu primitives, and
lets Rust own filesystem and lifecycle correctness while retaining an
accessible normal window.

**Rejected alternatives:** an Electron shell carries a larger runtime and does
not improve the native filesystem boundary. A browser-only app cannot watch a
chosen local tree. A CLI-first workflow misses the requested CLI-less menubar
experience.

## Milestone cut

### M1 — personal MVP

- One invited account and one or more named Macs.
- Directly distributed, signed Tauri menubar app with browser login,
  user-selected root, automatic one-way publication, visible status/errors,
  and launch-at-login.
- `zudo-ez-host.app` control surface with email/password login, basic own-profile
  and project visibility, machine attribution, and revoke-machine action.
- Separate-domain public sites, immutable R2 artifacts, atomic promotion,
  deterministic static semantics, takedown support, and gates held off in the
  UI until their security path is complete.

### M2 — multi-user service

- Public signup, password plus Google login, account recovery, multi-user
  ownership isolation, profile management, project settings, and operational
  administration.
- Per-project password gate (default off), rollback UI, URL alias policy if
  approved, quotas/rate controls, abuse handling, and production observability.
- App Store readiness work: if Google remains visible, add Sign in with Apple;
  add in-app account-deletion entry, provider revocation, privacy/retention
  disclosure, security-scoped root access, and signed sandbox testing.

### M3 — commercial distribution

- Paid plans, billing and entitlement enforcement, plan-aware quotas, broader
  administrative user management, support/audit tooling, and formal retention
  policy.
- Mac App Store release if product economics justify it, while retaining
  separately signed/notarized direct distribution and updater configuration.

The architecture supports M2/M3, but M1 does not pretend those product surfaces
are shipped.

## Deferred validation and prerequisites

- Human domain purchase and documented renewal/recovery ownership.
- Benchmark and select the password-verifier algorithm/parameters and signed
  capability TTL before gates ship.
- Measure representative generated sites before changing the provisional
  quotas or 30-day rollback window.
- Profile the periodic full-scan interval, minimum macOS version, CPU support,
  and security-scoped watcher behavior in a signed sandbox build.
- Obtain written Cloudflare capacity/pricing confirmation and load-test
  issuance only if a future decision revives the literal two-level hostname.
- Decide whether project URL aliases ship; old labels remain non-reassignable in
  every case.

## Consequences

The product accepts a less literal but cost-stable public hostname and one extra
domain registration in exchange for a stronger browser security boundary. It
also accepts full-tree scanning and immutable storage overhead in exchange for
deterministic recovery and atomic visibility. Product specs and implementation
must not silently fill deferred items; they must retain them as explicit open
questions or introduce a superseding ADR.
