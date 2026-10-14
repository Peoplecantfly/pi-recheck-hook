// © {proj:"ai_kit", path:"pi-recheck-hook/pi-extension/index.ts", kind:"code", created:"2026-10-14", note:"Recheck + anchor hooks for pi: end-of-turn recheck + post-compaction anchor. Port of the workshop OpenCode plugin. Prompt texts live in ../assets/."}
//
// Recheck + anchor hooks for pi (port of the OpenCode plugin).
//
// The spec lives in the workshop markdown file beside that plugin; this file
// only implements it.
//   1. Recheck: the agent finished a turn and waits for a human → send the
//      "verify against facts, not from memory" prompt. Once per turn.
//      Not in subagents, not right after a summary, not after an error.
//      Disabled with PI_RECHECK=0.
//   2. Anchor: after compaction inject a message without a model reply so
//      work continues from the task files, not from the summary.
//
// What is not ported literally (pi API constraints):
//   · OpenCode had `experimental.session.compacting` — we asked to carry the
//      anchor into the summary. In pi `session_before_compact` does not hook
//      into the compaction protocol and handler-returned `customInstructions`
//      are ignored (agent-session.js:2257). Instead the anchor is injected
//      into the history right AFTER compaction (`session_compact`), which is
//      what the anchor requirement actually calls for: keep the message,
//      don't trust the summary.
//   · OpenCode detected subagents via `session.parentID`. Pi has no such
//      link; child sessions launch with PI_SUBAGENT_SESSION / PI_SUBAGENT_ID /
//      PI_SUBAGENT_NAME / PI_SUBAGENT_AGENT env vars
//      (pi-interactive-subagents, pi-extension/subagents/index.ts:1556-1582).
//   · "Turn ended, waiting for a human" = the single boundary event
//      `agent_before_settle` (not `turn_end`: it fires per turn inside a run;
//      not `agent_settled`: notification-only). At that point
//      `context.canContinue` is always false (last fragment is the assistant
//      reply); we still request continuation because we expect an answer.
//
// Asset resolution is lazy and per-cwd (see resolveAssets): the running cwd
// is not known at module-load time, so prompts are resolved from ctx.cwd
// inside the handlers, with a small per-directory cache.

/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ==================== CONFIG ====================

/**
 * Prompt texts are not pinned in code — `assets/recheck.md` and
 * `assets/anchor.md` hold them (English rendering of the two blocks in the
 * workshop spec file; the originals there are Russian).
 *
 * Resolution chain, checked per asset; first location that contains the file
 * wins, none → empty string → the handler stays silent:
 *   0. `PI_RECHECK_ASSETS_DIR` (if set) — extra top-priority dir.
 *   1. `<cwd>/.pi/pi-recheck-hook/assets` — project-local override.
 *   2. `~/.pi/agent/extension-data/pi-recheck-hook/assets` — global.
 *   3. `<module>/../assets` — bundled (sibling of this extension dir).
 */
function candidateAssetDirs(cwd: string): string[] {
	const dirs = [
		join(cwd, ".pi", "pi-recheck-hook", "assets"),
		join(homedir(), ".pi", "agent", "extension-data", "pi-recheck-hook", "assets"),
		join(import.meta.dirname, "..", "assets"),
	];
	const envDir = process.env.PI_RECHECK_ASSETS_DIR;
	return envDir ? [envDir, ...dirs] : dirs;
}

type Prompts = { recheck: string; anchor: string };

/** Cache keyed by cwd so a repeated handler call does not re-read the chain. */
const promptsByCwd = new Map<string, Prompts>();

/**
 * Resolve both prompts for `cwd`, walking the chain per file. A file that is
 * unreadable counts as missing (empty); the first location that holds a
 * readable copy wins.
 */
function resolveAssets(cwd: string): Prompts {
	const cached = promptsByCwd.get(cwd);
	if (cached) return cached;

	const dirs = candidateAssetDirs(cwd);
	const firstExisting = (asset: "recheck.md" | "anchor.md"): string => {
		for (const dir of dirs) {
			const file = join(dir, asset);
			if (!existsSync(file)) continue;
			try {
				return readFileSync(file, "utf8");
			} catch {
				// Unreadable — treat as missing and keep walking the chain.
			}
		}
		return "";
	};

	const prompts: Prompts = {
		recheck: firstExisting("recheck.md"),
		anchor: firstExisting("anchor.md"),
	};
	promptsByCwd.set(cwd, prompts);
	return prompts;
}

/** Candidate paths to the "common file" — repo root or workshop/ as root. */
const TASK_FILE_PATHS: string[][] = [
	["tasks", "factory", "00-obshchee.md"],
	["workshop", "tasks", "factory", "00-obshchee.md"],
];

// ==================== TYPES (minimal, so the file has no package deps) ====================

