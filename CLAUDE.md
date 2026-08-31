# zudo-ez-host — agent operating manual

zudo-ez-host will let a Mac menubar app sync directories to Cloudflare so each directory can be served as a hosted static site.

This app is under development. NEVER consider backward compatibility until release.

## Status

The bootstrap and specification phase is complete. First-party packages under
`packages/*` and the identity foundation under `workers/*` are now in scope.
Invited email/password accounts, canonical handles, named-machine enrollment,
and machine-scoped publication authorization have landed. A documented,
operator-invoked deploy path now exists for staging and production, including
resource provisioning, migrations, configuration preflight,
control-before-public deployment, and gated remote smoke. Staging is now
deployed on real Cloudflare D1, R2, and Workers infrastructure; its end-to-end
smoke passed with a genuine presigned R2 upload, publication commit, served-byte
assertion, and direct cleanup. Production domains, resources, routes, and
secrets remain prerequisites. The bilingual documentation site is scaffolded
under [`doc/`](doc/).

## Tech stack

- pnpm monorepo with first-party packages under `packages/*`, Workers under `workers/*`, and the documentation site under `doc/`.
- TypeScript with strict compiler settings.
- Control backend: Hono on Workers, with better-auth + D1 for authentication and application data, and R2 for stored assets.
- Future styling: Tailwind v4 with three-tier primitive→semantic→component design tokens, enforced by `zudo-design-token-lint`.
- Future desktop client: a Tauri v2 Mac app.
- Documentation is built with `zudo-doc`.

Cloudflare resource provisioning and deploy execution are operator-invoked.
Keep deploy-specific dependencies in the package that owns the deploy unit.

## Commands

- `pnpm install` installs dependencies and runs `prepare`, which installs lefthook and the direct git hooks.
- `pnpm format` formats supported files; `pnpm format:check` verifies them.
- `pnpm lint` runs the flat ESLint configuration.
- `pnpm typecheck` runs strict TypeScript checking.
- `pnpm build` delegates builds to workspace packages when they exist.
- `pnpm test` runs the fast Vitest unit-test lane; test discovery is expected to find at least one test.
- `pnpm verify` and `pnpm b4push` run the collected-failure gate: frozen install, format check, lint, typecheck, build, test, documentation i18n parity, and internal-link checks.
- `pnpm init-worktree` installs the direct hook guard in a fresh worktree.

The local gate intentionally does not run heavy browser suites. Run a held-open development server only when the task explicitly requires interactive work.

## Automation

The `prepare` lifecycle script installs lefthook and then installs `.git/hooks/pre-push` directly. The direct hook prevents pushes from child worktrees; a human may use `ALLOW_WORKTREE_PUSH=1 git push ...` for an emergency override after reviewing the changes.

`scripts/run-b4push.sh` and `.github/workflows/ci.yml` must keep the same validation sequence. GitHub Actions actions are pinned to full commit SHAs.

## Key directories

- `.github/workflows/` — CI and workflow linting.
- `packages/*` — first-party libraries and shared pure logic.
- `workers/*` — deployable control-plane and public-content Workers.
- `doc/` — the scaffolded `zudo-doc` documentation site and its bilingual content.
- `scripts/` — repository automation and git hooks.
- `worktrees/` — local agent worktrees; ignored and never committed.

## Testing conventions

Issue #1 names `/test-wisdom` and `/css-wisdom` as the strategy references for this project; keep using both pointers in future sessions.

Consult the `/test-wisdom` skill when adding or changing tests. Use a multi-level strategy:

- Unit tests use Vitest for pure logic and data transformations.
- Worker tests use `@cloudflare/vitest-pool-workers` so handlers run in workerd with real bindings.
- End-to-end tests use Playwright as a central, CI-only concern.
- Heavy suites are never per-child acceptance criteria; they belong to the appropriate central CI or scheduled tier.

Choose the smallest level that can observe the behavior under test. Unit tests cannot prove browser rendering or CSS correctness, and E2E tests do not replace systematic visual verification when a visual change is in scope.

## CSS conventions

Consult the `/css-wisdom` skill before writing or reviewing non-trivial CSS. The project will use Tailwind v4 with three-tier primitive→semantic→component tokens, enforced by `zudo-design-token-lint`. Color tokens will be ported from zudo-text's `packages/color-themes`; see `docs/research/prior-art.md` for the recorded prior-art research.

When components are available, use the component-first approach and compose Tailwind utilities in the component. Do not introduce raw palette or spacing literals when a project token exists.

## Directory-scoped instructions

Check for a nearer `CLAUDE.md` before changing files in a subdirectory. New directory-scoped manuals should be listed here when later implementation work adds them.
