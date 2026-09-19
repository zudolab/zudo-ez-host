---
name: l-design-system
description: "Design-system contract for zudo-ez-host desktop and web interfaces. Consult when changing app markup, CSS, icons, themes, or diff/history views; excludes hosted user sites and the documentation site's own styling."
---

# zudo-ez-host design system

The desktop and web app share the zudo-series visual language. Their capabilities differ: web is read-only project summaries, cloud history/comparison, and user information; Tauri adds local status, file review, pull/push, and other explicitly authorized write workflows. The CLI supports macOS, WSL, and Linux independently of Tauri. Appearance preferences are local UI state and remain editable on web.

## Independent project model

Projects are unrelated folder/site units. Do not import a workbench, editing workspace, project rail, global working-target selector, or global Changes route. Start from a simple project list with a keyword filter and user-selected display properties. The primary local intent is uploading/publishing a chosen project. Offer a clearly named Push & publish shortcut for eligible changes, with explicit publication intent; keep cloud-only checkpoint saving secondary in project detail. Open comparison and history from an actual project detail page, not a global working area. Launch-check progress stays compact rather than dominating the home. Shared design language does not imply shared information architecture.

Desktop launch automatically checks local and remote state per project. Show queued/checking progress with a visible indicator and text, then remote updates, local changes, both changed, up to date, or unavailable. Show last-check time and retry. Status checks never upload, pull, or publish. A failed, incomplete, or stale check must not authorize a pull. Recheck before applying; pull-all reports safe/skip/failure outcomes by project. Web refresh loads cloud records only.

## Visual contract

- Square buttons, inputs, cards, badges, tabs, panels, and dialogs. Use `--radius-control: 0` and `--zeh-radius-dialog: 0`. Only anchored menus/toasts/popovers use `--radius-surface: 4px`; functional circles such as avatars/spinners use `--radius-circle: 50%`.
- Neutral Default palette; strong hue only for focus and semantic warning/success/danger/info. Quiet reserves indigo for one primary filled action per viewport and its soft selected fill.
- Separate app regions with 1px foreground-derived hairlines. No card shadows. A shared two-layer `--shadow-float` belongs only to floating surfaces.
- Base UI 13px; buttons/metadata 12px; uppercase labels 11px with 0.05em tracking; page heading 18px; dialog title 22px. Monospace for revision IDs, paths, line numbers, and counts. Brand is `ZUDO-EZ-HOST`.
- Header 48px; regular controls 36px; compact controls 28px; navigation 34px; file rows 32px; toolbar 40px; pane insets 24px horizontal/20px vertical; card padding 12px. These are shared named roles, not component-local literals.
- Pair internal/external spacing on the same doubling ladder. Horizontal scale: 2/4/8/12/16/24/32px. Vertical scale: 3/6/12/16/24/36/48px. Refer to css-wisdom for three-tier color architecture and app spacing.

## Tokens and themes

Use an app-owned token file and `--zeh-*` semantic roles. Do not import another application's runtime CSS or copy its feature-specific tokens. Tier 1 palette stops hold colors as `light-dark()` pairs; Tier 2 aliases semantic roles; Tier 3 component bags derive only from those roles. Component CSS and embedded viewers consume semantic/component tokens, never raw colors or palette stops.

Three palettes: **Default**, **Ink**, **Quiet**. Palette selection uses `data-palette="default|ink|quiet"` on html; only the token file selects on this attribute. Palette overrides change colors only, never shape, type, or density.

Default base colors (light/dark): bg #f5f5f5/#0b0b0c, surface #ececec/#141415, chrome #f0f0f0/#08090b, rail #e9e9e9/#050608, pane #f0f0f0/#0e0e10, fg #161616/#dedede, mild #4a4a4a/#a7a8a8, muted #686868/#8a8a8a. Use the stronger muted value on tinted washes. Accent is neutral gray. Ink is higher-contrast neutral with inverted primary. Quiet uses a mild cool neutral ramp and indigo primary. Preserve the palette stops accepted in the visual handoff, including state tones and contrast corrections; convert source numbers in the token layer, never in components.

Appearance choices are **System / Light / Dark**, independently of palette. Use `documentElement.style.colorScheme` to drive `light-dark()`. `data-theme` may report the resolved scheme but CSS must not select on it. Persist under `zudo-ez-host-palette` and `zudo-ez-host-theme`; an absent theme key means System. Apply before first paint, follow OS changes only in System mode, and synchronize across windows on storage events (removal restores System/Default). Guard unavailable storage. Theme changes must retain route, selected file, revisions, and unsaved input.

For production Tailwind v4 use preflight + utilities + the app token file; omit the default theme. Reset `--color-*: initial` and add only semantic aliases. Do not reset bare `--spacing`; retain structural zero utilities. Nonzero spacing uses named axis/role tokens. Token lint must enforce these constraints.

## Icons and controls

One app-owned SVG icon module, 24×24 viewBox, no fill, currentColor stroke, width 1.75, rounded stroke caps/joins, aria-hidden. Sizes: 12/16/20/24px through shared tokens. No feature-local duplicate icon sets or imported framework UI.

