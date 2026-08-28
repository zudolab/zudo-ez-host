# zudo-ez-host

zudo-ez-host is a Dropbox-public-folder-like hosting system whose Mac menubar app will sync directories to Cloudflare, with each directory becoming a hosted static site.

## Status

The bootstrap and specification phase is complete. First-party packages under
`packages/*` and the identity foundation under `workers/*` are now in scope.
Invited email/password accounts, canonical handles, named-machine enrollment,
and machine-scoped publication authorization have landed. A documented,
operator-invoked deploy path now exists for staging and production, including
resource provisioning, migrations, configuration preflight,
control-before-public deployment, and gated remote smoke. No real Cloudflare
deployment has been performed yet; deployment still requires an authenticated
operator, and production domains, resources, routes, and secrets remain
prerequisites. The bilingual documentation site is scaffolded under
[`doc/`](doc/).

## Development

Use Node.js 22.12 or newer and install the pinned pnpm toolchain:

```sh
pnpm install
pnpm verify
pnpm b4push
```

The bilingual documentation site is in [`doc/`](doc/). The implementation plan is tracked in [epic #2](https://github.com/zudolab/zudo-ez-host/issues/2).
