# CSS Modules editor tooling: competitive research

Date: 2026-10-18. Sources: GitHub API (`gh`), VS Code Marketplace API, Open VSX API, Biome source/docs, TypeScript/typescript-go PRs.

Target architecture under evaluation: standalone Node LSP, `.module.css` only, postcss parser, oxc-resolver for tsconfig paths, no TS plugin (TS7/tsgo can't load tsserver plugins).

---

## 0. Market snapshot

| Extension | Marketplace installs | Open VSX dl | Last release | Mechanism |
|---|---|---|---|---|
| clinyong.vscode-css-modules ("CSS Modules") | 1,173,735 | 35,197 | 0.5.4 (2025-05-11) | VS Code extension API, regex |
| vunguyentuan.vscode-css-variables | 211,987 | 27,294 | 2.8.3 (2025-12-19) | Standalone LSP (postcss) |
| iceworks-team.iceworks-style-helper ("React Style Helper") | 141,846 | – | 1.1.2 (2022-06-09, abandoned) | VS Code extension API |
| viijay-kr.react-ts-css ("React CSS modules") | 30,179 | 14,124 | 3.2.7 (2024-12-26, stale) | VS Code ext API + Babel + tiny TS plugin |
| mizdra.css-modules-kit-vscode | 925 | 5,095 | 1.4.0 (2026-07-09) | tsserver plugin via Volar |
| typescript-plugin-css-modules (npm, mrmckeb) | n/a (npm, 1.4k stars) | n/a | active | tsserver plugin |
| dangxuandev.typed-css-modules-plugin ("CSS Module Typed") | 8,932 | – | 2019 | dead |

Takeaway: the most-installed one (clinyong) is a regex-based autocomplete + go-to-def that hasn't moved in years. The only feature-rich options (css-modules-kit, react-ts-css, mrmckeb) all depend on a tsserver plugin and are broken or degraded on TS7.

---

## 1. mizdra/css-modules-kit (203 stars, very active)

**Mechanism**: `@css-modules-kit/ts-plugin` (tsserver plugin built on Volar.js) makes tsserver load `*.module.css` as virtual TS. Plus `codegen` (`cmk` CLI → `.module.css.d.ts`), `eslint-plugin`, `stylelint-plugin`. VS Code extension just registers the ts-plugin (`typescriptServerPlugins`, `languages: ["css"]`) and a tsconfig JSON schema.

**Usage patterns**
- Default import, any name (TS-native, since types are real). `cmkOptions.namedExports` switches to named exports; `prioritizeNamedImports` controls auto-import style.
- Namespace import (`import * as styles`) works in namedExports mode.
- Bracket access `styles['foo-bar']`: yes (names kept verbatim).
- **No camelCase conversion** (documented limitation: `.foo-bar` → only `styles['foo-bar']`).
- clsx/classnames: works implicitly (TS sees real types).

**Features**: go to definition, rename (cross TS↔CSS), find all references (both directions), definition preview on Cmd+hover, auto-update imports on CSS file move, "Create CSS Module file for current file" refactor, `className={...}` snippet instead of `className="..."`, prioritise the sibling module's `styles` in auto-import, quick fix "Add missing CSS rule", diagnostics for unknown class (via TS type errors). `@import` and `@value ... from` supported; `composes` handled (lint false-positive fixed in #255). Tokens: classes, `@keyframes` (`cmkOptions.animation`, default true), optional `--dashed-idents` (`cmkOptions.dashedIdents`) and container names (`cmkOptions.container`). Lint rules: `no-unused-class-names`, `no-missing-component-file`.
- `:global .foo` / `:local .foo` (non-function form) **not supported**; only `:global(.foo)` / `:local(.foo)`.
- No Sass/Less. No VS Code for Web.

**Path aliases**: `@import`/`@value from` specifiers resolved with TypeScript module resolution → `compilerOptions.paths`, package.json `imports` (subpath imports), `moduleSuffixes`, `customConditions` (e.g. `"style"`). Config inherits through tsconfig `extends`.

**Settings** (in tsconfig.json, not VS Code settings): `cmkOptions.enabled`, `dtsOutDir`, `arbitraryExtensions`, `namedExports`, `prioritizeNamedImports`, `animation` (`keyframes` deprecated), `dashedIdents`, `container`. Requires `rootDirs: [".", "generated"]` for codegen output.

**TS7 / tsgo status (confirmed)**: **Not supported today.** Issue #377 "Support Corsa (TypeScript 7+)" (most-reacted open issue). Workaround documented: stay on TS 6, uninstall TS Native Preview or set `typescript.experimental.useTsgo: false`. Work in progress via **content mappers** (see §7): PR #457 (skeleton) and PR #442 (full experimental transformer, private/unpublished package `@css-modules-kit/content-mapper`, targets `typescript@7.1.0-dev` nightlies). Known gaps in content-mapper mode (33/139 e2e tests expected-fail): `@value ... from` cross-file nav in default-export mode, completion customisation, code fixes, "Create CSS Module file" refactor — these need the TS7 LSP middleware (now merged upstream, §7). Also tsgo drops definitions that point to a mapped file itself, so go-to-def on `@import` specifiers returns nothing.

**`declare module '*.module.css'` duplication**: css-modules-kit sidesteps it because TS resolves `./x.module.css` to a real module (the Volar virtual file in-editor, or the generated `.d.ts` via `rootDirs` in CLI) — real resolution wins over a wildcard ambient module, so the ambient declaration never participates for typed lookups. Remaining open bug #169: "Updating import statements fails if `declare module '*.module.css'` exists" (file-move import update); maintainer: "I don't know how to [work around it]". Related #206: go-to-def on `@import` specifiers loses to VS Code's built-in CSS language server (documentLink takes priority).

**Top open issues/PRs**
- #377 Support Corsa (TypeScript 7+) — nothing works on TS7 yet.
- #442 (PR) experimental content mapper for TS7 — prototype, feedback vehicle for TS team.
- #457 (PR) content mapper skeleton (all CSS → empty module).
- #242 Add WebStorm plugin.
- #237 Errors reported in an untitled CSS file in VS Code.
- #169 Import update on file move fails when `declare module '*.module.css'` exists.
- #413 `--cache` for codegen.
- #453 `extends` array precedence wrong for `cmkOptions`.
- #450 Report diagnostic for URL specifier in `@value ... from`.
- #433 ts-plugin doesn't surface config diagnostics in the editor.

---

## 2. mrmckeb/typescript-plugin-css-modules (1,392 stars)

**Mechanism**: tsserver plugin that replaces the virtual `.d.ts` for each CSS module (renders via postcss/sass/less/stylus). Editor-only; no `tsc` support.

**Usage patterns**: default import any name; `namedExports: true` (default) adds named exports for valid identifiers; namespace import works; bracket access works (index-like typed object). camelCase via `classnameTransform`: `asIs` | `camelCase` | `camelCaseOnly` | `dashes` | `dashesOnly` (mirrors css-loader `localsConvention`). clsx works implicitly.

**Features**: completion + types, unknown-class errors (opt out via `allowUnknownClassnames`), experimental go to definition (`goToDefinition: true`; frequently lands on the wrong line, #247). **No** rename, no find references, no unused detection. Sass/Less/Stylus supported. `@value` missing from types (#261). `@import` not followed (#275).

**Path aliases**: no TS-paths resolution for CSS-side imports; Sass `loadPaths`, tilde importer for Sass; custom renderer for others. Node subpath imports unsupported (#263). npm packages exporting SCSS break (#282).

**Settings** (tsconfig `plugins[].options`): `additionalData`, `allowUnknownClassnames`, `classnameTransform`, `customMatcher` (default `\.module\.((c|le|sa|sc)ss|styl)$`), `customRenderer`, `customTemplate`, `goToDefinition`, `noUncheckedIndexedAccess`, `namedExports`, `dotenvOptions`, `postcssOptions` (`useConfig`, `excludePlugins`), `rendererOptions` (`less`, `sass`, `stylus`).

**TS7**: #301 "Does not work with Typescript 7" — maintainer: blocked until TS 7.1 APIs.

**Top open issues**
- #222 `composite: true` shows error in VS Code after v5 (41 engagement).
- #247 goToDefinition jumps to wrong place.
- #215 IntelliSense very slow with v5.
- #275 `@import` not supported.
- #263 Node.js subpath imports (`#…`) not supported.
- #282 Error with npm package exporting SCSS.
- #267 Global variables with Vite.
- #277 css-loader v7 support (named exports defaults changed).
- #261 `@value` missing from type.
- #281 TS2614 "has no exported member" confusion with named vs default.
- #301 TS7 unsupported.

---

## 3. clinyong/vscode-css-modules (1.17M installs)

**Mechanism**: plain VS Code `CompletionItemProvider` + `DefinitionProvider` for JS/TS/JSX/TSX/Astro. Class names extracted by **regex** (`/\.[_A-Za-z0-9-]+/` on lines ending with `{` or `,`), not a real parser.

**Usage patterns**
- Import detection regex: `\s<identifier>\s+(from|= require(`…`))["'](.+\.(\S{1,2}ss|stylus|styl))["']` → default import with any name, `import * as x` (the `as x from` part matches), and `const x = require(...)`. **Named imports not supported** (#20, 12 reactions).
- Bracket access: completion offers `['kebab-name']` items when typing `styles.` for kebab names; completion inside `styles['` not supported (#103).
- camelCase: `cssModules.camelCase`: `false` | `true` | `"dashes"` (css-loader style).
- clsx: works only because trigger is `ident.`.

**Features**: completion, go to definition. Nothing else: no hover, diagnostics, rename, references, unused, nesting (`&`) awareness (#31, top issue).

**Path aliases**: `cssModules.pathAlias` object (`{"@styles": "${workspaceFolder}/src/styles"}`) + reads `compilerOptions.paths` from root `tsconfig.json`/`jsconfig.json` of each workspace folder, **only if `baseUrl` is set** (strips `*`, joins with baseUrl). No `extends`, no nested/monorepo tsconfigs, cached per workspace folder. Hence #93 "Does not work with tsconfig paths on Next.js" (Next.js/TS5 configs often have `paths` without `baseUrl`).

**Settings**: `cssModules.camelCase`, `cssModules.pathAlias`.

**Top open issues**
- #31 Support for nested classes (`&`) — 19 reactions.
- #63 IntelliSense priority breaks Go to Definition — TS's result from `declare module '*.module.css'` (Next/Vite) wins/duplicates. VS Code team quoted: "The extension system is designed to be cooperative and so that a single extension cannot mute results of other extensions."
- #20 Support ES-module style (named) imports.
- #17 Warn on non-existent classes.
- #12 Rename refactoring.
- #11 `styleName="..."` (babel-plugin-react-css-modules).
- #79 / #93 Path alias autocomplete broken (Next.js).
- #65 Autocomplete for imports.
- #68 Class names shown after non-existent properties.
- #62 High CPU.

---

## 4. vunguyentuan/vscode-css-variables (212k installs)

**Mechanism**: standalone Node LSP (`css-variables-language-server`, postcss + postcss-scss + postcss-less, fast-glob, culori for colors). Closest architectural sibling to the planned extension.

**Features**: `var(--…)` completion with color swatch, color decorators (resolved through nested `var()` references), go to definition. No hover docs from comments (#101), no undefined-variable warning (#74), no find references (#62 says it even breaks Ctrl+click references).

**Settings**
- `cssVariables.lookupFiles` (array of fast-glob patterns). Default `["**/*.css","**/*.scss","**/*.sass","**/*.less"]`. Globbed with `cwd` = **each workspace folder root**, `absolute: true`. `${workspaceFolder}` is **not** interpolated (#71). To include a node_modules file, list it explicitly (`"node_modules/open-props/open-props.min.css"`) per README FAQ. Schema advertises a `{ when: "$(basename).ext" }` sibling check (VS Code `files.exclude` style).
- `cssVariables.blacklistFolders` (globs passed as fast-glob `ignore`). Default `.git .svn .hg CVS .DS_Store node_modules bower_components tmp dist tests` (all `**/`-prefixed).
- `cssVariables.languages` (language IDs where suggestions appear; default includes astro, svelte, vue, scss, postcss, less, css, html, js/ts/jsx/tsx, `source.css.styled`).
- `cssVariables.trace.server`.

**`@import` handling**: only **absolute `http(s)://` URLs** are fetched (axios) and parsed. Relative/package `@import`s are not followed; such files are only seen if they match `lookupFiles`. All variables are one global pool (no per-file scope/visibility).

**Top open issues/PRs**
- #20 Setting to define when to trigger the extension.
- #14 / PR #90 Inline color for nested CSS variables.
- #60 Vue: suggest only inside `<style>`.
- #95 OKLAB/OKLCH colors.
- #70 Insert name without `var()`.
- #74 Warn if not defined.
- #71 lookupFiles doesn't work per workspace folder.
- #62 Ctrl+click references break.
- #51 `lookupFilesOverwrite` setting.
- #101 Hover shows CSS comments.
- #119 Trailing semicolon removed on insert; #93 duplicate suggestions.

**Biome `noUndeclaredCustomProperties` interaction**
- Rule is `lint/nursery/noUndeclaredCustomProperties`, since Biome v2.5.11, default severity *information*, **project domain** (enables Biome's scanner/module graph).
- Visibility = declarations in the same file, `@property`, **imported stylesheets** (CSS `@import`), linked stylesheets, HTML-like `<style>` blocks; "global styles can provide custom properties to imported child components" (JS import graph). "Files that aren't imported by the project aren't analyzed."
- **Options struct is empty** (`NoUndeclaredCustomPropertiesOptions {}`, `deny_unknown_fields`) — there is **no globals/allowlist option**. Only escape hatches: `biome-ignore` comments, `overrides` to disable per path, or making the declaring file reachable via the import graph.
- There is no coupling with vscode-css-variables: that extension's `lookupFiles` pool is global and has nothing to do with Biome's import-graph visibility. A variable can autocomplete fine and still be flagged by Biome (e.g. tokens injected at runtime, or defined in a CSS file only linked from HTML/layout outside Biome's graph). If our extension adds an "undefined variable" diagnostic, aligning with Biome's import-graph semantics (or deferring to Biome) avoids two contradictory sources of truth.
- Alternative extension worth knowing: `Toaock.vscode-css-custom-properties` (~672k Open VSX downloads).

---

## 5. Viijay-Kr/react-ts-css ("React CSS modules", 30k installs, stale since 2024-12)

**Mechanism**: VS Code extension API providers + Babel parser for TS/JSX + own CSS parsing; ships a tiny tsserver plugin `typescript-cleanup-definitions` purely to strip the ambient-module definition.

**Usage patterns**: **default import only** (any name) via `ImportDefaultSpecifier`; named and namespace imports ignored. Member access `styles.x` and `styles['x']` (string literal) tracked. Casing: matches snake_case, PascalCase, camelCase, kebab-case selectors; **no kebab→camel transform** (#192 open). clsx works (any MemberExpression).

**Features (most complete VS Code-API one)**: definition, hover (peek CSS block), completion, auto-import of nearest module on completion, diagnostics for missing selector + missing module, unused-selector hints in CSS, code actions (fix typo, add missing selector, ignore warning), rename from CSS, references from CSS, code lens (off by default), CSS var completion/definition/color across files. SCSS suffix selectors (`&-foo`), Less, mixins. Global/Tailwind classes cause false "unused" (#176), no `:global` support (#106).

**Path aliases**: scans `**/*/tsconfig.json` and root `tsconfig.json`; alias match regex `^@\w+` only (so `~/`, `#/`, `$lib` don't work); uses only `paths[key][0]`; `reactTsScss.baseDir` (default `src`) + `baseUrl`. No `extends`. Hence #109 "Module not found" (15 engagement) and fix PR #189.

**Settings**: `reactTsScss.peekProperties`, `autoComplete`, `autoImport`, `definition`, `references`, `diagnostics`, `tsconfig` (README only), `baseDir`, `cssAutoComplete`, `cssDefinitions`, `cssSyntaxColor`, `tsCleanUpDefs`, `cleanUpDefs` (glob list, default `*.module.{css,scss,sass,less,styl}`), `codelens`, `renameSelector`.

**Top open issues/PRs**
- #68 Multiple entries on Go to Definition (14 comments) — the ambient-module duplicate; fixed via TS plugin, but regresses (#180 reopened variant).
- #109 Module not found (alias resolution).
- #91 Remove node_modules from published extension (size).
- #188 / #190 400% CPU / high CPU.
- #179 / PR #195 Chained class selectors (`.a.b`).
- #176 Tailwind/global classes falsely reported unused.
- #194 Support TypeScript 7 — extension gets **disabled** when TS Native Preview is installed.
- #193 Wrong references.
- #192 kebab→camelCase transform for completions/diagnostics.
- #106 Global CSS class support.

---

## 6. iceworks-team "React Style Helper" (142k installs, abandoned 2022)

Completion for `className` from imported style files, hover preview of declarations and Sass variables, go to definition, inline-style completion in JSX, auto-import of CSS Modules file. Repo `apptools-lab/appworks/extensions/style-helper`. No settings of note; dead project.

---

## 7. Can VS Code dedupe TS's definition pointing at `declare module '*.module.css'`?

**Honest answer, by TS version:**

1. **Plain VS Code API: no.** Definition results from all providers are merged; one extension cannot remove another's. VS Code team position (quoted in clinyong #63): "The extension system is designed to be cooperative and so that a single extension cannot mute results of other extensions. We have no plans of changing that." `editor.gotoLocation.multipleDefinitions: "goto"` only jumps to the first result; ordering across providers isn't controllable, so it is not a fix.

2. **TS ≤ 6 (Strada tsserver): only via a tsserver plugin** that proxies `getDefinitionAndBoundSpan` and drops results whose declaration file matches the ambient pattern. Prior art: `typescript-cleanup-definitions` (react-ts-css), `zardoy/typescript-vscode-plugins` (`miscDefinitionImprovement`). A small optional plugin contributed via `typescriptServerPlugins` would still work for TS ≤6 users even if the main product is an LSP.

3. **TS 7 (tsgo) via the TypeScript VS Code extension: YES, as of Oct 2026.** microsoft/TypeScript PR #64583 (merged 2026-10-02, closes #63800) "Allow other VS Code extensions to install LSP middleware on language feature responses". API:
   ```ts
   const ext = vscode.extensions.getExtension<ExtensionAPI>("TypeScriptTeam.native-preview");
   const api = await ext.activate();
   api.registerLspMiddleware("textDocument/definition", (result, { params }) => filtered);
   ```
   Types from `typescript/unstable/vscode`. Supported methods include `textDocument/definition`, `typeDefinition`, `references`, `hover`, `completion`, `rename`, `codeAction`, `diagnostic`, `custom/textDocument/sourceDefinition`, etc. Caveats: "unstable" namespace; callbacks run in registration order with no cross-extension ordering guarantee; errors fall back to the original response; extension ID may change when TS7 becomes the bundled extension; **`TypeScriptTeam.native-preview` is not on Open VSX** (so Cursor availability must be verified).

4. **Avoid the duplicate structurally (works on any TS version, no plugin):** if a real per-file declaration exists, TS resolves `./x.module.css` to it and the wildcard ambient module is never used. Options: generated `x.module.css.d.ts` via `rootDirs` (css-modules-kit codegen) or `x.module.d.css.ts` with `allowArbitraryExtensions`, plus a `.d.ts.map` declaration map so TS's own go-to-def lands in the CSS (happy-css-modules approach). tsgo follows declaration maps for go-to-def (typescript-go #4829 fixed a multi-source declaration-map definition bug), but verify. Cost: generated files / tsconfig edits. Cheap user-side hack from clinyong #63: override the ambient type to `any`.

5. **TS7 content mappers** (typescript-go #4712 merged 2026-08-19, TypeScript #63936 merged 2026-08-21; ships in `typescript@7.1.0-dev`): a `contentMappers` entry in tsconfig (or registration from a VS Code extension via `registerContentMappers`, inferred projects only) spawns an external process over JSON-RPC that turns `.module.css` into TS with span mappings. TS then natively resolves the CSS file (bypassing the wildcard), and its definition/references/rename map back into the CSS. Requires `--runExternalCode` (trusted workspace only in VS Code) and, for configured projects, a tsconfig change. This is the path css-modules-kit is taking.

---

## 8. Cross-project pain points (ranked by evidence)

1. **Go-to-definition hijacked/duplicated by `declare module '*.module.css'`** (Next/Vite) — clinyong #63, react-ts-css #68/#180, mrmckeb #247, cmk #169.
2. **Path alias resolution broken** — clinyong #79/#93 (requires `baseUrl`), react-ts-css #109 (`^@\w+` only), mrmckeb #263 (subpath imports), #282 (package exports). No project except cmk handles `extends`, subpath imports, `customConditions`, monorepo nested tsconfigs well.
3. **TS7 breakage** — every TS-plugin-based tool (cmk #377, mrmckeb #301, react-ts-css #194).
4. **Performance/CPU** — mrmckeb #215, clinyong #62, react-ts-css #188/#190.
5. **Parser accuracy** — nesting `&` (clinyong #31, top issue), chained selectors (react-ts-css #179), `@import`/`@value` (mrmckeb #275/#261), `:global`/Tailwind false positives (react-ts-css #176/#106).
6. **Import styles** — named imports (clinyong #20), camelCase transform (react-ts-css #192; cmk refuses it).
7. **Diagnostics for unknown classes / rename / references** — clinyong #17/#12 (top-5 requests), only cmk and react-ts-css deliver.
8. **CSS-language-server conflicts in `.module.css`** — cmk #206 (built-in CSS LS documentLink wins for `@import` specifiers); vscode-css-variables #62 (breaks Ctrl+click refs).

## 9. Feature gaps worth adding (none of the LSP-based options has all of these)

- Definition dedupe on TS7 via `registerLspMiddleware("textDocument/definition")` (+ optional tiny tsserver plugin for TS ≤6).
- Full TS-faithful resolution via oxc-resolver: `paths` without `baseUrl`, `extends` chains (incl. package extends), package.json `imports` (`#styles/*`), `exports` with `style` condition, nearest-tsconfig per file in monorepos, project references.
- Import forms: default (any name), namespace, named (`import { foo }`), `require`, dynamic `import()`; bracket access completion inside `styles['`; camelCase/dashes modes matching css-loader `exportLocalsConvention` (`as-is`, `camel-case`, `camel-case-only`, `dashes`, `dashes-only`) — ideally auto-detected from bundler config, else a setting.
- Diagnostics: unknown class (with "did you mean" + "add rule" quick fix), unused class in the CSS file (respecting `:global`, `composes`, dynamic `styles[var]` → suppress), missing module.
- Rename + references across TS↔CSS from both sides; code lens for reference counts.
- Hover showing the rule block (react-ts-css's most-liked feature) incl. `composes` chain expansion.
- `composes: a b from './x.module.css'` navigation/completion; `@value` definitions; `:global(...)`, `:global .x` block form, `:local`, nesting `&`, `@keyframes`/`animation-name` local tokens.
- "Create sibling module" and auto-import of sibling module on `styles.` completion.
- CSS custom properties are a separate product (vscode-css-variables); if added, align "undeclared" logic with Biome's import-graph semantics or leave to Biome.

## 10. Things that contradict or pressure the stated architecture

1. **"TS7 can't load TS plugins" is true, but TS7 now has two official extension points** (both merged Aug–Oct 2026, in 7.1-dev/nightlies):
   - **LSP middleware** (`registerLspMiddleware`) — lets our *VS Code client* filter/modify TS responses. This solves the ambient-module duplicate directly. The standalone LSP architecture is compatible with it; it just needs a small client-side hook.
   - **Content mappers** — the "TS7-native" way to give TS real knowledge of `.module.css` (types, definition, references, rename, `tsc` type-check without codegen). css-modules-kit is already prototyping this. A standalone LSP duplicates work TS could do (references/rename on the TS side), and can't make `tsc`/TS hover types precise. Worth deciding explicitly: LSP-only, or LSP + content mapper (the transformer logic — postcss → token list with spans — could be shared).
2. **Rename/references from the TS side** cannot be fully owned by an external LSP: TS will still answer rename/references for `styles.foo` (on the ambient `{[key:string]:string}` type it returns nothing useful / may refuse rename). Without middleware or a content mapper, F2 on `styles.foo` in a TSX file will be TS's rename, not ours. Plan for middleware on `textDocument/rename`/`prepareRename`/`references`, or accept rename only from the CSS side.
3. **Type precision**: an external LSP can't change `styles`' TS type; unknown classes won't be TS errors, and hover over `styles.foo` shows `string` from the ambient type. Diagnostics must come from our LSP (fine), but CI type-safety requires codegen or content mapper.
4. **Built-in CSS language server conflicts in `.module.css`** (cmk #206): completion/definition/documentLink in CSS files are shared with VS Code's CSS LS; our results merge rather than replace.
5. **Cursor**: TS Native Preview isn't on Open VSX; the middleware path may not be available to Cursor users. The LSP-only baseline must stand on its own.
6. **`.module.css` only** excludes Sass users — mrmckeb and react-ts-css issues show a large SCSS user base. Fine as a scoping choice, but postcss-scss could cheaply extend coverage later.