Use icons with visible text for navigation, project/file identity, meaningful status, and primary actions. Fixed meanings: folder = project; computer = local machine; cloud = saved checkpoint; upload/download = push/pull; history = checkpoints; diff = compare; window = live site; user = account. The user's requirement for recognizable file icons governs this app; do not inherit a reference's text-only document-tree rule.

Compact toolbar toggles may be icon-only with an accessible name, tooltip and aria-pressed. They have a visible square border at rest. Hover is a neutral wash. Primary actions retain short labels. Color alone never communicates state. Focus is visible; coarse-pointer targets remain at least 44×44px.

## Diff and checkpoint views

One transport-independent diff renderer supports desktop local/cloud review and read-only cloud comparisons on web. Use a changed-file rail, explicit A/B labels, old/new line numbers, +/- signs, token-backed added/removed washes, stronger inline change marks, and split/unified toggles. Added/removed inline segments remain recognizable without color alone. Keep code selectable and escaped, never rendered as HTML.

History provides right-aligned A/B selection buttons on every checkpoint row, separated from other actions by a hairline; keep both selectors visible on narrow screens. Show chosen A→B with swap and Compare. Open a project-scoped file-based comparison page: changed-file navigation with kind/line counts plus collapsible per-file diff sections, expand/collapse all and split/unified layout. History lets the user choose A and B revisions and see a genuine comparison. Identical revisions yield an unchanged state. Binary files show old/new type, size and hash plus a clear no-text-diff message. Production must bound large diffs and long lines with explicit fallback; do not invent zero line counts for omitted results.

Below 56rem use unified diff and an accessible file selector/list; retain the stored wide layout preference. At 42rem reorganize app navigation and metadata without horizontal page overflow. Contain necessary code scrolling within the viewer. Honor reduced motion.

Web never renders local filesystem state as authoritative or offers push, pull, publish, restore, conflict application, or account mutations. Tauri extends shared read views with those workflows where supported. Restore previews its destination and file effects, retains recovery history, and does not implicitly publish. Diff review itself is read-only.

## Verification

Check all three palettes in light and dark, System following an OS change, and persisted preferences. Measure square corners, 13px base, border visibility, shared SVG grammar, narrow overflow, and split-to-unified behavior. Exercise A/B comparison, added/deleted/binary/unchanged states, and verify no write controls exist on web. Browser screenshots complement these checks. Prototype HTML demonstrates structure; production uses app tokens/components. Do not treat a prototype's simulated transfer as implemented sync.

## Current file inspection

Project detail exposes Browse files. Use a nested file/folder tree and a read-only content viewer with a metadata inspector. Folder disclosure and folder selection are distinct; include expand/collapse all and path filtering that retains ancestors. Root and folder selections show useful counts/size and children, not blank panes. File selection shows escaped numbered text, safe image preview with dimensions, or an explicit binary/oversize fallback. Never execute project HTML/scripts in the source viewer.

Desktop defaults to Current local files and may inspect Latest saved and Published snapshots. Web exposes only cloud snapshots. Label the active source prominently and repeat it in Details; switching source changes both file catalog and content, retaining selection only if it exists. Metadata includes path, type, size, source, and relevant dimensions/line counts. Do not add edit/rename/move/delete/upload controls to this read-only viewer. Narrow layout stacks tree/viewer/details with bounded tree scrolling. Local inspection can remain available offline; unavailable cloud data must be explicit.

File-tree connectors use continuous 1px dashed vertical trunks and dashed horizontal branches, with square boxed disclosure buttons. Child trunks align under the parent disclosure center; each branch meets its row center; each trunk stops at the last direct child center. Remove leaf toggle spacers. Connectors paint above selection fills and below controls. Recompute geometry on expand/collapse, filtering, wrapping and resize; do not substitute solid indent borders.

Every history checkpoint row offers Browse files beside its A/B controls. This opens the complete saved file tree at that exact checkpoint, not the current local folder or latest cloud head. Show project + checkpoint prominently, preserve revision in navigation/deep links, and return to the same project history with A/B selection retained. Historical viewers are read-only on both desktop and web. Missing/unavailable checkpoints must not silently fall back to another snapshot.

Pull review, local-change review and local/remote conflict comparison are dedicated project pages, never diff dialogs. Desktop layout is changed-file navigation on the left and the selected file diff on the right; narrow layout stacks them and uses unified diff. Keep explicit source labels, per-file counts, stable review URLs and a return link to project detail. Pull and resolution actions belong to the review page; conflict replacement confirmation can expand inline. Web must not expose local review through a deep link.

## Smart merge

Conflict pages offer Use local, Use remote and Smart merge. Smart merge uses the last common checkpoint, local snapshot and remote saved checkpoint; automatically combine independent text changes, then show unresolved hunks and binary/tree conflicts explicitly. Keep the page-based review layout. Text conflicts support per-hunk choices and edited merged content; non-text conflicts need whole-path/tree choices. Validate the full result tree and require all conflicts resolved before applying. Missing base blocks smart merge with an explanation. Recheck freshness and retain local recovery; apply merged files locally only, leaving explicit push and publication separate. Never write unresolved conflict markers automatically.
