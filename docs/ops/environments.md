# Worker environments

The top-level sections in both Worker `wrangler.toml` files are local/workerd
fixtures. Deploy only the named `staging` and `production` environments. Their
bindings are deliberately complete because Wrangler does not inherit variables,
secrets, D1 databases, R2 buckets, or service bindings into named environments.

`scripts/env-requirements.json` is the machine-readable form of the tables below.
`node scripts/check-environment-config.mjs` checks that it remains aligned with
both Wrangler files and enforces the cross-Worker resource topology.

## Provisioning before the first deploy

Agent and CI work is credential-free. An authenticated operator performs these
steps once per environment:

1. Create `zudo-ez-host-control-staging` and
   `zudo-ez-host-control-production` D1 databases. Replace the all-zero
   `database_id` in the matching `[[env.*.d1_databases]]` block with the ID
   returned by Wrangler. The all-zero values are explicit provisioning markers;
   a deploy must not proceed with them.
2. Create the private `zudo-ez-host-artifacts-staging` and
   `zudo-ez-host-artifacts-production` R2 buckets. Keep public bucket access and
   `r2.dev` disabled.
3. Replace `YOUR_CLOUDFLARE_ACCOUNT_ID`, `YOUR_WORKERS_SUBDOMAIN`,
   `YOUR_CONTROL_DOMAIN`, and `YOUR_PUBLIC_DOMAIN` in the applicable environment.
   The account ID is a non-secret identifier used to form the R2 S3 endpoint.
4. For staging on `workers.dev`, name the public Worker after the one smoke
   project's exact `<slug>--<handle>` label. The committed `smoke--operator`
   name is only the default smoke identity; change it if the provisioned project
   differs. `PUBLIC_BASE_DOMAIN` is the account's
   `<subdomain>.workers.dev`, without that project label.
5. Production needs a separate registrable public-content domain with a wildcard
   DNS/Worker route and a control-plane domain. The committed production route
   descriptors become active after the domain placeholders are replaced; create
   the required zone/DNS state before deploying them. Never silently treat the
   conventional production Worker name on `workers.dev` as a valid tenant
   hostname.
6. Create a bucket-scoped R2 API token, then use interactive Wrangler prompts to
   set each secret below, for example:

   ```sh
   pnpm --dir workers/control exec wrangler secret put BETTER_AUTH_SECRET --env staging
   ```

   Do not place secret values in Wrangler TOML, shell history, or committed
   files.

After substitution, run the invariant check and a credential-free validation:

```sh
node scripts/check-environment-config.mjs
pnpm --dir workers/control exec wrangler deploy --dry-run --env staging
pnpm --dir workers/public exec wrangler deploy --dry-run --env staging
```

Repeat the dry runs with `--env production`. Actual deploys remain
operator-invoked and are outside the repository verification gate.

## D1 migrations

Apply the control Worker migrations before deploying that Worker in each
environment. From the repository root, run the local command for local
development, or the named remote command after the corresponding D1 database
has been provisioned. Run one target at a time with an authenticated Wrangler
session:

```sh
# Local development
pnpm --dir workers/control db:migrate:local

# Staging, after provisioning and before the staging Worker deploy
pnpm --dir workers/control db:migrate:staging

# Production, after staging validation and before the production Worker deploy
pnpm --dir workers/control db:migrate:production
```

The staging and production scripts explicitly pass both `--remote` and
`--env staging` or `--env production`, so they cannot silently apply against
the top-level local D1 fixture. Confirm each migration completes successfully
before running the matching Worker deploy command.

## Control Worker requirements

