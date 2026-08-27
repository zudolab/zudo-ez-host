# Optional remote R2 S3 smoke

The storage package tests use the local workerd R2 binding for completed
uploads. They intentionally do not contact a real R2 bucket or expose an R2
credential in CI.

When credentials and a disposable bucket are available, a follow-up contract
smoke may be run behind an explicit environment gate using the same
`Aws4FetchUploadUrlSigner` configuration:

- `R2_ACCOUNT_ID` — the Cloudflare account ID
- `R2_BUCKET_NAME` — a disposable test bucket
- `R2_ACCESS_KEY_ID` — an R2 API token access key
- `R2_SECRET_ACCESS_KEY` — the matching secret
- `R2_REMOTE_SMOKE=1` — the explicit opt-in gate

The smoke should sign one project-scoped `PUT`, upload bytes with the exact
`Content-Type`, `Content-MD5`, and `If-None-Match: *` headers, then verify the
object and delete the disposable key. Never print the signed URL or secret
values. This is an operator follow-up, not a package test or CI step.
