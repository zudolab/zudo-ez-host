# Wave 3 specification outline

This file is the source of truth for Wave 3 documentation work. The accepted
architecture is `docs/adr/0001-initial-architecture.md`; research explains the
evidence but does not override that ADR.

## Authoring contract

- English lives under `doc/src/content/docs/`. Japanese mirrors every relative
  path under `doc/src/content/docs-ja/`.
- Every page has frontmatter `title` and integer `sidebar_position`. Frontmatter
  supplies the page h1, so body prose starts at `##`; body h1 headings are
  forbidden.
- Japanese pages translate prose and frontmatter values, preserve component
  names, code, literal paths, and necessary technical terms, and rewrite
  internal `/docs/...` links to `/ja/docs/...`.
- Prefer prose followed by precise requirements on one page per subsystem.
  Split a page only when the translated or English source is likely to exceed
  roughly 300–400 lines.
- Link heavily to sibling specification pages. State deferred ADR items as open
  questions; do not choose answers while writing Wave 3 prose.
- EN/JA page structures and heading levels must match. Translation may adapt
  wording naturally but may not add or remove decisions.

## Complete page inventory

Paths in the tables are exact. “Required headings” lists body headings in
order. Subheadings below these are allowed only when they clarify the locked
content and remain mirrored in both languages.

### Issue #9 — product overview and concepts

| EN path                                          | JA mirror path                                      | Required headings                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/src/content/docs/index.mdx`                 | `doc/src/content/docs-ja/index.mdx`                 | `## zudo-ez-host in one minute`; `## Start with the concepts`; `## Where the roadmap goes`                                                     |
| `doc/src/content/docs/getting-started/index.mdx` | `doc/src/content/docs-ja/getting-started/index.mdx` | `## The Dropbox public-folder model`; `## Sync root, project, and hosted site`; `## What happens after setup`; `## Current milestone boundary` |
| `doc/src/content/docs/concepts/index.mdx`        | `doc/src/content/docs-ja/concepts/index.mdx`        | `## Core model`; `## Accounts and named machines`; `## Public URLs and stable identity`; `## Milestones`; `## Glossary`                        |

Locked facts:

- One immediate child directory under the chosen sync root equals one project
  and one hosted static site. Root-level loose files are not projects.
- The Mac menubar app publishes automatically; the local directory is the
  source of truth, and publication is one-way rather than remote file sync.
- State the canonical URL exactly as
  `https://<project-slug>--<user-handle>.<public-content-domain>/`; explain that
  the public content domain is a pre-launch human purchase and differs from
  `zudo-ez-host.app`.
- A machine has a stable ID and user-editable name. Every promoted publication
  snapshots that name; history does not change when the machine is renamed.
- Own-profile management is a product surface. Administrative user management
  is distinct and later.
- Reproduce the ADR's M1 personal MVP, M2 multi-user service, and M3 commercial
  distribution boundaries without implying an unshipped feature is current.
- Define at least: sync root, project, artifact, publication head, machine,
  control plane, public-content domain, and password gate.

### Issue #10 — hosting architecture and security

| EN path                                           | JA mirror path                                       | Required headings                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/src/content/docs/hosting/index.mdx`          | `doc/src/content/docs-ja/hosting/index.mdx`          | `## System boundaries`; `## Publication-to-request flow`; `## Cloudflare resources`; `## Why not Workers for Platforms`; `## Deployment prerequisites`                                                              |
| `doc/src/content/docs/hosting/static-serving.mdx` | `doc/src/content/docs-ja/hosting/static-serving.mdx` | `## Versioned serving contract`; `## Path and index resolution`; `## Errors, MIME, and cache`; `## SPA fallback`; `## Filesystem safety`                                                                            |
| `doc/src/content/docs/hosting/security.mdx`       | `doc/src/content/docs-ja/hosting/security.mdx`       | `## Threat model`; `## Registrable-domain isolation`; `## Least-privilege public responder`; `## Hostname allocation and stability`; `## Password-gate boundary`; `## Browser and cache rules`; `## Open questions` |

Locked facts:

- Describe the control, private upload/staging, and public artifact planes. The
  public Worker is one trusted secrets-free responder with private R2 read and
  narrow resolution/gate authorization RPC; it has no D1, tenant verifier,
  signing secret, authoring credential, source binding, or write capability.
- R2 artifact access is private; `r2.dev` and public bucket access are off.
  Authorization precedes cache/artifact reads. Wildcard proxied DNS, Worker
  route, and one-label TLS readiness are separate deployment checks.
- Workers for Platforms is rejected for V1 because users deploy files, not
  executable Workers. Include the $25/month, 20 million request, 60 million
  CPU-ms, and 1,000 script snapshot and the condition for reconsideration.
- State every V1 static-host rule from the ADR: methods, exact files,
  `index.html`, 308 directory canonicalization, 404 behavior, path rejection,
  case sensitivity/collisions, MIME/nosniff, cache split, SPA default off,
  symlink rejection, and dot-prefixed exclusion/future exact allowlist.
