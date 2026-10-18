The task is to create an all-in-one CSS Modules extension for VSCode (and Cursor) that improves the Developer Experience.

We're going to get a lot of inspiration from

- https://github.com/mizdra/css-modules-kit
- https://github.com/mrmckeb/typescript-plugin-css-modules
- https://github.com/clinyong/vscode-css-modules

Features

- Autocomplete / class name suggestions when writing "styles.\_\_\_" in the markdown React file and go-to-definition (like in mizdra's extension)
- On-hover preview of the CSS rules of the particular "styles.\_\_\_" element ("composes" should resolve on preview with little "\*c" for rules coming from composes)
- Missing style class check for "styles.\_\_\_" coming from import
- Import order, closest styles file should be suggested first when typing "styles.\_\_\_"
- Similar to vunguyentuan.vscode-css-variables, autocomplete and missing-rule check for `var(--*)`. If possible, configure from settings some paths that always get included to resolve global variables (so everything vars and classes from e.g. apps/src/globals.css gets autocompleted). Also, any inline top @import file in css will add to the autocomplete. Make sure this doesn't fight with biome's "noUndeclaredCustomProperties"
- All paths should resolve with or without aliases (so relative with "...") or with aliases (e.g. like clinyong's extension does (look in tsconfig of the app -- important: make sure monorepos still work and use a setting for pathAliases like clinyong's extension does)
- Alert/highlight in CSS when trying to redefine a class name or variable already used in the global namespace
- Autocomplete, suggestions (for class names), go-to-definition and on-hover preview for the CSS "composes: name from ../path" rules (needs to work with importAliases as well, just like top-level imports)

Requirements

- Tests are required for every feature. Make sure the tests are simple and that they cover all usage scenarios.
- The extension has to work for both vscode and cursor, investigate how we can achieve that. `mizdra` says we should probably not rely on "VS Code Extension API."
- Every option should have settings that the user can enable/disable in `settings.json`, if possible under a `cssModulesDevTools` object. Some may extend already existing options from the other extensions (e.g. "css.customData", "cssVariables.lookupFiles", but document these and only use for the most popular existing extensions and their configs)
- Needs to work with TS7 and TS6, based on the selected workspace or project followed TS version
- Extension is to be used alongside biome so make sure everything is compatible

Notes

- If the extension starts requiring codegenerated files like `.d.ts` types, we're going to ask the user for an optional path to those files or suggest to wrap usage of https://github.com/Quramy/typed-css-modules (or propose a better alternative). I'd really like to avoid generated files if possible, so if there's any good way to do this through Next's existing build pipeline that'd be great. Please guide me through the choices here, if it becomes necessary.
- Check all the mentioned extensions and any of the other popular ones and say if any other popular features might be worth adding. For the mentioned extensions, check the opened PRs and issues, we want to make sure we address the most important ones with our extension.

---

In the README, using /unslop, we want to explain the features this extension has (we'll add gifs of what it looks like later on), the settings of the extension, a setup guide / getting started and a section where we can compare to other libraries or mention where each feature got the inspiration from, if it's not unique.
