# Hosting, domains, tenancy, and security research

Status: decision input for the initial architecture ADR. Pricing and limits were
checked on 2026-08-27 and are snapshots, not contractual quotes.

## Executive recommendation

Host the authenticated product on `zudo-ez-host.app`, but serve user-controlled
files from a second registrable domain that has no authenticated application on
it. Give each project one DNS label, for example
`<project>--<user>.<public-domain>`, behind one public, secrets-free Worker. The
Worker resolves immutable, content-addressed artifacts in a private R2 bucket
and calls a narrow internal service for current publication/password-gate
authorization. Do not use Workers for Platforms unless the product later lets
customers deploy executable Worker code.

This avoids per-tenant certificates, keeps Universal SSL sufficient, isolates
untrusted HTML from control-plane cookies, and retains one place to implement
static-host and gate semantics. The literal issue #1 URL,
`<project>.<user>.zudo-ez-host.app`, is technically possible but not a good
default at scale because it needs non-Universal certificate machinery.

## 1. URL scheme and certificates

### Constraint

In a full DNS setup, Universal SSL covers the zone apex and exactly one label
below it. It covers `foo.zudo-ez-host.app`, but not
`foo.takazudo.zudo-ez-host.app`. A DNS wildcard and a Workers wildcard route do
not change TLS certificate coverage. Cloudflare documents this limitation and
the ACM/Total TLS alternatives in [Universal SSL
limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

### Options and cost/scale

| Option                                              | Feasibility and operational shape                                                                                                                                                                                                                                                                                                                                     | Current cost/limit signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-user ACM wildcard, `*.<user>.zudo-ez-host.app`  | Technically covers every project of one user. It requires one SAN per user, certificate issuance/rotation, and capacity that grows with users rather than projects.                                                                                                                                                                                                   | [Advanced certificates](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/) allow 50 hosts per certificate, but the apex consumes one, leaving at most 49 user wildcards. The public documentation only promises up to 100 edge certificates per zone for Enterprise ACM, so even that published shape tops out at 4,900 user wildcard SANs before a different contract/design. ACM is currently [listed at $10/month](https://www.cloudflare.com/plans/); Enterprise capacity and price require a quote. |
| ACM Total TLS with exact project hostnames          | Technically possible if the system creates a proxied exact DNS hostname for every project and lets Total TLS issue an individual certificate. It replaces wildcard-certificate bookkeeping with per-project DNS/certificate lifecycle and should be load-tested against issuance latency and CA limits.                                                               | Total TLS is included with ACM and [issues individual certificates for proxied hostnames](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/). The self-serve add-on starts at $10/month; no public guarantee found makes this an unlimited multi-tenant hostname service.                                                                                                                                                                                                                                |
| Cloudflare for SaaS exact custom hostnames          | The literal two-level scheme can be registered one project at a time. Cloudflare explicitly [supports custom hostnames that are subdomains of the SaaS zone](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/), so this is a supported certificate lifecycle, but project count becomes a recurring billable dimension. | [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) include 100 hostnames, then charge $0.10/hostname/month, with a 50,000-hostname self-serve maximum. Thus 10,000 exact project hostnames would be about $990/month beyond the included 100, before other services.                                                                                                                                                                                                         |
| Cloudflare for SaaS wildcard custom hostnames       | One `*.<user>.zudo-ez-host.app` entry per user would restore the visual two-level hierarchy and reduce entries versus exact project hosts.                                                                                                                                                                                                                            | Wildcard custom hostnames are **Enterprise only** and have custom pricing; Free, Pro, and Business explicitly say “No.” See the [plan table](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) and [setup behavior](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/).                                                                                                                                                                             |
| Single-label encoding, `<project>--<user>.<domain>` | One wildcard DNS record/route and Universal SSL cover every project. No certificate object is created per user or project.                                                                                                                                                                                                                                            | Universal SSL is included on all zone plans. The DNS label is limited to 63 octets; the proposed grammar in section 6 budgets for that limit.                                                                                                                                                                                                                                                                                                                                                                                                |
| Single label on a separate public-content domain    | Same certificate simplicity as the previous option, plus a registrable-domain security boundary from the authenticated app.                                                                                                                                                                                                                                           | Adds one domain registration/renewal. Registrar price and availability are dynamic and must be checked by a human immediately before purchase.                                                                                                                                                                                                                                                                                                                                                                                               |

**Recommendation:** use `<project>--<user>.<public-domain>` on a separately
registered public-content domain. The literal issue #1 scheme is feasible for a
small deployment with the $10/month ACM add-on and exact-host provisioning, or
as a metered SaaS-hostname/Enterprise design, but it is not a cost-stable or
low-operations choice at scale. Preserve the two logical components in product
UI even though DNS encodes them into one label.

Rationale: this is the only option that simultaneously uses included Universal
SSL, has constant certificate operations as tenants grow, and creates the
strong registrable-domain boundary required by section 5.

## 2. Workers for Platforms

[Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
is a system for a platform to upload and execute each customer's Worker code in
an isolated user Worker. A dynamic dispatch Worker selects a script in a
dispatch namespace; an optional outbound Worker controls egress. Its isolation
is compute isolation, not “a separate environment per user's static files.”
The [architecture documentation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
says user Workers are untrusted by default, do not share cache, and cannot read
`request.cf`; namespaces have unlimited scripts, although API and runtime limits
still apply.

The product can attach [static assets to each user
Worker](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/),
so it could host these sites. However, zudo-ez-host tenants supply files, not
server-side Worker programs. Per-tenant code deployment, dispatch lifecycle,
script observability, and isolated compute add machinery without improving the
R2 object-key and authorization isolation needed for file hosting.

The current [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)
is $25/month including 20 million requests, 60 million CPU-ms, and 1,000
scripts; overages are $0.30/million requests, $0.02/million CPU-ms, and
$0.02/additional script. One inbound dispatch/user/outbound chain is billed as
one request and aggregates CPU across the chain.

**Recommendation:** do not use Workers for Platforms for v1. Reconsider only if
users are allowed to deploy executable Worker code or require tenant-specific
runtime bindings/limits. A single trusted responder is cheaper, simpler to
audit, and matches static file tenants.

## 3. Serving architecture

### Options

**One public Worker plus private R2.** The Worker parses the host/path, asks a
narrow control service which immutable artifact is live and whether it is
authorized, then reads `artifacts/<content-hash>/<path>` from R2. This follows
the working zudo-doc-cloud pattern: immutable content-addressed artifacts,
wildcard ingress, and a public responder with no authoring credentials or
secrets. R2's Workers API exposes HTTP metadata, conditional reads, ranges, and
quoted `httpEtag` values; see the [R2 Workers API
reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

For wildcard ingress, create a proxied wildcard DNS record on the public zone
and attach `*.public-domain/*` to the responder as a Workers Route. A Worker
Custom Domain is not a substitute because [Custom Domains do not support
wildcards](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
Cloudflare's [route documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/)
requires a proxied DNS record; an originless setup can use the reserved `100::`
placeholder (`AAAA * -> 100::`), as in zudo-doc-cloud. Treat DNS, the route,
and certificate coverage as three separate readiness checks.

**R2 public bucket/custom domain.** `r2.dev` is explicitly non-production and
variably rate-limited. A production custom domain supports CDN caching, but a
direct bucket mapping exposes storage-key topology and cannot perform per-host
project resolution, custom 404/SPA behavior, publication authorization, or the
password gate without putting a Worker/security product back in front. Public
access also creates a bypass unless every alternate endpoint is disabled. See
[public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

**Ordinary Workers Static Assets.** Assets are a versioned bundle attached to
one Worker deployment. Limits are currently 20,000 files/version on Free,
100,000 on Paid, and 25 MiB/file ([Workers
limits](https://developers.cloudflare.com/workers/platform/limits/)). Replacing
one user's site would redeploy a shared bundle, couple all tenant versions, and
eventually hit per-version file count. Workers for Platforms can attach a
separate asset bundle per user Worker, but then incurs the complexity and cost
described in section 2.

### Cost and cache strategy

Regular Workers Paid currently has a $5/month account minimum, including 10
million requests and 30 million CPU-ms; overages are $0.30/million requests and
$0.02/million CPU-ms. Cloudflare notes that a Worker runs before ordinary CDN
cache, so cache hits still count as Worker requests. See [Workers
pricing](https://developers.cloudflare.com/workers/platform/pricing/).

R2 Standard currently includes 10 GB-month, 1 million Class A operations, and
10 million Class B operations monthly. Beyond that it is $0.015/GB-month,
$4.50/million Class A, and $0.36/million Class B, with no R2 egress fee. See
[R2 pricing](https://developers.cloudflare.com/r2/pricing/). Standard is a
better default than Infrequent Access for live assets because the latter adds
retrieval fees and a 30-day minimum.

For public projects, cache immutable bytes under a key containing the exact
artifact hash and normalized path, not merely the vanity hostname. Return
fingerprinted assets with `Cache-Control: public, max-age=31536000, immutable`.
Return mutable HTML entry points with a short browser TTL (for example,
`max-age=0, must-revalidate`) while allowing a bounded CDN TTL through
`CDN-Cache-Control`; use ETags. Publication/takedown authorization must occur
before any cache read, so an old cached artifact cannot bypass unpublish. Do
not cache misses for long. Section 7 deliberately disables shared caching for
gated projects initially.

**Recommendation:** use one public, secrets-free Worker, one private R2 artifact
bucket per environment, and a narrow internal authorization service. Cache
only content-addressed public bytes, after current publication authorization.
Do not enable `r2.dev`, public bucket access, or a second direct origin path.

## 4. Static-host semantics

Define these rules as a versioned serving contract rather than inheriting
whatever a local preview server happens to do:

| Concern                    | V1 behavior                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Methods                    | `GET` and `HEAD` only for content. Other methods return 405 with `Allow: GET, HEAD`. The gate login endpoint is the sole narrow POST exception.                                                                                                                                                                                                                                                            |
| Path safety                | Parse percent encoding once; reject malformed encodings, NUL, backslash, encoded separators, and `.`/`..` segments. Ignore the query string for object lookup but retain it in redirects. Never concatenate a raw path into an R2 key.                                                                                                                                                                     |
| Exact files                | `/x.css` resolves only the exact case-sensitive artifact entry `x.css`. Do not add implicit `.html`.                                                                                                                                                                                                                                                                                                       |
| Root/index                 | `/` resolves `index.html`. A path ending in `/` resolves `<path>/index.html`.                                                                                                                                                                                                                                                                                                                              |
| Directory canonicalization | If `/docs` has no exact file but `docs/index.html` exists, return 308 to `/docs/`, preserving the query. This makes relative URLs deterministic.                                                                                                                                                                                                                                                           |
| Not found                  | If no entry resolves, serve the project's root `404.html` with status 404 when present; otherwise return a small platform-owned 404. Never expose object keys or distinguish unpublished, suspended, nonexistent, and unauthorized projects.                                                                                                                                                               |
| MIME                       | Determine from a versioned extension map at sync/build time, store validated HTTP metadata in the manifest, and emit `Content-Type` plus `X-Content-Type-Options: nosniff`. Unknown types are `application/octet-stream`; do not trust user-supplied upload headers. R2 supports stored `contentType` and other [HTTP metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).  |
| Cache headers              | Use the public/gated split in sections 3 and 7. User files may not override platform cache, cookie, CORS, CSP, or security headers through metadata.                                                                                                                                                                                                                                                       |
| SPA fallback               | Default off. Allow an explicit per-project option. When enabled, only unmatched HTML navigation requests (`GET`/`HEAD` with navigation or HTML acceptance) receive root `index.html` with 200; missing asset-like requests remain 404. Cloudflare's own [SPA mode](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/) similarly falls back for navigation requests. |
| Symlinks                   | Reject every symlink at sync time, even one currently resolving inside the root. This avoids host-dependent targets, later retargeting, loops, and accidental reads outside the project.                                                                                                                                                                                                                   |
| Dotfiles                   | Exclude/reject every path segment beginning with `.` by default. A future allowlist may admit exact safe paths such as selected `.well-known/*`; never publish `.git`, environment files, editor state, or build credentials.                                                                                                                                                                              |
| Case                       | Preserve and compare path bytes case-sensitively. Reject a sync containing portable-case collisions such as `Logo.png` and `logo.png`, so results do not depend on the uploader's filesystem. DNS host labels are separately lowercase/case-insensitive.                                                                                                                                                   |

**Recommendation:** implement exactly the table above and store the semantics
version in each artifact manifest. The rationale is deterministic parity across
sync, cache, and edge serving, with conservative handling at filesystem and URL
trust boundaries.

## 5. Untrusted-content isolation

Each hosted site may execute attacker-controlled HTML/JS in a visitor's
browser. A different subdomain is a different _origin_, but it is not
necessarily a different _site_: browsers derive “site” from the registrable
domain/public suffix. Consequently `evil.public.example` and
`app.public.example` are cross-origin but same-site. See MDN's [site
definition](https://developer.mozilla.org/en-US/docs/Glossary/Site).

Putting hosted content under the same registrable domain as the control plane
would create these risks:

- a mistakenly domain-scoped application cookie is sent to every hostile
  subdomain; omitting `Domain` creates the safer [host-only
  cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie);
- SameSite protections do not treat sibling subdomains as cross-site, so they
  are not a complete CSRF boundary;
- an untrusted site can attempt form, image, navigation, and fetch requests
  toward the control plane even when CORS prevents reading responses;
- a service worker can control its entire registration origin and path scope.
  Project-per-host origins contain that scope, but an untrusted site must never
  share the control-plane origin. See [service worker
  scope](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

Required posture:

- use two registrable domains: one for authenticated control and one for all
  untrusted sites;
- control-plane session cookies use a `__Host-` prefix, `Secure`, `HttpOnly`,
  `Path=/`, an appropriate `SameSite`, and **no `Domain` attribute**;
- public-site gate cookies are also `__Host-`, scoped to that exact project
  host, and carry no control-plane authority;
- the control-plane API allows credentialed CORS only from the exact
  control-plane origin, never `*`, the content domain, reflected origins, or
  `null`; it still validates CSRF tokens and `Origin` because CORS is not CSRF
  protection;
- public sites emit no `Access-Control-Allow-Origin` by default. A future
  project CORS option must be explicit and cannot affect control APIs;
- platform error/login pages set restrictive CSP and `frame-ancestors`; do not
  impose a platform CSP on user content unless the product explicitly promises
  one.

A Private/Public Suffix List entry could make each project a distinct browser
site, but it has governance and compatibility consequences and is not needed
to protect the control plane once registrations are separate. Until then, do
not place shared secrets or domain cookies anywhere on the public-content
registration.

**Recommendation:** purchase and use a separate registrable public-content
domain, project-per-host origins, and host-only cookies. This is defense in
depth against cookie-scoping and same-site mistakes and is materially stronger
than a sibling `sites.zudo-ez-host.app` domain.

## 6. Hostname grammar and URL stability

DNS labels are case-insensitive and limited to 63 octets ([RFC
1035](https://www.rfc-editor.org/rfc/rfc1035)); use an ASCII-only allocation
grammar and never depend on display-name spelling.

Recommended V1 label:

```text
<project-slug>--<user-handle>
```

- Normalize ASCII `A-Z` to lowercase before validation. Do not trim, perform
  Unicode normalization, or accept IDNs/punycode in V1.
- Each component matches `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`, contains no `--`,
  and is stored in canonical lowercase. The double hyphen is therefore a
  collision-free delimiter.
- User handles are 3–20 characters. Project slugs are 1–41 characters, but the
  combined label must be at most 63 (`41 + 2 + 20`). A UI should show the
  remaining project budget when the handle is known.
- Reject labels/components beginning `xn--` and maintain a centrally versioned
  blocklist for platform, protocol, impersonation, and operational names,
  including at least `www`, `api`, `app`, `admin`, `auth`, `login`, `logout`,
  `account`, `billing`, `support`, `status`, `docs`, `cdn`, `assets`, `static`,
  `mail`, `ftp`, `localhost`, `staging`, `preview`, `internal`, `root`, and
  `system`. Reserve permanent-ID prefixes as well.
- Allocation is an atomic unique insert. Parsing a hostname never establishes
  ownership; the control record maps the label to immutable owner/project
  IDs.

The zudo-doc-cloud prior art uses similarly narrow ASCII normalization and
budgets `20 + 1 + 42 = 63` in
`packages/zudo-doc-cloud-artifact-response/src/vanity-label.ts`. Its important
lesson is to separate allocation policy, public labels, and immutable artifact
identity.

Renames must not silently move or recycle authority. Keep the original public
URL working across account/project display-name changes. Optionally let an
owner allocate a new canonical alias and redirect the old label, but retain old
labels as permanent aliases or tombstones and never give one to a different
account/project. This prevents old bookmarks, cookies, and service-worker
registrations from becoming a takeover path. Artifacts remain keyed by opaque
immutable IDs/hashes, never by mutable labels.

**Recommendation:** adopt the grammar above, stable immutable identity behind
it, and a no-reuse guarantee. The rationale is an unambiguous reversible label
within DNS limits and safe ownership continuity through renames/deletion.

## 7. Per-project password gate at the edge

The reference [zfb example password
gate](https://github.com/Takazudo/zfb-example-password-gate) correctly shows
that authentication must run before asset serving, that login/denial responses
need `Cache-Control: no-store`, and that the marker cookie should be Secure,
HttpOnly, and host-only. It is deliberately a single-site example: its Worker
holds a site password secret and accepts a fixed marker cookie. Repeating that
model in one multi-tenant public Worker would either aggregate tenant secrets
or let compromise of the responder grant every project.

Recommended split:

1. The public responder has only R2 read access, a narrow service binding, and
   a pinned _public_ verification key. It has no D1/control-plane binding,
   password hash/pepper, signing key, authoring bucket, or write capability.
2. A private gate-authorization service exposes only
   `getServingAuthorization(host)` and `verifyProjectPassword(projectId, password)`.
   It can read gate/publication state and use a private pepper or signing key,
   but exposes neither data store nor general SQL/write RPC to the responder.
   The service returns generic not-found/denied results.
3. Passwords are stored as a slow, salted password verifier (plus a
   service-held pepper if adopted), never plaintext. Rate-limit verification
   per project and client, cap body size, compare in constant-time, and return
   the same error for nonexistent/wrong-password cases.
4. Successful verification returns a short-lived signed capability containing
   immutable project ID, exact public hostname, gate-version epoch, issued/
   expiry times, and random token ID. The responder verifies it with the public
   key and sets it in a `__Host-` Secure, HttpOnly, Path=/, SameSite=Strict
   cookie. Gate/password changes increment the epoch; the current authorization
   lookup invalidates old tokens.
5. The responder performs current publication/gate authorization **before**
   reading bytes or any shared cache. It never trusts a cookie merely because
   its signature is valid.

For V1, every response associated with a gated project—including authorized
asset bytes—should set `Cache-Control: private, no-store` and
`CDN-Cache-Control: no-store`; auth pages and POST responses also set
`X-Robots-Tag: noindex` and must not contain the submitted password. `Vary:
Cookie` is defense in depth, not permission to cache. Do not call `cache.put`
for a gated project and ensure no cache rule overrides origin no-store. This
trades R2 Class B reads for a simple proof that one visitor's content cannot be
served to another. A later optimization may cache encrypted/content-addressed
bytes internally only if authorization always precedes the cache read and no
user-specific response is stored.

Service bindings do not add a second request fee on Workers Standard; CPU is
aggregated, as documented under [Workers service-binding
pricing](https://developers.cloudflare.com/workers/platform/pricing/). R2 reads
retain the Class B pricing in section 3.

**Recommendation:** use the narrow verifier/issuer service plus short-lived,
host-bound signed capabilities, with all gated responses excluded from shared
caches in V1. This preserves a secrets-free, read-only public responder and
gives immediate revocation through the gate epoch.

## 8. Domain strategy

`.app` is on the HSTS preload list, so browsers require HTTPS from the first
connection; Google Registry explicitly documents this for [.app](https://get.app/).
That is desirable in production but removes an HTTP fallback during DNS/TLS
provisioning. Certificate readiness and HTTPS smoke tests must therefore be a
hard deployment prerequisite. Local development should use localhost rather
than pretending an HTTP `.app` hostname works.

Use `zudo-ez-host.app` only for the authenticated control plane and marketing.
Acquire a second registrable domain for public sites and serve
`<project>--<user>.<public-domain>`. The second domain may also be HSTS-preloaded
if desired; its decisive property is a different registrable domain, not its
TLD. Do not use `sites.zudo-ez-host.app`, because that remains same-site with
the control plane. Keep staging on a public-content suffix that cannot collide
with production labels, and use separate Cloudflare resources per environment.

Cloudflare Registrar sells at registry/ICANN cost without markup, but registered
domains must use Cloudflare nameservers and IDNs are not supported. See
[Registrar overview](https://developers.cloudflare.com/registrar/about/) and
[registration restrictions](https://developers.cloudflare.com/registrar/get-started/register-domain/).
Availability and both first-year and renewal price must be checked immediately
before purchase; the current Registrar API documentation even uses a $11
`.app` example, but that is illustrative, not a quote. Enable registrar lock,
DNSSEC, verified contacts, auto-renew, a monitored billing method, and expiry
alerts.

**Human prerequisite (not performed here):** choose, availability-check,
approve, and purchase the second public-content domain; record its renewal
owner and recovery procedure. Domain purchase is billable, non-refundable, and
outside automated implementation authority.

**Recommendation:** two registrations, with `.app` for the authenticated app
and a separately purchased domain for hostile public files. The rationale is a
browser-enforced HTTPS control plane plus a real cookie/SameSite boundary.

## 9. cloudflare-wisdom gap list

A targeted search of `zudo-cloudflare-wisdom/src/content/docs` found no recipes
for the areas this decision depends on. These are `/dev-upstream-report`
candidates only; this research does not submit them upstream:

1. `workers-for-platforms/dispatch-namespaces-and-tenant-code.mdx` — dynamic
   dispatch, trusted versus untrusted namespaces, bindings, cache isolation,
   custom limits, and when static-file tenancy does not justify WfP.
2. `ssl/cloudflare-for-saas-custom-hostnames.mdx` — exact versus wildcard custom
   hostnames, certificate/DCV lifecycle, the 100-included/$0.10 pricing shape,
   50,000 self-serve limit, and Enterprise-only wildcards.
3. `ssl/deep-subdomains-acm-total-tls.mdx` — Universal SSL's one-label boundary,
   ACM wildcard SAN budgeting, Total TLS, certificate limits, and decision
   examples.
4. `workers/wildcard-dns-and-routes.mdx` — proxied wildcard DNS, originless
   Worker routing, route-pattern behavior, TLS as a separate concern, and
   current Custom Domain wildcard limitations. Cloudflare's [route
   documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/)
   is the primary starting point.
5. `recipes/multi-tenant-static-sites-r2.mdx` — immutable manifests/artifacts,
   host-to-tenant authorization, safe path resolution, MIME/ETag/range handling,
   cache keys, unpublish/takedown ordering, and preventing public-bucket bypass.
6. `recipes/untrusted-sites-domain-isolation.mdx` — registrable domains, host-only
   cookies, SameSite versus same-origin, CORS/CSRF, service workers, and PSL
   considerations.
7. `recipes/multi-tenant-password-gate.mdx` — slow password verifiers,
   least-privilege service bindings, signed capability cookies, revocation
   epochs, rate limiting, and cache exclusion.
8. `recipes/better-auth-workers-security.mdx` — a current better-auth recipe for
   Workers covering trusted origins, host-only cookies, CSRF, proxy headers,
   secret placement/rotation, and separation from untrusted content domains.

**Recommendation:** prioritize gaps 2, 4, 5, and 6 before implementation, then
7 and 8 before authentication/gates ship. They capture the cross-product
failure modes most likely to be missed by isolated product guides.

## Open questions

1. Which second public-content domain will the human owner purchase, and what
   are its live registration and renewal prices?
2. Should V1 permit owners to allocate a new URL after a handle/project rename,
   or only preserve the original stable URL? Either policy must retain old
   labels permanently and never reassign them.
3. What maximum artifact size/file count, retention window, and per-owner
   storage quota fit the approved R2 cost ceiling?
4. Is per-project SPA fallback required at launch, or can the flag be reserved
   in the manifest schema while all V1 projects use static 404 semantics?
5. Which password-verifier algorithm and parameters are practical in the
   selected private Worker/service runtime? Benchmark the choice and document a
   rehash/migration path before implementation.
6. What capability TTL and rate limits meet the intended “shared password” user
   experience and abuse budget?
7. Does the public-content domain need a Private/Public Suffix List submission
   later for project-to-project site isolation? This is not needed for the
   recommended control-plane boundary, but may matter if hosted projects gain
   sensitive cookies or stateful APIs.
8. If product requirements insist on the literal two-level hostname, obtain a
   written Cloudflare quote/limit confirmation and load-test exact-hostname
   issuance before selecting ACM Total TLS, Cloudflare for SaaS exact hostnames,
   or Enterprise wildcard custom hostnames.
