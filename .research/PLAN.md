# PLAN — CSS Modules DevTools

VS Code + Cursor extension for CSS Modules. Source: [PRD.md](./PRD.md). Research: [RESEARCH.md](./RESEARCH.md), competitor/issue survey (css-modules-kit, typescript-plugin-css-modules, clinyong/vscode-css-modules, vscode-css-variables, react-ts-css).

## 1. Decisions (locked)

| Area | Decision |
|---|---|
| Architecture | Standalone LSP server + thin VS Code client. No TS plugin, no TS7 middleware. |
| TS compat | LSP never loads `typescript` → identical on TS 5/6/7. Duplicate F12 (Next's `declare module '*.module.css'`) accepted. |
| TS 5/6 + css-modules-kit | Auto-detect cmk → our TSX features stand down (cmk owns them). |
| Stylesheets | `.module.css` + plain `.css` only. No SCSS/Less. |
| Parsers | TSX/JSX/TS/JS: `@babel/parser` (`errorRecovery`, `typescript`+`jsx`). CSS: `postcss` + `postcss-safe-parser` + `postcss-selector-parser`. |
| Resolution | `get-tsconfig` (nearest tsconfig/jsconfig per file, `extends`, `paths`) + `enhanced-resolve` (package `imports`/`exports`, node_modules). |
| Packaging | Pure JS, one universal VSIX, esbuild → CJS. Marketplace + Open VSX. |
| Repo | Bun workspace, 3 packages: `core`, `server`, `client`. |
| Tests | `bun test`, fixture projects; core unit + in-process LSP tests; 1 test-electron smoke. |
| Var diagnostics | No missing-var check (delegated to Biome `noUndeclaredCustomProperties`). Only `varShadowsGlobal`. |
| Naming | `classNameConvention` setting, css-loader modes, default `asIs`. |

## 2. Architecture

```
packages/
  core/     pure: parse, index, resolve, query. No vscode / LSP imports.
  server/   vscode-languageserver handlers → core queries.
  client/   activation, settings bridge, coexistence/cmk detection, file watcher, e2e suite (test-e2e/).
fixtures/   next-app, monorepo (2 apps, conflicting @/), aliases, shared-paths, inherited-paths (extended tsconfig paths),
            globals, variables, auto-import, cmk-ts6, demo (GIF workspace), e2e-css (CSS-side e2e)
scripts/    build.ts (esbuild), e2e.mjs (test-electron, VS Code 1.85), demos/ (one Playwright scene per feature → docs/gifs/*.gif)
```

### core
- `css/parse.ts` — postcss safe-parse → `CssModuleInfo`:
  - `classes: Map<name, ClassDef[]>` (selector span, owning rule, `@media`/`@supports` wrappers, nesting resolved incl. `&`).
  - `composes: { names[], from: string | "global" | null, span }[]`.
  - `globals: :global(.x)` classes (function form + bare `:global .x`).
  - `varDecls: { name, value, span, depth }[]` (rule nesting depth, at-rules excluded); `varUses`.
  - `imports: @import specifiers`.
  - Only local classes are exported keys; `:global` excluded.
- `css/convention.ts` — `asIs | camelCase | camelCaseOnly | dashes | dashesOnly` → exported key ↔ class name.
- `tsx/analyze.ts` — babel parse → CSS-module imports (default, namespace, named, `const x = require('./a.module.css')`) → usages (`X.foo`, `X['foo']`, named identifiers) with spans. Skip dynamic `X[expr]`.
- `cursor.ts` — text scan at cursor for completion (`ident.partial`, `ident['partial`, `var(--partial` in strings). Needed because half-typed code breaks the AST; binding map comes from the last good parse.
- `resolve.ts` — order: `cssModulesDevTools.pathAlias` → nearest tsconfig `paths` → package.json `imports` → relative → node_modules (`style` condition). Works for TSX imports, `composes from`, `@import`.
- `project.ts` — `Project`, the per-server cache and query surface (planned as separate index/vars/graph modules, merged in practice):
  - index: lazy `path → info` cache for CSS and TSX. Parse only on demand: open docs, their imported CSS, transitive `@import`/`composes`, `globalFiles`. No startup scan. `invalidate(file)` / `filesChanged(paths?)` drop only what changed.
  - graph: `@import` walker shared by vars/globals: DFS with visited set (cycle-safe, `a → b → a` stops), depth cap 20, unresolvable/URL imports skipped. node_modules targets followed only when `nodeModules.enabled`.
  - vars: known vars for a file = own + transitive `@import` + `globalFiles` (per package root), memoized per file.
- `walk.ts` — bounded `*.module.css` directory walk (skips node_modules, dot-dirs, nested packages; per-root budget), exposed as `Project.moduleFiles` for auto-import and `composes` path completion.
- `packages.ts` — package.json `imports` patterns, style `exports` of packages, `findUp`.
- `text.ts` — `LineIndex` (offset ↔ position), `types.ts` — shared shapes and default settings, `index.ts` — barrel.
- `color.ts` — resolve `var(--x)` to a color through nested `var()` chains (cycle-safe) + fallback values; parse with `culori`.
- `composes.ts` — recursive resolution, cycle-safe, depth ≤ 5.

### server
`server.ts` (connection, open files, watched-file invalidation, debounced diagnostic refresh) → `router.ts` (dispatch by file kind) → `features/*.ts` (classes, composes, variables, colors, missing, globals, autoImport). `context.ts` holds per-request settings/environment, `lsp.ts` the LSP conversions.
Handlers: completion, definition, hover, diagnostics (pull model), codeAction, documentColor. Debounce TSX re-parse (~150 ms). Invalidate via `didChange` + `workspace/didChangeWatchedFiles` (`**/*.css`, `**/tsconfig*.json`, `**/package.json`).

### client
- Starts server (IPC). Activation: `onLanguage:css|typescriptreact|typescript|javascriptreact|javascript`.
- Passes settings incl. fallbacks + `typescript.preferences.importModuleSpecifier`.
- Coexistence: if `clinyong.vscode-css-modules` or `vunguyentuan.vscode-css-variables` installed → one-time notice (button: open extension). Fallback reads only when user explicitly set them (`inspect()`), so cssVariables' broad default globs are never inherited.
- cmk detection (`tsx.enabled: "auto"`): cmk mode ⇔ (`@css-modules-kit/ts-plugin` in nearest tsconfig `compilerOptions.plugins` OR `mizdra.css-modules-kit-vscode` installed) AND TS < 7. Workspace counts as TS7 if `typescript.experimental.useTsgo` is on OR the nearest `node_modules/typescript/package.json` major ≥ 7 (covers both today's Native Preview and a future stable `typescript@7`). Only affects cmk hand-off; our features work on every TS version.

## 3. Features + definition of done

Each feature: listed behaviour works on fixtures, tests cover every bullet, works with relative + alias + monorepo paths.

### F1 Class completion (TSX)
- `styles.` / `styles['` → exported keys of the imported module, converted per convention; kebab keys insert bracket form when after `.`.
- Any default-import name, namespace import members, named-import specifiers `import { | } from './x.module.css'`, CommonJS `const x = require('./x.module.css')` (from clinyong).
- Item detail: file + first declaration line.

### F2 Go-to-definition (TSX)
- `styles.foo`, `styles['foo']`, named import → every selector span containing `.foo` in that module.

### F3 Hover (TSX)
- All rules containing `.foo`, source order, with pseudo/`@media` wrappers, as css code block.
- `composes` resolved recursively; the `composes` row is replaced by the inherited declarations, each ending with `/* composed */`. Footer: "Composed from <file link>".
- Collapse after `hover.maxLines` (30) + "Go to definition" link.

### F4 Missing class diagnostic
- TSX: unknown key on CSS-module binding → `missingClass` (default error). Dynamic access ignored.
- CSS: unknown name in `composes: x from './y'` → same rule.
- `missingFile` (default error): import / `require` / `composes from` / `@import` whose `.module.css` path doesn't resolve (TS stays silent — the wildcard `declare module` swallows it).
- Quick fixes: "Did you mean `.x`?" (edit distance ≤ 2, top 3); "Add `.foo {}` to <file>" (append to module).

### F5 Auto-import on `styles.`
- Unbound `styles.` → items from nearby `*.module.css`, ranked: same-basename sibling → same dir → ancestors; within nearest package.json boundary; ≤ 10 candidates.
- Accept → inserts import after last import; specifier style per `typescript.preferences.importModuleSpecifier`.
- Pre-step: confirm stock VS Code/TS doesn't already offer this (expected: it doesn't, wildcard ambient modules aren't auto-import sources). If it does → drop F5.

### F6 `composes`
- Completion: before `from` → local classes; after `from '<path>'` → target's classes; `from global` supported. Path completion for `.module.css` with aliases.
- Definition on name → target class; on path → file. Hover on name → that class's rules.

### F7 CSS variables
- Completion of `var(--` in `.module.css`, plain `.css`, and TSX strings (`style={{…}}`, template literals). Value shown in detail.
- In `.css` files, exclude vars declared in the current file (built-in CSS LS already offers them → no duplicates).
- Definition + hover on `var(--x)` → declaration(s) + value + file.
- Settings `globalFiles` (globs, per package root). Each global file is parsed and its `@import`s followed recursively (e.g. `globals.css → tokens.css → colors.css`), cycle-safe via `graph.ts`; all reached vars/classes count as global.
- node_modules: `@import 'open-props/style'` or globs into `node_modules` only resolved/indexed when `nodeModules.enabled` (default off) — avoids scanning large packages by accident. `composes from 'pkg/x.module.css'` class resolution unaffected.

### F7b Color swatches (from vscode-css-variables)
- `textDocument/documentColor` on `var(--x)` usages in `.css`, `.module.css`, TSX strings → swatch with resolved color (through nested vars + fallbacks).
- Swatch is read-only: `colorPresentation` returns nothing, so the picker never rewrites a `var()` reference. Editing the color = edit the declaration (where built-in CSS LS already offers a picker).
- Unresolvable / non-color values → no swatch. Formats: hex, rgb(a), hsl(a), hwb, lab/lch, oklab/oklch, named colors.
- Skip literal colors in `.css` files (built-in CSS LS already shows those → no duplicates).

### F8 Global namespace checks (CSS)
- `varShadowsGlobal` (warning): `--x` declared in a file already declared in `globalFiles` / its `@import` graph.
  - `varShadow.maxDepth` (default `0`): only flag declarations whose rule nesting depth ≤ maxDepth. Depth 0 = top-level rule of the file (`.card { --x }`, `:global(:root) { --x }`); depth 1 = nested once (`.card { &:hover { --x } }`). `-1` = any depth.
  - At-rule wrappers (`@media`, `@supports`, `@layer`, `@container`) don't add depth; selector complexity (`.a .b`) doesn't either.
  - Redeclarations inside `globalFiles` themselves exempt (theme overrides).
  - Related info → original declaration.
- `globalClassCollision` (warning): `:global(.x)` in module vs class in `globalFiles` + already-indexed modules only (no workspace scan in v1).
- `localShadowsGlobal` (off): local `.btn` when `globalFiles` defines `.btn`.

### F9 Table stakes
- Native nesting (`&`, `&-suffix` is not valid native CSS → ignore), `:global`/`:local` both forms, `@media`/`@supports`/`@layer`/`@container` wrappers, keyframes not exported as classes (v1).

## 4. Settings (`cssModulesDevTools.*`)

| Key | Type / default | Notes |
|---|---|---|
| `tsx.enabled` | `"auto" \| "on" \| "off"` = `auto` | auto = off when cmk active on TS < 7 |
| `completion.enabled` | bool = true | classes + composes |
| `definition.enabled` | bool = true | |
| `hover.enabled` | bool = true | |
| `hover.maxLines` | number = 30 | |
| `autoImport.enabled` | bool = true | path style from `typescript.preferences.importModuleSpecifier` |
| `autoImport.identifiers` | `string[]` = `["styles","classes","css","s"]` | only these unbound `name.` trigger auto-import; `[]` disables |
| `variables.enabled` | bool = true | var completion/definition/hover |
| `variables.tsxStrings` | bool = true | |
| `variables.colors` | bool = true | swatches on `var()` usages |
| `nodeModules.enabled` | bool = false | follow `@import`/`globalFiles` into node_modules |
| `classNameConvention` | enum = `asIs` | mirrors css-loader `exportLocalsConvention` |
| `pathAlias` | `Record<string,string>` = {} | `${workspaceFolder}`, `${packageRoot}`; fallback `cssModules.pathAlias` |
| `globalFiles` | `string[]` = [] | globs per package root; fallback `cssVariables.lookupFiles` (only if user-set) |
| `varShadow.maxDepth` | number = 0 | rule nesting depth; `-1` = any |
| `diagnostics` | object | `missingClass: error`, `missingFile: error`, `varShadowsGlobal: warning`, `globalClassCollision: warning`, `localShadowsGlobal: off`; each `off\|hint\|info\|warning\|error` |

Flat keys (not one big object) except `diagnostics`, so the Settings UI renders them.

## 5. Milestones

1. **M0 scaffold** — bun workspace, biome, tsconfig, esbuild, `bun test`, fixtures skeleton, CI (lint + test).
2. **M1 core** — CSS parse (nesting, :global, composes, vars), convention, resolver (all alias cases + monorepo), index cache.
3. **M2 TSX** — analyze + cursor scan; F1, F2, F3, F4 (+ quick fixes).
4. **M3 composes** — F6.
5. **M4 vars** — F7.
6. **M5 global checks** — F8.
7. **M6 auto-import** — verify-not-native, then F5.
8. **M7 client** — settings bridge, fallbacks, coexistence notice, cmk detection, smoke test.
9. **M8 release** — `vsce` + `ovsx` publish on tag, Cursor manual QA.
10. **M8.5 demo GIFs** — scripted, reproducible, one per feature (F1–F8):
    - Playwright `_electron.launch` on the VS Code 1.85 build that `@vscode/test-electron` downloads into `.vscode-test/` (real Node extension host), with `--extensionDevelopmentPath` + a scratch copy of `fixtures/demo`. (`code serve-web` was dropped: Electron gives a native window without browser chrome.)
    - Minimal view via isolated user-data-dir settings: activity bar hidden, side bar/panel closed, status bar off, minimap off, breadcrumbs off, single tab, command center/layout controls off, `startupEditor: none`, fixed theme (Dark Modern), font size, 1200×700 window.
    - One scene per demo in `scripts/demos/`: open file → type/hover/F12/quick fix with fixed delays. Frames come from the DevTools screencast (lossless PNG, repaint-driven), not `recordVideo` (lossy VP8 defeats GIF frame diffing).
    - `ffmpeg` palettegen/paletteuse → `docs/gifs/<feature>.gif` (≤ 1.5 MB each, ~12 fps).
    - `bun run demos [name…]` regenerates all or some; frames spot-checked before commit. Requires `ffmpeg` locally. Keyboard shortcuts assume macOS.
    - VS Code only; Cursor not scriptable this way.
11. **M9 README** — via /unslop: features (GIFs from M8.5), settings, getting started, comparison/inspiration table, "Works well with" (Biome `noUndeclaredCustomProperties`, css-modules-kit for TS 5/6).

12. **M10 audit** — run `/improve` on the finished codebase; triage its plans with the user.

## 6. Perf budget (DoD)
- No workspace-wide scan at startup.
- Server idle RSS < 80 MB on `fixtures/monorepo`.
- Completion/hover p95 < 50 ms after warm cache; TSX re-parse debounced.

## 7. Out of scope (v1) → roadmap
- TS7 content mapper (rename, references, `tsc` checks w/o codegen) — after TS 7.1 stable; reuses `core`.
- TS7 LSP middleware (clean F12, TSX rename) — superseded by content mapper.
- On request: SCSS + Less modules (postcss-scss / postcss-less adapter), Stylus.
- On request: more host languages — Vue SFC, Svelte, Astro, HTML (`<style>` + class/var completion), styled-components templates.
- `@value`, unused-class hint, find-references from CSS, "create module for file", bundler config auto-detect, missing-var diagnostic, Tailwind arbitrary values.

## 8. Manifest
All items resolved and shipped in `packages/client/package.json`.
- ✅ `name: css-modules-devtools`, `displayName: CSS Modules DevTools`, `publisher: razgraf` (as in razgraf/react-on-the-fly). Extension ID `razgraf.css-modules-devtools`.
- ✅ License: MIT.
- ✅ `engines.vscode: ^1.85.0` (Nov 2023) — every Cursor release since early 2024 is based on a newer VS Code, and it covers `vscode-languageclient@9` (needs ≥ 1.82) + pull diagnostics. `@types/vscode` pinned to `1.85.0` so we can't use newer APIs by accident. No `engines.node`; CI and releases build on Node 22 (`.nvmrc`).
- ✅ `preview: true`, `homepage`, `galleryBanner` (dark, matches the icon background), CHANGELOG copied in by `scripts/build.ts`.
- ✅ `capabilities`: `untrustedWorkspaces: limited` (workspace values of `globalFiles`, `pathAlias`, `nodeModules.enabled` ignored until trusted), `virtualWorkspaces: false` (the server reads the file system directly).
- ✅ Release: tag `vX.Y.Z` → e2e → Marketplace + Open VSX (`--skip-duplicate`) → GitHub release. See `RELEASING.md`.

## 9. Resolved questions
1. `globalClassCollision` → `globalFiles` + already-indexed modules (no scan).
2. `missingFile` diagnostic → added (F4).
3. TS7 detection → only matters for cmk hand-off; rule in §2 client.
4. Name/publisher → §8.
5. `engines.vscode` → §8.
6. Composes marker → `/* composed */` replacing the `composes` row (F3; user decision after the `*c` trial).