- `zudo-ez-host.app` hosts only authenticated control/marketing surfaces; user
  content uses a separate registrable domain. Cover host-only `__Host-`
  cookies, exact credentialed CORS, Origin/CSRF checks, project-per-host service
  worker containment, no default public CORS, and `.app` HTTPS readiness.
- State the exact hostname grammar, limits, reserved-name minimum, opaque
  identity mapping, immutable URL behavior, and permanent no-reuse rule.
- Password protection defaults off. The private gate service owns slow verifier
  and secrets; the public Worker verifies a short-lived host/project/epoch
  capability. Gate before bytes/cache, increment epoch on change, return
  `no-store` login/denial, and bypass shared caches for all gated responses.
  Describe it as shared preview access, not user identity.
- Open questions are limited to the ADR's deferred gate verifier/TTL, Public
  Suffix List possibility, and whether aliases ship; no new decision may be
  made.

### Issue #11 — sync protocol and Mac client

| EN path                                    | JA mirror path                                | Required headings                                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/src/content/docs/sync/index.mdx`      | `doc/src/content/docs-ja/sync/index.mdx`      | `## Protocol goals`; `## Canonical manifest`; `## Prepare, upload, and commit`; `## Deletion and rollback`; `## Multi-machine concurrency`; `## Quotas and abuse controls`; `## Failure recovery`                                        |
| `doc/src/content/docs/sync/mac-client.mdx` | `doc/src/content/docs-ja/sync/mac-client.mdx` | `## Tauri v2 application shape`; `## Root and project discovery`; `## Watching and reconciliation`; `## Browser login and machine credentials`; `## Background lifecycle`; `## Distribution and App Store boundary`; `## Open questions` |

Locked facts:

- Local is the one-way source of truth. Manifest entries include normalized
  path, SHA-256, size, mtime cache hint, and platform-derived content type;
  server equality uses hashes, not mtime. The server returns missing hashes and
  upload contracts, never download/trash/merge work.
- Describe the ADR's path normalization/collision checks, hard ignores,
  `.ezhostignore`, dotfile serving restriction, and no-symlink rule.
- Prepare reserves quota and captures `baseGeneration`; missing bytes upload to
  project-scoped immutable R2 objects through 10-minute presigned PUTs; commit
  verifies completeness and atomically compare-and-swaps the D1 head. The site
  changes only at commit and never exposes a partial artifact.
- Manifest omission removes a path only from the next live publication. Rename
  is remove-plus-add with hash reuse. No local deletion or cloud per-file trash
  occurs. Whole promoted publications have a provisional 30-day rollback
  window.
- A stale commit returns `409 publication_head_changed` and identifies the
  newer generation/machine. Rescan and explicit user-confirmed overwrite are
  required. A short commit lease may exist; no upload-length lease or silent
  last-writer-wins is allowed.
- Reproduce every V1 quota in the ADR and distinguish exact D1 quota/attempt
  accounting from eventually consistent abuse damping. Include the initial 5
  prepares/account/minute, 10 commits/project/minute, and 1,000 presigned-URL
  issuances/account/minute ceilings. V1 has no multipart. Presigned PUT
  transport verification does not prove SHA-256-to-bytes.
- Tauri v2 is an accessory/menu-bar app with a Rust `notify`-driven engine,
  hidden-by-default accessible status/setup window, explicit Quit, and opt-in
  launch-at-login.
- Full scans are correctness on launch/wake/root change/watcher error or
  overflow/periodic safety pass. Ordinary events use a 500 ms quiet period and
  5 second maximum delay; one reconciliation plus dirty follow-up runs per
  project.
- Browser auth uses state, PKCE, a 60-second single-use code, exact ephemeral
  loopback redirect, and TLS exchange. The one-year-maximum machine-scoped
  bearer is `zeh_machine_v1_` plus 32 random bytes in unpadded base64url. Hash
  the complete token with SHA-256 server-side; it is revocable, publish-limited,
  and kept raw only in Keychain.
- Root selection uses a bookmark/access-guard abstraction. Separate direct and
  App Store signing/updating/sandbox paths; do not claim App Store support until
  security-scoped access works in a signed sandbox build.
- Open questions are the scan interval, macOS/CPU matrix, credential rotation,
  and timing of full App Store bookmark support.

### Issue #12 — webapp, authentication, and project features

| EN path                                             | JA mirror path                                         | Required headings                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doc/src/content/docs/webapp/index.mdx`             | `doc/src/content/docs-ja/webapp/index.mdx`             | `## Product surface`; `## Projects list`; `## Project detail and settings`; `## Publication and machine status`; `## Milestone availability`                                                  |
| `doc/src/content/docs/webapp/auth-and-accounts.mdx` | `doc/src/content/docs-ja/webapp/auth-and-accounts.mdx` | `## Better Auth boundary`; `## Browser sessions`; `## Sign-up and login`; `## Own profile and machines`; `## Administrative management is different`; `## Mac App Store account requirements` |
| `doc/src/content/docs/webapp/password-gates.mdx`    | `doc/src/content/docs-ja/webapp/password-gates.mdx`    | `## Feature contract`; `## Enable, rotate, and disable`; `## Visitor flow`; `## Security and cache behavior`; `## Limits of shared-password access`; `## Open questions`                      |

