# zudo-ez-host

zudo-ez-host is a Dropbox-public-folder-like hosting system whose Mac menubar app will sync directories to Cloudflare, with each directory becoming a hosted static site.

## Status

This repository is in the pre-implementation bootstrap and specification phase. Product packages and Workers will arrive in later work; the bilingual documentation site is scaffolded under [`doc/`](doc/).

## Development

Use Node.js 22.12 or newer and install the pinned pnpm toolchain:

```sh
pnpm install
pnpm verify
pnpm b4push
```

The bilingual documentation site is in [`doc/`](doc/). The implementation plan is tracked in [epic #2](https://github.com/zudolab/zudo-ez-host/issues/2).
