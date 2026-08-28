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
   DNS/Worker route and a control-plane domain. Domain and route provisioning is
   the operator checkpoint; never silently treat the conventional production
   Worker name on `workers.dev` as a valid tenant hostname.
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

## Cloudflare references

- [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)
