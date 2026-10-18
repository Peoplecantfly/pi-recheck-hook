/**
 * pi-recheck-hook — every "done" is unverified until a checker says so.
 *
 * Two hooks:
 *
 *  1. `agent_before_settle` — fires at every settle boundary, and pi
 *     repeats the boundary after EACH auto-turn (_runBeforeSettleBoundary,
 *     agent-session.js:1538). pi 1.3.0 has no auto-turn cap, so the loop
 *     brake is ours: hasPendingRecheckCheck() below stays silent while the
 *     latest non-model context message is our own recheck prompt
 *     (customType `pi-recheck:recheck`). The anchor never counts as a
 *     pending check. Drafts are `CustomMessageEntryDraft`
 *     (`type: "custom_message"`, `customType`, `content`, `display`);
 *     customType is the marker.
 *
 *  2. `session_compact` — runs AFTER the compaction summary is appended.
 *     In practice pi fires it once per compaction. We append the anchor
 *     message through `pi.sendMessage(..., { triggerTurn: false })`: pinned
 *     to false so pi never steers a model reply out of it (history-only).
 *     Fires for manual and auto compaction alike.
 *
 * Enablement is config-driven, NOT task-file driven (2026-10-16 rework):
 *   $PI_RECHECK kill switch ("0"/"false"/"off" force-off,
 *                            "1"/"true"/"on" force-on)
 *   → <cwd>/.pi/pi-recheck-hook/settings.json   (project)
 *   → ~/.pi/agent/extension-data/pi-recheck-hook/settings.json (global)
 *   → nothing → DISABLED. A settings file that is missing, unparseable, or
 *   without a boolean "enabled" counts as absent; the chain continues.
 *
 * The task-file layout gate is gone (2026-10-16 rework) and no task paths
 * remain in code or prompts. State lives in `.pi/pi-recheck-hook/state.md`,
 * project rules in `.pi/pi-recheck-hook/common.md` — the prompt text names
 * them only; the hook never reads, writes or creates them, and both are
 * optional. The injected text is the asset file verbatim (no marker
 * substitution): which path the model uses is whatever the asset says, so a
 * custom asset may point the state file and rules anywhere else.
 *
 * Subagent sessions are NOT skipped (2026-10-18 rework): in-process children
 * (e.g. @tintinweb/pi-subagents) load this extension through their own
 * session's extension binding, and process-spawned workers (e.g. pi-squad)
 * run a full pi process with the same extensions — so a subagent rechecks
 * its own turns too, since only its final answer reaches the orchestrator.
 * All agents in one cwd share the single state file; the prompt tells them
 * to re-read before writing and merge, not clobber.
 *
 * Asset chain per prompt file (first non-blank hit wins): $PI_RECHECK_ASSETS_DIR
 * → <cwd>/.pi/pi-recheck-hook/assets → global extension-data assets → bundled
 * assets beside this module. Missing, unreadable, or blank files continue the
 * chain. No hit at all → the hook stays silent.
 *
 * Both hooks must never throw: a rejected hook or command aborts the settle /
 * the session. All fs work is wrapped in try/catch.
 *
 * The prompt texts are English renderings of the Russian originals. If the
 * originals are kept somewhere, keep them in sync with this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR = join(".pi", "pi-recheck-hook");
const GLOBAL_STATE_DIR = join(".pi", "agent", "extension-data", "pi-recheck-hook");
const GLOBAL_ASSETS_DIR = join(GLOBAL_STATE_DIR, "assets");

function homeDir(): string | undefined {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	return home && home !== "" ? home : undefined;
}

/** Read `{ "enabled": boolean }`; anything else (bad JSON, wrong type) is absent. */
function readEnabledFlag(path: string): boolean | null {
	try {
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf8"));
		if (typeof data !== "object" || data === null) return null;
		const flag = (data as Record<string, unknown>).enabled;
		return typeof flag === "boolean" ? flag : null;
	} catch {
		return null;
	}
}

function isEnabled(cwd: string): boolean {
	// Kill/force switch, readable without a running pi session.
	const env = process.env.PI_RECHECK?.trim().toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;

	const project = readEnabledFlag(join(cwd, CONFIG_DIR, "settings.json"));
	if (project !== null) return project;

	const home = homeDir();
	if (home) {
		const global = readEnabledFlag(join(home, GLOBAL_STATE_DIR, "settings.json"));
		if (global !== null) return global;
	}
	return false; // default: OFF — the hook only works when switched on
}

function assetsRoots(cwd: string): string[] {
	const roots: string[] = [];
	const envDir = process.env.PI_RECHECK_ASSETS_DIR?.trim();
	if (envDir) roots.push(envDir);
	roots.push(join(cwd, CONFIG_DIR, "assets"));
	const home = homeDir();
	if (home) roots.push(join(home, GLOBAL_ASSETS_DIR));
	roots.push(resolve(import.meta.dirname, "..", "assets"));
	return roots;
}

/** First readable, non-blank prompt file in the asset chain; "" when none
 * exists. An empty or whitespace-only file counts as missing so a half-edited
 * asset falls through to the next root instead of injecting blank text. */
