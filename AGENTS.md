# AGENTS.md — pi-recheck-hook

## What this repo is

A private, dependency-free [pi](https://github.com/badlogic/pi-mono) extension package. It ships one
piece of code (`pi-extension/index.ts`) and two prompt files (`assets/*.md`). Nothing is compiled,
published, or served — `package.json` has `"private": true` and declares exactly one entry:

```json
"pi": { "extensions": ["./pi-extension/index.ts"] }
```

There is **no README, no CONTRIBUTING, no CI, and no formatter, linter, type-checker, or
test-runner configuration** in this repository. Do not search for `.eslintrc`, `tsconfig.json`,
`biome.json`, `.prettierrc`, or `.github/workflows` — none exist. Do not add build/publish tooling
without being asked.

## Repository map

| Path | Why it matters |
| --- | --- |
| `pi-extension/index.ts` | The entire implementation (two event hooks + asset resolver). |
| `assets/recheck.md`, `assets/anchor.md` | User-visible prompt text. Loaded at runtime by path, **not** inlined into code — editing prompts does not require touching `index.ts`. |
| `tests/index.test.ts` | Calls the handlers directly with synthesized events. |
| `package.json` | Only script is `test`. Only devDependency is `@types/node`. |

## Commands

Run everything from the repository root:

```bash
npm test        # runs: node --test   (the only script in package.json)
node --test tests/index.test.ts   # single-file run
```

Verified working on Node **v24.21.0** / npm 11.19.0. TypeScript files run via Node's native type
stripping (there is no build step and no `tsconfig.json`), so an older Node without native TS
support cannot run the tests or the extension.

## Non-obvious behavior

- **Tests need no running pi session.** `tests/index.test.ts` builds a fake `ExtensionAPI`
  (`makePi()`) and invokes handlers with hand-made events, so they pass without a real session.
  They also rewrite `process.env.HOME` (`withHome`) and clear `PI_RECHECK`,
  `PI_RECHECK_ASSETS_DIR`, and the four `PI_SUBAGENT_*` vars per test — run them in a clean env,
  and do not assume the real `~/.pi` is consulted while they run.
- **Assets are cached per cwd.** `resolveAssets()` memoizes results in a module-level
  `promptsByCwd` map. Changing an asset file after the first handler call for that cwd will not
  take effect within the same process.
- **Asset resolution order** (first hit wins, checked per file):
  1. `$PI_RECHECK_ASSETS_DIR` (if set)
  2. `<cwd>/.pi/pi-recheck-hook/assets`
  3. `~/.pi/agent/extension-data/pi-recheck-hook/assets`
  4. `<module>/../assets` (the bundled files in this repo)

  An unreadable file counts as missing and the chain continues; no hit at all → empty string →
  handler stays silent.
- **Hooks only fire in the right kind of project.** Both hooks bail unless the cwd contains
  `tasks/factory/00-obshchee.md` or `workshop/tasks/factory/00-obshchee.md`
  (`TASK_FILE_PATHS`). Running pi from a checkout of this repo will do nothing, and a new
  task-file layout that uses different paths must be added to `TASK_FILE_PATHS`.
- **Suppression flags are env-var driven:** `PI_RECHECK=0` disables the recheck hook;
  subagent sessions are skipped via any of `PI_SUBAGENT_SESSION|ID|NAME|AGENT`.
- **Test prompt assertions read the real files.** `bundledRecheck()` / `bundledAnchor()`
  `readFileSync` `assets/*.md`, so tests compare verbatim content rather than fixed expected
  strings — rewriting a prompt will not fail a test, but any logic change will.
- **Comments cite pi internals that are not in this repo** (e.g. `agent-session.js:2257`,
  `pi-extension/subagents/index.ts:1556-1582`). Those refer to pi's own distribution; do not
  hunt for them here.

## Boundaries

- `node_modules/`, `*.log`, `.DS_Store` are git-ignored (`.gitignore`); `.codegraph/` is a local
  index directory, not part of the source set — leave it alone.
- Keep `assets/*.md` English (they are English renderings of Russian originals per the header
  comment in `pi-extension/index.ts`), and keep the two prompt files in sync with the behavior
  descriptions in that file's header block.

## Done means

`npm test` passes from the repository root on Node 24, `package.json`'s `pi.extensions` still
points at `./pi-extension/index.ts`, and any change to hook logic is covered by a case in
`tests/index.test.ts` that drives the handler directly.
