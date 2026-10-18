# pi-recheck-hook

Two behavioural hooks for [pi](https://github.com/badlogic/pi-mono), ported from the workshop
OpenCode plugin "Huki". They fight two failure modes: an agent that ends a turn having answered
from memory instead of from the code, and an agent that keeps working from a compaction summary
instead of from its state file.

Private, dependency-free pi extension package — `"private": true`, no runtime dependencies
(only `@types/node` as a devDependency), nothing compiled or published.

## What it does

### 1. End-of-turn recheck

When the agent has finished a turn and waits for a human, the extension injects the prompt from
`assets/recheck.md` and requests one continuation, so the agent re-checks its own answer against
verifiable facts ("every claim about code has a path:line you opened this turn", "every *no tests
found* is backed by a search you ran", "numbers copied from output, not memory").

Fires at the `agent_before_settle` boundary — the final actionable event, the only one that can
still append an entry and ask for another model request. `turn_end` fires per turn inside a run and
`agent_settled` is notification-only, so neither is used.

Suppressed when: `PI_RECHECK` is `0`/`false`/`off`; the hook is not enabled (see Scope — default
is OFF); in subagent/child sessions, when `settings.json` carries `"subagents": false` (the main
session is unaffected); no non-blank prompt file exists in the asset chain; the last entry is a `compaction` or
`branch_summary`; the outcome was `aborted` or `error`; the turn did not end with an assistant
message that claimed something (text or toolCall); or our own `recheck.md` is already the latest
non-model message in the context (`customType: "pi-recheck:recheck"`) — pi 1.3.0 has no auto-turn
cap, so that pending-check guard is what keeps the hook from re-injecting forever. There is no
`[Recheck]` text to match against.

### 2. Post-compaction anchor

After compaction, the anchor text from `assets/anchor.md` is injected into the history without
requesting a reply (`sendMessage` with `triggerTurn: false`), so work continues from the state
file `.pi/pi-recheck-hook/state.md` and, when present, the project rules file
`.pi/pi-recheck-hook/common.md`, rather than from the summary; without them, from freshly
verified code and commands.

> **Deviation from the OpenCode original.** OpenCode had `experimental.session.compacting`, which
> could carry the anchor *into* the summary. In pi, `session_before_compact` does not hook into the
> compaction protocol and handler-returned `customInstructions` are ignored
> (`agent-session.js:2257`). The anchor is therefore injected **after** compaction
> (`session_compact`) — which is what the requirement actually asks for: keep the pointer to the
> files, don't trust the summary.

**Subagents recheck too.** The hooks fire in subagent sessions by default: in-process children
(e.g. `@tintinweb/pi-subagents`) load this extension through their own session's extension
binding, and process-spawned workers (e.g. `pi-squad`) run a full pi process with the same
extensions — so each subagent rechecks its own turns, since only its final answer reaches the
orchestrator. All agents in one cwd share the single state file; the prompt gives each
agent its own `## <agent name>` section and tells it to edit only that section. Set
`"subagents": false` in `settings.json` (project or global) to silence both hooks in exactly
those sessions — the main session keeps running (see Scope).

## Layout

```text
pi-extension/index.ts   hooks + asset resolution (the whole implementation)
assets/recheck.md       end-of-turn recheck prompt
assets/anchor.md        post-compaction anchor prompt
tests/index.test.ts     drives handlers directly with synthesized events
```

## Prerequisites

Node with native TypeScript support — verified on **v24.21.0** (npm 11.19.0). There is no build
step and no `tsconfig.json`; `.ts` files are executed directly via Node's type stripping, so an
older Node without it cannot run the extension or its tests.

## Install

This is a pi extension, not an npm library. Point pi at `pi-extension/index.ts` — the entry
declared in `package.json` under `pi.extensions`. Prompt text is resolved at runtime per cwd, so
`assets/` must stay a sibling of the extension dir unless you override its location.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_RECHECK` | Kill/force switch: `0`/`false`/`off` forces the hooks off, `1`/`true`/`on` forces them on; anything else defers to settings. |
| `settings.json` | `{ "enabled": true|false }` in `<cwd>/.pi/pi-recheck-hook/` or `~/.pi/agent/extension-data/pi-recheck-hook/`. A file that is missing, unparseable, or without a boolean `enabled` counts as absent. Optional `"subagents": true|false` (default `true`) gates both hooks in subagent/child sessions only. Manageable via `/recheck on|off`, which merges into the existing file. |
| `PI_RECHECK_ASSETS_DIR` | Extra top-priority assets dir. |

Assets are resolved per **file**, first hit wins:

1. `$PI_RECHECK_ASSETS_DIR`
2. `<cwd>/.pi/pi-recheck-hook/assets` — project override
3. `~/.pi/agent/extension-data/pi-recheck-hook/assets` — global
4. `<module>/../assets` — bundled

An unreadable file counts as missing and the chain continues; if nothing matches, the handler
stays silent. Prompts are re-read from disk on every hook event — no cache — so editing an asset
takes effect on the next event.

## Scope

Enablement is config-driven, default **OFF**: `$PI_RECHECK` → project `settings.json` → global
`settings.json` → nothing means disabled. Both hooks inject nothing until one of those switches
says on. The same chain carries an optional boolean `subagents` (default **true**): when
`false`, both hooks stay silent in subagent/child sessions (any `PI_SUBAGENT_*` env var or a
`parentSession` session header), while the main session always runs once enabled.
The old task-file gate was removed in the 2026-10-16 rework; task paths are gone from
code and prompts alike. State is one file per project dir: `.pi/pi-recheck-hook/state.md`,
shared by the main session and every subagent in that cwd (each agent owns one `## <agent name>`
section and is told to edit only its own); project rules live in `.pi/pi-recheck-hook/common.md` (the model is told to re-read
it at every anchor). Both are optional and named in prompt text only — the hook never reads or
writes either, and the injected text is the asset verbatim, so a custom asset may point the
state file and rules anywhere else.

## Test

From the repository root:

```bash
npm test                        # node --test
node --test tests/index.test.ts # single file
```

Tests never need a running pi session — they register the handlers on a fake `ExtensionAPI` and
call them with synthesized events. They also rewrite `process.env.HOME` and clear the `PI_*`
variables per test, so run them in a clean environment. Prompt assertions read `assets/*.md` from
disk and compare verbatim, so rewriting a prompt will not fail a test — only logic changes will.