function loadPrompt(cwd: string, name: string): string {
	for (const root of assetsRoots(cwd)) {
		const path = join(root, name);
		try {
			if (!existsSync(path)) continue;
			const text = readFileSync(path, "utf8");
			if (text.trim() !== "") return text;
		} catch {
			// An unreadable file counts as missing — try the next root.
		}
	}
	return "";
}

// No entry/compaction-id memory: the projected context only grows, so ids
// repeat within one replay only, where the pending-check guard answers.

function isBoundaryCovered(entry: any): boolean {
	// A compaction or branch_summary boundary is not "assistant just claimed
	// something" — the recheck prompt belongs to a real done, not to these.
	return entry?.sourceEntry?.type !== "message";
}

/** True while the latest non-model message in the projected context is our
 * recheck prompt — a check is pending, so a new injection would only start
 * another verify turn and another boundary (pi 1.3.0 caps nothing). The
 * anchor does not count: it never substitutes for a per-turn recheck.
 * Mirrors the real projection shape: one message per entry, custom entries
 * project to a role-custom message carrying customType (messages.js:57). */
function hasPendingRecheckCheck(entries: any[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const messages = entries[i]?.messages ?? [];
		for (let j = messages.length - 1; j >= 0; j--) {
			const message = messages[j];
			const role = message?.role;
			// Assistant turns and tool results are model-side chatter.
			if (role === "assistant" || role === "toolResult") continue;
			return role === "custom" && message?.customType === "pi-recheck:recheck";
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	// /recheck [on|off|status] — manage the project-local setting.
	pi.registerCommand("recheck", {
		description: "pi-recheck-hook: show or change checker state",
		handler: async (args: string, ctx: ExtensionContext) => {
			const notify = (msg: string, level: "info" | "warning" | "error") => (ctx as any).ui?.notify?.(msg, level);
			try {
				const cwd = ctx.cwd;
				const arg = (args ?? "").trim().toLowerCase();

				if (arg === "on" || arg === "off") {
					const enabled = arg === "on";
					const path = join(cwd, CONFIG_DIR, "settings.json");
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`);
					notify(`pi-recheck-hook ${enabled ? "enabled" : "disabled"} — ${path}`, enabled ? "info" : "warning");
				} else if (arg) {
					notify("usage: /recheck [on|off]", "info");
				} else {
					notify(
						`checker: ${isEnabled(cwd) ? "ON" : "OFF"} (default OFF; /recheck on to enable)`,
						"info",
					);
				}
			} catch (error) {
				try {
					(ctx as any).ui?.notify?.(`pi-recheck-hook: ${error instanceof Error ? error.message : String(error)}`, "error");
				} catch {
					// UI unavailable — nothing safe left to do.
				}
			}
		},
	});

	pi.on("agent_before_settle", (event: any, ctx: ExtensionContext) => {
		try {
			if (!isEnabled(ctx.cwd)) return;

			const recheck = loadPrompt(ctx.cwd, "recheck.md");
			if (!recheck) return; // no prompt file anywhere → stay silent

			const boundaryEntries = event?.context?.contextEntries ?? [];
			const lastEntry = boundaryEntries[boundaryEntries.length - 1];
			if (!lastEntry || isBoundaryCovered(lastEntry)) return;

			const outcome = event?.outcome;
			if (outcome === "error" || outcome === "aborted") return;

			const messages = lastEntry.messages ?? [];
			const lastMessage = messages[messages.length - 1];
			if (!lastMessage || lastMessage.role !== "assistant") return;

			const blocks = Array.isArray(lastMessage.content) ? lastMessage.content : [];
			const text = blocks
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text ?? "")
				.join("");
			const hasToolCall = blocks.some((block: any) => block.type === "toolCall" || block.type === "tool_call");
			if (!text && !hasToolCall) return; // nothing was claimed → nothing to check
			if (hasPendingRecheckCheck(boundaryEntries)) return; // our check is pending — no loop

			return {
				entries: [
					{
						type: "custom_message",
						customType: "pi-recheck:recheck",
						// Verbatim asset text — the state path in it is whatever
						// the asset says (custom assets may name another one).
						// customType is the machine marker.
						content: [{ type: "text", text: recheck }],
						display: false,
						details: {},
					},
				],
				continue: true,
			};
		} catch {
			// Never throw: a rejected settle hook aborts the session.
			return;
		}
	});

	pi.on("session_compact", (event: any, ctx: ExtensionContext) => {
		try {
			if (event?.fromExtension) return;
			if (!isEnabled(ctx.cwd)) return;

			const anchor = loadPrompt(ctx.cwd, "anchor.md");
			if (!anchor) return;

			// No compaction-id memory: session_compact fires once per compaction,
			// and replaying a range hits the same prompt anyway only via this path.
			// triggerTurn pinned to false: history-only append, no steered reply.
			// sendMessage is declared void but implemented async — swallow any
			// rejection so a failed append cannot crash the session.
			Promise.resolve(
				pi.sendMessage(
					{
						customType: "pi-recheck:anchor",
						content: [{ type: "text", text: anchor }],
						display: false,
						details: {},
					},
					{ triggerTurn: false },
				),
			).catch(() => {
				// A failed anchor must not abort the session.
			});
		} catch {
			// Never throw.
			return;
		}
	});
}