Locked facts:

- The projects list and detail show live/unpublished/error state, public URL,
  latest publication time, publishing machine-name snapshot, and actionable
  sync/gate state. Machine rename does not rewrite historical publication
  attribution.
- Project settings expose only decided controls: display metadata, allowed URL
  handling, SPA flag when enabled by milestone, password gate, and lifecycle
  actions. Do not invent billing/roles/team features.
- Better Auth is created per Worker request with D1/Drizzle and
  `nodejs_compat`; email/password and Google are the decided providers. Browser
  sessions use secure host-only cookies, exact trusted origins, and
  Origin/CSRF protection; every data query remains owner-scoped.
- Sign-up begins on the webapp. M1 is invite-only/personal; public signup and
  Google availability are M2. The architecture decision does not imply that
  every configured provider is enabled in M1.
- Current own-account surfaces cover profile data and listing/revoking named
  machines. Administrative user management means viewing/controlling other
  accounts and is a later operational/commercial surface; keep it explicitly
  separate from own-profile management.
- If an App Store build retains Google, it must add Sign in with Apple unless
  an exception applies. It must expose an in-app account-deletion entry,
  provider revocation, and privacy/retention information before submission.
- Gate UI defaults off and shows explicit enable/rotate/disable effects. It
  stores a per-project verifier in the private control boundary, never a shared
  Worker secret or plaintext password. Rotation/disable increments the gate
  epoch and invalidates capabilities. Gated responses bypass shared cache.
- A project password grants shared preview access only; there are no individual
  visitors, roles, or visitor audit/revocation.
- Open questions are verifier parameters, capability TTL/rate limits, and the
  exact milestone in which the gate UI becomes available.

## Exclusive ownership map

Only the issue in the Owner column may create, modify, rename, or delete the
listed Wave 3 files. Each row includes both language trees. Directories are
organizational, not separately shared surfaces.

| Owner | Exclusive files                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #9    | `doc/src/content/docs/index.mdx`; `doc/src/content/docs-ja/index.mdx`; `doc/src/content/docs/getting-started/index.mdx`; `doc/src/content/docs-ja/getting-started/index.mdx`; `doc/src/content/docs/concepts/index.mdx`; `doc/src/content/docs-ja/concepts/index.mdx`                                   |
| #10   | `doc/src/content/docs/hosting/index.mdx`; `doc/src/content/docs-ja/hosting/index.mdx`; `doc/src/content/docs/hosting/static-serving.mdx`; `doc/src/content/docs-ja/hosting/static-serving.mdx`; `doc/src/content/docs/hosting/security.mdx`; `doc/src/content/docs-ja/hosting/security.mdx`             |
| #11   | `doc/src/content/docs/sync/index.mdx`; `doc/src/content/docs-ja/sync/index.mdx`; `doc/src/content/docs/sync/mac-client.mdx`; `doc/src/content/docs-ja/sync/mac-client.mdx`                                                                                                                              |
| #12   | `doc/src/content/docs/webapp/index.mdx`; `doc/src/content/docs-ja/webapp/index.mdx`; `doc/src/content/docs/webapp/auth-and-accounts.mdx`; `doc/src/content/docs-ja/webapp/auth-and-accounts.mdx`; `doc/src/content/docs/webapp/password-gates.mdx`; `doc/src/content/docs-ja/webapp/password-gates.mdx` |

### Shared surfaces and exclusions

- Issue #9 exclusively owns the scaffolded landing and getting-started stub, so
  replacing placeholders cannot collide with another Wave 3 task.
- Each category `index.mdx` is explicitly owned above: `concepts` by #9,
  `hosting` by #10, `sync` by #11, and `webapp` by #12.
- No Wave 3 issue may edit Astro/zudo-doc configuration, package manifests,
  lockfiles, scripts, assets, components, styles, generated output, root
  tooling, `docs/`, or files outside its row. The Wave 2 scaffold owns those
  shared surfaces; this outline requires no Wave 3 config change.
- If a discovered framework requirement makes a config or other unowned change
  necessary, stop and move that work into a separately owned follow-up instead
  of editing it opportunistically.
- Cross-links do not confer ownership of their target. A writer may link to an
  owned sibling page but may not adjust that sibling's wording.

## Wave 3 completion check

The four issues together must produce 11 English pages and 11 path-identical
Japanese mirrors, with no other Wave 3 file changes. Run the repository's i18n
parity and internal-link checks plus the doc build. Compare each page against
its locked headings and facts above and against ADR 0001.
