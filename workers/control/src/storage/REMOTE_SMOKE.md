# Optional remote publication smoke

The storage package tests use the local workerd R2 binding for completed
uploads. They intentionally do not contact a real R2 bucket or expose an R2
credential in CI.

The operator follow-up now lives in
[`scripts/remote-smoke/`](../../../../scripts/remote-smoke/) and is run from the
repository root with `pnpm smoke:remote`. It is gated by
`EZ_HOST_REMOTE_SMOKE=1`, is not part of package tests or CI, and covers the
complete invited signup through served-byte lifecycle rather than signing a
standalone request.

It generates unique content, asserts that real signing produced at least one
missing-object contract, uses that contract for the presigned `PUT` with exact
`Content-Type`, `Content-MD5`, and `If-None-Match: *` headers, verifies and
commits it, and optionally checks serving. Direct remote D1/R2 cleanup always
runs and has an independent verdict. See the
[environment runbook](../../../../docs/ops/environments.md#gated-remote-smoke)
for the required operator settings, serving precondition, deletion order, and
credential permissions.
