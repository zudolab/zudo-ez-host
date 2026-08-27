# Sync, authentication, and Mac desktop research

Status: proposed implementation direction, researched 2026-08-27.

## Decision summary

zudo-ez-host should use a one-way, manifest-diff publication protocol. Filesystem events are only hints to rescan; the local project directory is always the source of truth. Changed content uploads directly to immutable, content-addressed R2 keys through short-lived presigned URLs. A final authenticated request verifies the staged artifact and conditionally moves a D1 project-head pointer, so a public site never observes a partial upload.

The service should reuse the proven house Better Auth/D1 Worker shape. The Mac app should authenticate in the user's default browser and exchange a short-lived, PKCE-bound code for a revocable machine credential. It should not share browser cookies or receive a long-lived token in a callback URL. Tauri v2 is a good fit for the menu-bar shell, with Rust's `notify` crate for recursive change hints, macOS Keychain for the credential, and security-scoped bookmarks designed in now for a future sandboxed Mac App Store build.

## 1. Sync protocol

### Prior art and alternatives

The archived [zudo-file-sync protocol](https://github.com/zudolab/zudo-file-sync/blob/main/packages/doc/src/content/docs/architecture/sync-protocol.mdx) did a complete SHA-256 manifest comparison. Each entry carried `path`, `hash`, `size`, and `lastModified`; the response contained `toUpload`, `toDownload`, `toTrash`, and `conflicts`. The same client existed in zudo-text until [commit `ad69fa719`](https://github.com/zudolab/zudo-text/commit/ad69fa719), when it was removed in favor of zudo-text's bidirectional, multi-device editing system. That newer WebSocket/Durable Object design solves live coordination, conflict history, and encrypted multi-device editing. Those are useful for an editor, but unnecessary state and failure modes for one-way static-site publishing.

Three approaches were considered:

- A complete manifest diff is deterministic, naturally detects missed watcher events, and makes deletion explicit through absence. SHA-256 also permits content-addressed deduplication. Its cost is walking every path and transmitting metadata for every file on each reconciliation.
- Per-file event streaming is fast in the happy path, but filesystem watchers coalesce, duplicate, reorder, or lose events. It still needs periodic full reconciliation and a crash-recovery journal, so it is a poor correctness boundary.
- An rsync-style rolling checksum is valuable when transferring small changes inside very large mutable files; see the original [rsync algorithm report](https://rsync.samba.org/tech_report/). Static-site outputs are typically many independently cacheable files, and direct R2 object uploads cannot patch an object in place. The CPU, protocol, and temporary-storage complexity is not justified initially.

### Proposed manifest and reconciliation

Use a versioned, canonical manifest sorted by normalized relative path:

```json
{
  "version": 1,
  "projectId": "...",
  "entries": [
    {
      "path": "assets/app.js",
      "sha256": "64 lowercase hex characters",
      "size": 1234,
      "mtimeMs": 1787800000000,
      "contentType": "text/javascript; charset=utf-8"
    }
  ]
}
```

`sha256` is the identity and correctness field. `size` is validated and used for quota reservation. `mtimeMs` is only a local hash-cache hint and must never decide equality on the server. `contentType` is captured in the signed upload contract and artifact manifest so serving behavior does not depend on a later MIME database change.

Paths use `/`, Unicode NFC, and no leading slash, empty segment, `.`/`..` segment, NUL, or backslash. Detect case-folding and Unicode-normalization collisions before upload and fail the project with the two conflicting local paths; silently choosing one would make output depend on the scanning filesystem. Hash from an open file, then confirm its size/mtime still match; if not, mark the scan dirty and retry rather than publishing a mixed snapshot.

The app may cache hashes keyed by stable local identity plus size and high-resolution mtime, but a cold scan and any ambiguous event must hash again. On launch, wake, sync-root change, watcher error/overflow, and a periodic safety interval, perform a full scan. During ordinary editing, use a 500 ms quiet-period debounce with a 5 second maximum batch delay. Keep one reconciliation per project in flight; events during it set a dirty bit and cause one more scan after completion. House Tauri experience documents why watcher bursts need this treatment in `zudo-tauri-wisdom/src/content/docs/rust-backend/file-watchers.mdx`, and the underlying [`notify` crate](https://docs.rs/notify/latest/notify/) supplies the platform watcher abstraction.

The server response needs only missing content hashes (plus an upload contract), not `toDownload`, `toTrash`, or edit conflicts. A successful promotion makes the submitted manifest the entire live site:

- A path absent from the new manifest disappears from the next publication. It is not deleted from the user's local directory.
- A rename is a remove plus add at the path layer. When bytes are unchanged, the same content-addressed blob is reused and no bytes upload.
- Keep old immutable publications for 30 days so an operator/user can roll the whole project back. There is no per-file cloud trash in the sync protocol; project deletion and retention are separate product operations.

Default hard ignores should be narrow: `.DS_Store`, `.git/`, `.hg/`, `.svn/`, and the app's own metadata directory. Do not ignore all dotfiles (`.well-known/` and similar files can be site content), and do not assume `node_modules/` is always disposable. Add a root `.ezhostignore` using documented gitignore-style rules, with the hard ignores non-overridable. Do not follow or publish symlinks in v1; report every skipped symlink. This avoids escaping the selected root, cycles, and host-dependent targets. A later opt-in could dereference only targets proven to remain below the root.

**Recommendation.** Adapt the verified SHA-256 manifest prior art into a versioned, upload-only protocol, with full scans as the correctness boundary and debounced watcher events only as triggers. Use manifest omission for live deletion, immutable 30-day publications for recovery, hash reuse for renames, narrow ignore defaults, and no symlinks. This retains the simple, deterministic part of the old system without importing bidirectional download/conflict machinery or rsync complexity that one-way static publishing does not need.

## 2. Atomic publication

### Immutable storage and head promotion

Store uploaded bytes under immutable content-addressed keys, conceptually:

```text
projects/{projectId}/objects/sha256/{contentHash}
projects/{projectId}/artifacts/sha256/{manifestHash}/manifest.json
```

This follows the house zudo-doc-cloud pattern represented by `sites/{id}/artifacts/sha256/{hash}/` and its [artifact key implementation](https://github.com/zudolab/zudo-doc-cloud/blob/main/packages/zudo-doc-cloud-artifact-response/src/storage.ts). The public worker reads only the artifact referenced by the D1 project head; it never lists an upload prefix or infers whether staging is complete.

Publication is a three-phase operation:

1. `prepare` validates and canonicalizes the manifest, captures the current head generation, reserves quota, creates an expiring publication attempt, and returns upload contracts only for missing hashes.
2. The client uploads missing immutable objects. Repeating the same signed PUT with the same bytes is harmless. The server verifies that every referenced object exists with the promised length and transport-integrity metadata before commit, then writes the canonical artifact manifest under its own hash. As discussed in topic 3, direct presigning does not by itself prove the client's SHA-256 label to the server.
3. `commit` uses an idempotency key and an atomic conditional D1 update: advance `head_generation` only if it still equals the attempt's `base_generation`. The same D1 transaction records artifact hash, publisher machine ID/name snapshot, byte/file counts, and published time. [D1 batch statements execute as a transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch); the implementation must also check the conditional update's affected-row metadata instead of assuming the head advanced.

The serving path changes only at step 3. A failed preparation or upload leaves unreachable immutable objects for later garbage collection; a failed or repeated commit cannot expose a partial manifest. Retain every promoted artifact for the rollback window, and delete unreferenced staged objects only after both the longest attempt lifetime and a safety margin.

### Concurrent machines

Pure last-writer-wins makes a slow upload prepared from an old local tree capable of replacing a newer publication without warning. A long exclusive lease prevents that, but makes offline/crashed clients block healthy publishers. Use optimistic concurrency as the correctness rule, with a short server-side commit lease only to serialize verification/promotion:

- `prepare` returns `baseGeneration` and the current publisher metadata.
- `commit` returns `409 publication_head_changed` if another machine advanced the head. The response names that machine and generation.
- The app rescans and asks the user to publish the local source over the newer cloud generation. An explicit retry prepares against the new generation; it is an auditable overwrite, not a hidden last-writer race.
- A short expiring lease around commit may return `423/409 busy`; clients retry with jitter. It must not span file upload.
- The immutable publication record stamps a stable server-issued machine ID and the user-editable machine-name snapshot. Renaming a machine changes future stamps, not history.

**Recommendation.** Publish immutable content and a canonical manifest first, then atomically promote a D1 head with a base-generation compare-and-swap. Reject stale commits and require an explicit user-confirmed rebase/overwrite; use only a short commit lease, never an upload-length lease. This prevents half-published sites and silent cross-machine overwrites while keeping crash recovery simple.

## 3. Upload API

### Presigned R2 PUT versus Worker proxying

Use authenticated Worker endpoints to authorize and account for an upload, but send object bytes directly to R2 with S3-compatible presigned PUT URLs. Cloudflare's [presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) confirms that a URL authorizes anyone holding it until expiry, can be reused until expiry, and can sign `Content-Type` so a mismatch fails signature validation. Expiry may be 1 second to 7 days; zudo-ez-host should use 10 minutes and allow an authenticated refresh for an uncommitted attempt.

Generate signatures inside the Worker with `aws4fetch` (or the supported AWS SDK) and server-held R2 credentials. Bind each URL to one exact bucket key and `PUT`, and sign the declared content type and `Content-MD5`. R2's current [S3 compatibility matrix](https://developers.cloudflare.com/r2/api/s3/api/) lists `Content-MD5` for `PutObject`; do not assume AWS's newer full-object SHA-256 checksum headers work identically (R2 currently describes SHA-256 as a composite checksum). The app computes SHA-256 and MD5 from the same opened byte stream. Treat the URL as a bearer secret: never log its query string. Content-addressed keys make accidental reuse idempotent, but URLs are not single-use. Promotion must independently verify object length, R2's transport-integrity result/ETag, and attempt ownership; possession of a PUT URL is not permission to promote. Keep object keys project-scoped so a compromised account cannot poison another account's deduplication namespace. If cryptographic server verification of the SHA-256-to-bytes mapping becomes a requirement, add an asynchronous verifier or proxy those uploads rather than claiming that presigning alone provides it.

Worker-mediated streaming is simpler for very small payloads and keeps all policy in one request, but it puts every byte through Worker request limits and billing, adds an extra hop, and makes large/resumable uploads harder. Keep it only as a possible small-object fallback, not the primary path.

### Multipart, quotas, and rate limits

Set conservative v1 product limits, deliberately far below R2's platform maximum:

| Limit | Proposed v1 value |
| --- | ---: |
| One file | 100 MiB |
| One project/artifact | 20,000 files and 2 GiB |
| Active published data per account | 10 GiB |
| Retained plus staged physical data per account | 20 GiB before GC/cleanup is required |
| Canonical manifest body | 10 MiB |
| Open publication attempts | 3 per project, 20 per account |
| Client upload concurrency | 8 PUTs per machine |

These are product safeguards, not R2 limits. Current [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) allow a 5 GiB single-part object and 5 TiB object overall; [multipart uploads](https://developers.cloudflare.com/r2/objects/multipart-objects/) allow up to 10,000 parts, with 5 MiB minimum non-final parts and automatic abort after 7 days by default. Because v1 rejects files above 100 MiB, it can ship without multipart. If the product later raises that limit, use R2 multipart above 100 MiB: the Worker creates the multipart upload, signs individual part PUTs, records/reserves the expected total, completes it only after validation, and explicitly aborts abandoned attempts in addition to an R2 lifecycle rule.

Quota reservation occurs transactionally during `prepare` from the canonical manifest. Count logical active bytes for the customer limit, but also cap physical retained/staged bytes so repeated failed publications cannot create unlimited storage. Release reservations on commit/expiry, and garbage-collect expired attempts. Do not trust the client-reported account usage or use the eventually consistent rate limiter for billing/quota correctness.

Apply coarse abuse controls to authenticated control-plane calls: initially 30 prepares per account per hour, 10 commits per project per minute, and 1,000 presigned-URL issuances per account per minute, with retry guidance and operator-configurable values. The [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is intentionally permissive and eventually consistent, so it is suitable for abuse damping. Exact concurrent-attempt and byte/file limits belong in D1. Also cap manifest parsing before allocating per-entry objects and make prepare/commit idempotent.

**Recommendation.** Authorize, reserve, and commit through the Worker, while uploading missing immutable objects through 10-minute presigned R2 PUTs. Sign the exact key, content type, and supported MD5 transport checksum; verify length/transport integrity before promotion; and treat URL issuance—not PUT arrival—as the policy boundary. Keep SHA-256 as the authenticated client's logical identity, project-scope its namespace, and document that server-side SHA-256 recomputation is deferred. Start with the concrete v1 limits above and no multipart, while preserving a multipart upgrade path. This avoids Worker byte proxying without overstating R2 checksum support or mistaking reusable bearer URLs and eventual rate limits for quota enforcement.

## 4. Auth stack

### Worker and web authentication

Reuse Better Auth on the Worker with D1 through the Drizzle adapter, `nodejs_compat`, email/password, and Google social login. Better Auth documents the [Hono integration](https://www.better-auth.com/docs/integrations/hono), [Drizzle adapter](https://www.better-auth.com/docs/adapters/drizzle), and [social OAuth configuration](https://www.better-auth.com/docs/concepts/oauth). The webapp uses secure, HTTP-only session cookies and exact trusted origins; state-changing cookie routes enforce origin/CSRF protections.

Follow the proven zudo-doc-cloud implementation: instantiate `createAuth(env)` inside each request because the D1 binding is request-scoped, rather than capturing it at module scope; see its [auth factory](https://github.com/zudolab/zudo-doc-cloud/blob/main/packages/zudo-doc-cloud-worker/src/auth.ts). Keep secrets in Worker secrets, enable a Google provider only when both credentials are present, and register the exact production callback. Authentication identifies a user; every project/upload query must still scope by owner ID.

### Desktop login flow

Do not make the native app depend on a web session cookie. Cookie sharing between the system browser and WebView is fragile, expands CSRF/origin complexity, and gives the app more ambient authority than it needs. Do not place a long-lived personal token in a deep-link or loopback callback either; URLs leak through history, logs, and inter-process dispatch.

Use an OAuth-style browser handoff backed by the house hash-stored token model:

1. The app generates `state`, a PKCE verifier/challenge, and an ephemeral loopback listener on `127.0.0.1` (try IPv6 as well). It opens `/desktop/authorize` in the default browser with the loopback redirect, state, challenge, and proposed machine name.
2. The webapp performs normal Better Auth login; sign-up can remain on the webapp. It shows a consent page naming the machine and requested `publish` scope.
3. The server returns a random, single-use authorization code to the loopback redirect. The code expires after 60 seconds and is bound to user, redirect URI, PKCE challenge, machine record, and scope. The callback contains no session or API token.
4. The app validates `state` and exchanges the code plus verifier over TLS. The response shows the new machine credential exactly once. Store only its SHA-256 hash, prefix/version, owner, scope, expiry, machine ID, creation/last-use/revocation timestamps server-side.
5. Store the raw credential in macOS Keychain, not WebView local storage or a plaintext settings file. Apple's [Keychain services](https://developer.apple.com/documentation/security/keychain-services) are specifically for small secrets. Give credentials a one-year maximum lifetime, rotate on reauthentication, and let the webapp list/revoke machines; the app can revoke its own credential on sign-out.

This follows [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252): native authorization uses an external user-agent, public clients use PKCE, and desktop apps may receive a redirect on an ephemeral loopback port. Prefer the loopback redirect for the first macOS implementation because it avoids custom-scheme claiming. A claimed HTTPS universal link is a later stronger alternative; a reverse-domain custom scheme is a fallback. The loopback listener accepts one request, verifies the exact path/state, returns a minimal success page, and shuts down.

The resulting bearer is a machine-scoped personal API token in operational terms: random high entropy, mint-once, hash-stored, revocable, and incapable of minting/revoking other credentials. It should authorize sync/project operations only. Keep token-management and account-destructive routes session/reauth-only, matching the zudo-doc-cloud [`zdc_` token pattern](https://github.com/zudolab/zudo-doc-cloud/blob/main/doc/src/content/docs/spec/api-tokens.mdx). Use a zudo-ez-host-specific prefix/version so logs and middleware can classify it safely.

### Mac App Store account requirements

The current [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) matter even if App Store submission is later:

- Guideline 4.8 says an app using Google or another third-party service for its primary account must also offer an equivalent privacy-preserving login option unless an exception applies. Before an App Store build exposes Google login, add Sign in with Apple (or remove third-party login from that build). Email/password should remain, but should not be assumed to satisfy every property of the equivalent-login rule.
- Guideline 5.1.1(v) requires account deletion within the app when account creation is supported, and requires revocation of social-network credentials/data access from within the app. Add a discoverable native Account screen that can initiate deletion (with browser reauthentication if necessary), and provider unlink/revocation before submission. A web-only sign-up does not justify omitting the in-app deletion entry point.
- Ship an accessible privacy policy and data retention/deletion explanation. Login is defensible because cloud publication, project ownership, quotas, and machine history are significant account-based features.

**Recommendation.** Reuse per-request Better Auth/D1 with email/password and Google for the webapp. Authenticate the Mac app through the default browser, then exchange a 60-second, single-use, state- and PKCE-bound code for a one-year revocable machine-scoped bearer stored in Keychain; never pass the bearer in the callback or reuse browser cookies. Before Mac App Store submission, add Sign in with Apple if Google remains visible, plus in-app account deletion and provider revocation. This combines house operational patterns with native-app OAuth security and avoids designing into an App Review dead end.

## 5. Desktop app

### Tauri menu-bar feasibility and lifecycle

Tauri v2 is suitable and matches the house desktop stack. Its official [system tray guide](https://v2.tauri.app/learn/system-tray/) supports `TrayIconBuilder`, menus, menu events, and click events. Build a normal Tauri app whose main window is hidden by default and shown for setup, project status, errors, account management, and preferences. Closing the window hides it; only an explicit Quit menu action stops watchers and exits. Use accessory/menu-bar activation behavior on macOS so a Dock icon is not required during normal operation, while retaining an ordinary window that is keyboard and VoiceOver accessible.

Keep the authoritative sync engine in Rust rather than the WebView. Use `notify::recommended_watcher` recursively on the selected root, retain the watcher handle for the app lifetime, and feed hints into the debounced full-scan state machine from topic 1. Re-establish watchers after root changes, wake, permission failures, and watcher errors. Each immediate child directory is a project; root-level loose files are ignored with a visible explanation. Directory create/rename/delete changes the project inventory and triggers reconciliation.

Launch at login must be an explicit, reversible preference. Tauri's [autostart plugin](https://v2.tauri.app/plugin/autostart/) supports macOS `LaunchAgent` plus enable/disable/status operations. Start hidden, do not prompt for login merely because macOS launched the app, and surface offline/auth errors in the tray without tight retry loops.

### User-selected root and future sandboxing

Select the root through the native folder picker and store a stable bookmark, not only a path string. A direct-download build can initially run unsandboxed, but the persistence layer should already abstract `resolve sync root -> access guard -> path`. The Mac App Store requires App Sandbox; both Apple's [App Sandbox overview](https://developer.apple.com/documentation/security/app-sandbox) and Tauri's [App Store distribution guide](https://v2.tauri.app/distribute/app-store/) state that requirement. Apple's [sandbox file-access guidance](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox) requires a user-selected-files entitlement and security-scoped URL bookmark to regain access after relaunch. For this publisher, request read-only user-selected access unless product behavior later writes local metadata inside the root; app state belongs in the container. Resolve stale bookmarks, call start/stop security-scoped access correctly, and test recursive watcher behavior in an actually signed sandbox build before calling App Store support complete.

### Updates, signing, and notarization

For direct distribution, use the [Tauri updater plugin](https://v2.tauri.app/plugin/updater/) against a TLS static JSON/dynamic endpoint. Tauri requires signed update artifacts and does not allow signature verification to be disabled. Keep its private updater key in release secrets and the public key in app configuration; losing the private key prevents updating installed clients. Check periodically and from a menu action, download in the background, and ask before restart when a publication is active.

Direct macOS releases need an Apple Developer membership, a Developer ID Application certificate, hardened-runtime-compatible entitlements, code signing of all nested code, notarization, and stapling. Tauri's [macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) distinguishes Developer ID Application for outside-store shipping from Apple Distribution for the App Store and states that Developer ID releases require notarization. Build/test both Apple Silicon and Intel targets or a verified universal binary according to the supported OS matrix.

The Mac App Store channel uses Apple Distribution, a Mac App Store provisioning profile, sandbox entitlements, App Store Connect review, and App Store updates rather than the direct updater. Maintain separate release configurations/entitlements so direct and store builds cannot accidentally use the wrong updater or signing identity.

**Recommendation.** Build the Mac client as a Tauri v2 accessory/menu-bar app with a Rust-owned watcher/sync engine, an opt-in LaunchAgent, and a native setup/status window. Store credentials in Keychain and the selected root as a security-scoped bookmark abstraction from day one. Ship direct releases with signed Tauri updates plus Developer ID signing/notarization; treat the App Store as a separate sandboxed, Apple-signed update channel. This uses proven house technology while isolating the two macOS distribution models and their security constraints.

## Open questions

1. Are the proposed v1 quotas (100 MiB/file, 20,000 files and 2 GiB/project, 10 GiB active/account) compatible with the intended pricing tiers and representative generated sites? Measure real sites before freezing API constants.
2. Is a 30-day whole-publication rollback window sufficient, and is rollback self-service or operator-only at launch? Retention directly affects the physical-storage cap and GC design.
3. What periodic full-scan interval balances missed-event recovery against battery/SSD cost (candidate: 15 minutes while active, plus immediate scan on wake)? This needs profiling on large trees.
4. What should happen when another machine advances a project: require confirmation every time, allow a per-project designated publisher, or offer an optional automatic-overwrite policy? The protocol should keep compare-and-swap regardless.
5. Should machine credentials expire after one year, or should active devices rotate transparently sooner? The answer needs a recovery and stolen-device policy.
6. What minimum macOS version and CPU support matrix will ship? This determines universal-binary work, bookmark behavior to test, and the oldest supported Tauri/WebKit runtime.
7. Will the Mac App Store build be a real target soon enough to justify implementing security-scoped bookmarks in the first desktop milestone, or only preserving the abstraction and test spike? A signed sandbox prototype should resolve this before the watcher implementation hardens.
8. Will Google login remain visible in the Mac App Store build? If yes, Sign in with Apple, account-linking behavior, provider revocation, and App Review test credentials need their own implementation milestone.
