# Changelog

## 0.0.4

- Works with PostCSS Language Support, which opens `.css` files in its own `postcss` language mode. Those files used to get no completion, hover, swatches or diagnostics, and with only a stylesheet open the extension didn't activate at all.
- README: new "Disable potentially conflicting extensions" section under Getting started → Advanced.

## 0.0.3

- Out of preview: VS Code and the Marketplace no longer show the Preview badge next to the extension.
- Fixed the a warning in JSON configuration files caused by `diagnostics` and `$ref`

## 0.0.2

- Cosmetic updates to the README.

## 0.0.1

Initial preview release.

- Class completion for `styles.`, `styles['`, namespace and named imports, and `require()`, following `classNameConvention`.
- Go to definition and hover previews for classes, with `@media`/`@supports` wrappers and the composed classes' rules listed below.
- `missingClass` and `missingFile` diagnostics for TS/JS imports, `composes … from` and `@import`, with "Did you mean" and "Add class" quick fixes.
- Auto-import of nearby CSS modules when typing an unimported `styles.` (identifiers configurable).
- `composes` completion, definition and hover for local classes, other files, aliases, packages and `from global`.
- CSS custom data for `composes`, `:global` and `:local`, so the built-in CSS checker stops reporting `composes` as an unknown property.
- `var(--*)` completion, definition and hover in CSS and in TS/JS strings, following `@import` chains and `globalFiles`.
- Color swatches on `var()` usages that resolve to a color.
- `varShadowsGlobal`, `globalClassCollision` and `localShadowsGlobal` checks against global stylesheets.
- Path resolution through `pathAlias`, tsconfig/jsconfig `paths`, package.json `imports`/`exports` and node_modules.
- Stands down for TS/JS class features when css-modules-kit is active on TypeScript < 7.