| Name                          | Kind   | Environments        | Purpose                                                                                                     |
| ----------------------------- | ------ | ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_BASE_URL`        | var    | staging, production | Canonical HTTPS origin used by Better Auth.                                                                 |
| `BETTER_AUTH_TRUSTED_ORIGINS` | var    | staging, production | Comma-separated exact origins allowed to make credentialed control-plane requests.                          |
| `CONTROL_BASE_DOMAIN`         | var    | staging, production | Control Worker hostname without scheme or path. Its value must match the host in `BETTER_AUTH_BASE_URL`.    |
| `PUBLIC_BASE_DOMAIN`          | var    | staging, production | Base hostname used to construct and validate published-site hosts. It must equal the public Worker's value. |
| `R2_ACCOUNT_ID`               | var    | staging, production | Cloudflare account identifier used by the R2 S3 signing endpoint.                                           |
| `R2_BUCKET_NAME`              | var    | staging, production | R2 bucket embedded in presigned upload URLs. It must match both Workers' `ARTIFACTS` binding.               |
| `BETTER_AUTH_SECRET`          | secret | staging, production | High-entropy key used by Better Auth to protect sessions and tokens.                                        |
| `SIGNUP_ALLOWED_EMAILS`       | secret | staging, production | Private comma-separated signup allowlist.                                                                   |
| `R2_ACCESS_KEY_ID`            | secret | staging, production | Access key for the bucket-scoped R2 API token used to sign uploads.                                         |
| `R2_SECRET_ACCESS_KEY`        | secret | staging, production | Secret key for the bucket-scoped R2 API token used to sign uploads.                                         |

Google OAuth remains disabled for M1. `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` are optional runtime settings,
not deployment requirements; if Google is enabled later, add them to both this
document and the environment manifest with an explicit secret classification.

## Public Worker requirements

| Name                 | Kind | Environments        | Purpose                                                                  |
| -------------------- | ---- | ------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_BASE_DOMAIN` | var  | staging, production | Base hostname against which incoming published-site hosts are validated. |

The public Worker has no secrets. Its `CONTROL` service binding must target the
same environment's control Worker and both Workers must bind the same private R2
bucket. The control Worker intentionally has no deploy-environment
`PUBLICATION_RESOLVER` self-binding; that binding exists only in the top-level
workerd fixture so a first deployment cannot deadlock on itself.

## Local development

Copy each Worker's `.dev.vars.example` to `.dev.vars` and replace its placeholder
values. `.dev.vars` is ignored and must never be committed. The examples contain
no credentials. Prefer the top-level Wrangler defaults unless local development
is specifically exercising the signer or authentication configuration.

## Gated remote smoke

`pnpm smoke:remote` is an operator-only, post-deploy proof for staging. It is
deliberately absent from `pnpm verify`, `scripts/run-b4push.sh`, and CI. With
`EZ_HOST_REMOTE_SMOKE` unset it exits successfully only after printing
`SKIPPED, NOT RUN`; that result is not evidence that staging works.

Run it only against a disposable invited email on an otherwise idle staging
environment. The email must be present in staging's `SIGNUP_ALLOWED_EMAILS`,
and the configured handle and slug must also be disposable. The harness refuses
production before its first request.

| Name                               | Purpose                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `EZ_HOST_REMOTE_SMOKE=1`           | Explicitly opts into real staging mutations.                                                       |
| `EZ_HOST_REMOTE_SMOKE_ENVIRONMENT` | Must be exactly `staging`; every other value fails closed.                                         |
| `EZ_HOST_REMOTE_SMOKE_CONTROL_URL` | Deployed control Worker HTTPS origin whose hostname names staging; no path, query, or credentials. |
| `EZ_HOST_REMOTE_SMOKE_EMAIL`       | Dedicated allowlisted email; teardown uses it as the recovery identity.                            |
| `EZ_HOST_REMOTE_SMOKE_PASSWORD`    | Disposable signup password. It is never printed or written to disk.                                |
| `EZ_HOST_REMOTE_SMOKE_HANDLE`      | Dedicated handle to claim.                                                                         |
| `EZ_HOST_REMOTE_SMOKE_SLUG`        | Dedicated project slug to register.                                                                |
| `EZ_HOST_REMOTE_SMOKE_D1_DATABASE` | Must be `zudo-ez-host-control-staging`; used by direct operator cleanup.                           |
| `EZ_HOST_REMOTE_SMOKE_R2_BUCKET`   | Must be `zudo-ez-host-artifacts-staging`; used by direct operator cleanup.                         |
| `CLOUDFLARE_ACCOUNT_ID`            | Account containing the named staging resources.                                                    |
| `CLOUDFLARE_API_TOKEN`             | Operator token with D1 edit and R2 object read/write permissions for only the staging targets.     |