type TextPart = { type: string; text?: string };
type AnyMessage = { role: string; content: TextPart[] };
type AnyEntry = { sourceEntry: { id: string; type: string }; messages: AnyMessage[] };
type AnyContext = {
	contextEntries: AnyEntry[];
	contextMessages: AnyMessage[];
	canContinue: boolean;
};
type AnySettleEvent = {
	type: "agent_before_settle";
	continue: boolean;
	context: AnyContext;
	outcome: "completed" | "aborted" | "error";
};
type AnyCompactEvent = {
	type: "session_compact";
	compactionEntry?: { id: string };
	fromExtension: boolean;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
};
type BoundaryDraft = {
	type: "custom_message";
	customType: string;
	content: TextPart[];
	display: boolean;
	details?: Record<string, unknown>;
};
type SettleResult = { entries?: BoundaryDraft[]; continue?: boolean };
type ExtensionCtx = { cwd: string };
type SendMessageOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
type ExtensionAPI = {
	on(event: "agent_before_settle", handler: (event: AnySettleEvent, ctx: ExtensionCtx) => SettleResult | void): () => void;
	on(event: "session_compact", handler: (event: AnyCompactEvent, ctx: ExtensionCtx) => void): () => void;
	sendMessage(
		message: { customType: string; content: TextPart[]; display: boolean; details?: Record<string, unknown> },
		options?: SendMessageOptions,
	): void;
};

// ==================== HELPERS ====================

/**
 * Message text: `content` is a fragment array that may contain non-text
 * parts (images), so only text fragments are joined.
 */
function textOf(content: string | TextPart[] | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? []).map((part) => part.text ?? "").join("\n");
}

/**
 * Are we in a subagent? Pi child sessions always have PI_SUBAGENT_SESSION;
 * the softer markers (PI_SUBAGENT_ID/NAME/AGENT) count too — if any is set,
 * this is not the main session.
 */
function isSubagent(): boolean {
	return Boolean(
		process.env.PI_SUBAGENT_SESSION ||
			process.env.PI_SUBAGENT_ID ||
			process.env.PI_SUBAGENT_NAME ||
			process.env.PI_SUBAGENT_AGENT,
	);
}

/**
 * Has this text already been said? Exact match only — our own message stays
 * in the history verbatim, so a paraphrase or a partial quote does not
 * count as "the human already asked this".
 */
function alreadyAsked(text: string | undefined, prompt: string): boolean {
	return text === prompt;
}

/**
 * Does this folder hold the task workspace: `tasks/factory/00-obshchee.md`
 * (as in the original) or `workshop/tasks/factory/00-obshchee.md`
 * (layout of this repository)?
 */
function hasTaskFiles(cwd: string): boolean {
	return TASK_FILE_PATHS.some((path) => existsSync(join(cwd, ...path)));
}

/**
 * Last fragment that still speaks for a "human" (user, or our own
 * custom_message). Scanned from the end — `lastHumanText` in the original.
 */
function lastHumanText(messages: AnyMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "custom") return textOf(message.content);
	}
	return undefined;
}

/** Last entry carrying messages (searched from the end). */
function lastEntryWithMessages(entries: AnyEntry[]): AnyEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if ((entries[i].messages?.length ?? 0) > 0) return entries[i];
	}
	return undefined;
}

// ==================== HOOK 1: RECHECK ====================

export default function recheckHooks(pi: ExtensionAPI): void {
	const recheckedEntries = new Set<string>();
	const anchoredCompactions = new Set<string>();

	pi.on("agent_before_settle", (event, ctx) => {
		const { recheck, anchor } = resolveAssets(ctx.cwd);
		if (process.env.PI_RECHECK === "0") return; // disabled
		if (!recheck) return; // prompt file missing — stay silent
		if (!hasTaskFiles(ctx.cwd)) return; // foreign repository
		if (isSubagent()) return; // main session only
		if (event.outcome !== "completed") return; // error/abort is not our case

		const last = lastEntryWithMessages(event.context.contextEntries);
		if (!last) return; // empty projection — nothing to continue from
		if (last.sourceEntry.type === "compaction" || last.sourceEntry.type === "branch_summary") {
			return; // right after a summary — not our case
		}

		const lastMessage = last.messages[last.messages.length - 1];
		if (lastMessage?.role !== "assistant") return; // turn did not end with an answer

		const key = last.sourceEntry.id;
		if (recheckedEntries.has(key)) return; // already sent once for this turn

		const humanText = lastHumanText(event.context.contextMessages);
		// Never answer our own recheck or anchor a second time.
		if (alreadyAsked(humanText, recheck) || alreadyAsked(humanText, anchor)) return;

		// Note: do NOT check context.canContinue here. At "turn ended, waiting
		// for a human" the last fragment is the assistant reply, so
		// canContinue is always false; continuation works precisely because
		// our recheck message becomes the last one.
		recheckedEntries.add(key);
		return {
			entries: [
				{
					type: "custom_message",
					customType: "pi-recheck:recheck",
					content: [{ type: "text", text: recheck }],
					display: true,
					details: { hook: "recheck", entryId: key },
				},
			],
			// Expect an answer, don't just drop text into the history.
			continue: true,
		};
	});

	// ==================== HOOK 2: ANCHOR ====================

	pi.on("session_compact", (event, ctx) => {
		const { anchor } = resolveAssets(ctx.cwd);
		if (!anchor) return; // prompt file missing — stay silent
		if (!hasTaskFiles(ctx.cwd)) return; // foreign repository
		if (isSubagent()) return; // main session only
		const key = event.compactionEntry?.id ?? event.reason;
		if (anchoredCompactions.has(key)) return; // once per compaction
		anchoredCompactions.add(key);

		// No triggerTurn: the message stays in the history but asks for no reply.
		pi.sendMessage(
			{
				customType: "pi-recheck:anchor",
				content: [{ type: "text", text: anchor }],
				display: true,
				details: { hook: "anchor", compactionId: key },
			},
			{},
		);
	});
}
