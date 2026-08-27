# zudo-ez-host

zudo-ez-host is a Dropbox-public-folder-like hosting system whose Mac menubar app will sync directories to Cloudflare, with each directory becoming a hosted static site.

## Status

This repository is in the pre-implementation bootstrap and specification phase. Product packages, Workers, and the documentation site will arrive in later work.

## Development

Use Node.js 22.12 or newer and install the pinned pnpm toolchain:

```sh
pnpm install
pnpm verify
pnpm b4push
```

The documentation site will live in [`doc/`](doc/) once it is added. The implementation plan is tracked in [epic #2](https://github.com/zudolab/zudo-ez-host/issues/2).