`EZ_HOST_REMOTE_SMOKE_PUBLIC_URL` is optional. Set it to the exact project URL
only when the public Worker is reachable for the configured
`<slug>--<handle>` label, either because that is the workers.dev Worker name or
because a wildcard custom domain is attached. The harness rejects a URL whose
first hostname label does not equal `<slug>--<handle>`. When it is absent,
serving is reported as `SKIPPED` in both the step table and a separate prominent
notice; it never reads as passed.

Example invocation (supply the password, API token, and account ID through the
operator's environment, not shell history or a committed file):

```sh
EZ_HOST_REMOTE_SMOKE=1 \
EZ_HOST_REMOTE_SMOKE_ENVIRONMENT=staging \
EZ_HOST_REMOTE_SMOKE_CONTROL_URL=https://control-staging.example.test \
EZ_HOST_REMOTE_SMOKE_EMAIL=remote-smoke@example.test \
EZ_HOST_REMOTE_SMOKE_HANDLE=operator \
EZ_HOST_REMOTE_SMOKE_SLUG=smoke \
EZ_HOST_REMOTE_SMOKE_D1_DATABASE=zudo-ez-host-control-staging \
EZ_HOST_REMOTE_SMOKE_R2_BUCKET=zudo-ez-host-artifacts-staging \
pnpm smoke:remote
```

The run creates fresh HTML containing a cryptographic nonce, hashes it, and
requires prepare to return at least one upload contract. The upload step then
uses that contract for a real presigned `PUT` with the returned `Content-Type`
and `Content-MD5` plus `If-None-Match: *`. A missing or unused contract is a
failure. Signed URLs, cookies, passwords, machine credentials, secret values,
and raw Wrangler output are never emitted.

Before the first HTTP write, the configuration step queries staging D1 and
requires the disposable email to be absent. An existing account, an unreadable
preflight result, or a production-shaped URL/resource name fails without
running cleanup, so a configuration typo cannot delete established state.

### Always-run cleanup

Cleanup runs after success and failure and has its own passed/failed result. It
uses Wrangler's direct remote D1/R2 operator path because the application APIs
cannot delete projects, accounts, immutable publications, or all stored
objects. Do not run two remote smokes concurrently: cleanup also removes the
staging signup rate-limit row touched during this run's time window.

The concrete deletion order is:

1. Query D1 by the disposable email for staged, content, and promoted artifact
   keys. Merge those with the in-process checkpoints so cleanup also covers a
   response lost after a successful server-side mutation.
2. Delete every discovered/checkpointed R2 key in reverse creation order:
   promoted artifact manifest, content object(s), then staged manifest.
3. In one D1 remote file batch, temporarily drop only the three immutable-delete
   triggers, then delete project heads, publication objects, publications,
   attempt objects, verified inventory, attempts, hostname allocations,
   projects, desktop codes, machines, sessions, accounts, verification rows,
   the user, and the run's signup rate-limit row.
4. Recreate the three triggers in that same batch. Do not add explicit
   `BEGIN`/`COMMIT`; D1 file imports provide the batch boundary and reject
   nested transaction statements.
5. Query D1 separately and report cleanup passed only when the disposable email
   is absent. A command error, unreadable count, or remaining row reports
   cleanup failed (`operator_cleanup_unproven`) even if the lifecycle passed.

The cleanup commands explicitly use `--remote --env staging`. They require the
account ID/API token above; the deployed Worker's R2 signing keys are not used
by teardown.

## Cloudflare references

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Wrangler D1 execute](https://developers.cloudflare.com/d1/get-started/)
- [Wrangler R2 object commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
