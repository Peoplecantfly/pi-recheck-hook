# AGENTS.md — pi-recheck-hook

## What this repo is

A private, dependency-free [pi](https://github.com/badlogic/pi-mono) extension package. It ships one
piece of code (`pi-extension/index.ts`) and two prompt files (`assets/*.md`). Nothing is compiled,
published, or served — `package.json` has `"private": true` and declares exactly one entry:

```json
"pi": { "extensions": ["./pi-extension/index.ts"] }
```

There is **no CONTRIBUTING, no CI, and no formatter, linter, type-checker, or
test-runner configuration** in this repository (`README.md` exists but is hand-maintained prose —
keep it synced with `index.ts` behavior when behavior changes). Do not search for `.eslintrc`, `tsconfig.json`,
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
- **No asset cache (2026-10-16 rework).** `loadPrompt()` walks the asset chain on every call;
  there is no `promptsByCwd` memo anymore. Asset edits take effect on the next event.
- **Asset resolution order** (first non-blank hit wins, checked per file):
  1. `$PI_RECHECK_ASSETS_DIR` (if set)
  2. `<cwd>/.pi/pi-recheck-hook/assets`
  3. `~/.pi/agent/extension-data/pi-recheck-hook/assets`
  4. `<module>/../assets` (the bundled files in this repo)

  A missing, unreadable, **or blank** file counts as missing and the chain continues; no hit at
  all → empty string → handler stays silent.
- **State and rules are prompt-only.** State lives at `.pi/pi-recheck-hook/state.md`
  (one file per project cwd, shared by the main session and all subagents); project rules,
  when the user writes them, at `.pi/pi-recheck-hook/common.md` — the anchor prompt tells the
  model to re-read both at every compaction. These paths are named in prompt text only: the
  extension never reads, writes, lists, or checks them; both are optional. The injected text
  is the asset file verbatim — no `<session id>` substitution (2026-10-18 rework) — so a custom
  asset may point the state file and rules anywhere else; the bundled assets name the fixed
  paths above (what the verbatim tests pin). The model keeps the file itself and is told to
  re-read the file before writing and edit only its own `## <agent name>` section — that
  contains the read-modify-write race to a single section.
- **No auto-turn cap in pi 1.3.0 — the recheck loop brake is in the hook.** There is no
  `maxTurns`/`maxIterations` anywhere in the installed pi dist; `agent_before_settle` fires again
  after every auto-turn (`_runBeforeSettleBoundary`, `agent-session.js:1538`).
  `hasPendingRecheckCheck()` scans `event.context.contextEntries` backwards, skips `assistant`
  and `toolResult` messages, and stays silent when the first non-model message is a
  `custom_message` with `customType: "pi-recheck:recheck"` — a check of ours is already pending.
  Matching the asset's `[Recheck]` text would be dead code: no prompt contains it.
- **Entry/compaction ids do NOT dedupe anything (2026-10-16 rework).** There are no
  `checkedEntries`/`anchoredCompactions` Sets anymore: within one replay the projected context
  only grows, so entry ids keep changing and an id-keyed Set never fires. The pending-check
  guard is the only brake on the recheck.
- **Enablement is config-driven, default OFF (the task-file gate is gone).** Chain, first
  decisive answer wins: `$PI_RECHECK` (`"0"|"false"|"off"` → off, `"1"|"true"|"on"` → on,
  anything else → continue) → `<cwd>/.pi/pi-recheck-hook/settings.json` →
  `~/.pi/agent/extension-data/pi-recheck-hook/settings.json` → nothing → **disabled**. A
  settings file counts as present only when it parses to an object with a boolean `enabled`;
  bad JSON, `"yes"` strings, or empty objects are "absent" and the chain continues. The same
  chain carries an optional boolean `subagents` (default `true`): `false` silences both hooks
  in subagent/child sessions only (first boolean in the chain wins; non-boolean is absent),
  never the main session. Note: `/recheck on|off` merges `enabled` into the existing file, so
  `subagents` survives the rewrite. Running pi from a checkout of this repo does nothing until
  one of those switches is set.
- **Subagent detection is back, but only to apply `subagents: false` (2026-10-18).**
  Global suppression is `PI_RECHECK=0` (both hooks). Subagent sessions fire by default:
  in-process children (e.g. @tintinweb/pi-subagents) load the extension through their own
  session binding and process-spawned workers (e.g. pi-squad) run a full pi process. A session
  counts as subagent when any `PI_SUBAGENT_*` env var (`SESSION|ID|NAME|AGENT`) is set or
  `ctx.sessionManager.getHeader()` carries `parentSession` — that is the only effect of the
  markers: `settings.json` `"subagents": false` silences exactly those sessions.
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
