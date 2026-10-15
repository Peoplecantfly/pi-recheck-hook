# pi-recheck-hook

Two behavioural hooks for [pi](https://github.com/badlogic/pi-mono), ported from the workshop
OpenCode plugin "Huki". They fight two failure modes: an agent that ends a turn having answered
from memory instead of from the code, and an agent that keeps working from a compaction summary
instead of from the task files.

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

Suppressed when: `PI_RECHECK=0`; the prompt file is missing; the cwd has no task files; this is a
subagent session; the outcome was `aborted` or `error`; the last entry is a `compaction` or
`branch_summary`; the turn did not end with an assistant message; the prompt was already the last
human text; or it already fired for this turn.

### 2. Post-compaction anchor

After compaction, the anchor text from `assets/anchor.md` is injected into the history without
requesting a reply (`sendMessage` with no `triggerTurn`), so work continues from
`tasks/factory/00-obshchee.md` / `state.md` / the current task file rather than from the summary.

> **Deviation from the OpenCode original.** OpenCode had `experimental.session.compacting`, which
> could carry the anchor *into* the summary. In pi, `session_before_compact` does not hook into the
> compaction protocol and handler-returned `customInstructions` are ignored
> (`agent-session.js:2257`). The anchor is therefore injected **after** compaction
> (`session_compact`) — which is what the requirement actually asks for: keep the pointer to the
> files, don't trust the summary.

Subagent detection also differs: OpenCode used `session.parentID`; pi events carry no such link, so two
markers are checked — (1) the session header's `parentSession` field (in-process child sessions, e.g.
`@tintinweb/pi-subagents`, via `ctx.sessionManager.getHeader()`) and (2) the `PI_SUBAGENT_SESSION` /
`PI_SUBAGENT_ID` / `PI_SUBAGENT_NAME` / `PI_SUBAGENT_AGENT` environment variables (process-spawned
children, e.g. `pi-interactive-subagents`). Either present ⇒ subagent.

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
| `PI_RECHECK` | Set to `0` to disable the recheck hook. |
| `PI_RECHECK_ASSETS_DIR` | Extra top-priority assets dir. |
| Subagent markers | Session header carrying `parentSession` (in-process child session), or any of the four `PI_SUBAGENT_*` env vars ⇒ treated as a subagent; both hooks stay silent. |

Assets are resolved per **file**, first hit wins:

1. `$PI_RECHECK_ASSETS_DIR`
2. `<cwd>/.pi/pi-recheck-hook/assets` — project override
3. `~/.pi/agent/extension-data/pi-recheck-hook/assets` — global
4. `<module>/../assets` — bundled

An unreadable file counts as missing and the chain continues; if nothing matches, the handler
stays silent. Resolved prompts are cached per cwd, so editing an asset mid-session has no effect
until restart.

## Scope

Both hooks no-op unless the cwd contains `tasks/factory/00-obshchee.md` or
`workshop/tasks/factory/00-obshchee.md`. Running pi from a checkout of this repository does
nothing — that is expected; the task files live in the project you work on, not here. To use the
hooks elsewhere with different task-file paths, add them to `TASK_FILE_PATHS`.

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
