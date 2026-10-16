// Tests for pi-recheck-hook. Drive the handlers directly by registering them
// on a fake ExtensionAPI, then invoke them with synthesized events. Import
// the extension from ../pi-extension/; load prompt text from ../assets/ to
// compare verbatim.
//
// Spec under test (2026-10-16 rework):
//   · Enablement is config-driven, NOT task-file driven. Chain per cwd:
//     PI_RECHECK=0 kill switch → <cwd>/.pi/pi-recheck-hook/settings.json →
//     ~/.pi/agent/extension-data/pi-recheck-hook/settings.json → default
//     DISABLED. A settings file that is missing/unparseable/without a
//     boolean "enabled" counts as absent (chain continues).
//   · Both hooks (recheck AND anchor) respect the enabled switch.
//   · Asset chain per prompt file: PI_RECHECK_ASSETS_DIR → project
//     .pi/pi-recheck-hook/assets → global extension-data assets → bundled.
//   · State path: prompts carry a literal `<session id>` marker; the handler
//     substitutes ctx.sessionManager.getSessionId() when available, and stays
//     byte-identical to the asset when it is not.
//   · /recheck enable|disable (runtime command) is tested in its own section.
//
// Note: the real extension's bundled dir always holds recheck.md/anchor.md,
// so "project overrides global/bundled", "global when no project", and
// "bundled fallback" are all reachable directly. To reach the "missing file
// stays silent" case we copy the extension into a temp dir whose sibling
// assets/ is empty, so no candidate holds the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import recheckHooks from "../pi-extension/index.ts";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const RECHECK_BUNDLED = join(REPO_ROOT, "assets", "recheck.md");
const ANCHOR_BUNDLED = join(REPO_ROOT, "assets", "anchor.md");

const bundledRecheck = () => readFileSync(RECHECK_BUNDLED, "utf8");
const bundledAnchor = () => readFileSync(ANCHOR_BUNDLED, "utf8");

const ENABLED = '{"enabled": true}';

// ---- Harness: a fake ExtensionAPI that records handlers + sendMessage. ----

function makePi() {
	/** @type {Record<string, Function>} */
	const handlers = {};
	/** @type {Record<string, {description?: string, handler: Function}>} */
	const commands = {};
	/** @type {Array<{message: any, options: any}>} */
	const sent = [];
	return {
		handlers,
		commands,
		sent,
		pi: {
			on(/** @type {string} */ event, /** @type {Function} */ handler) {
				handlers[event] = handler;
				return () => {
					delete handlers[event];
				};
			},
			sendMessage(/** @type {any} */ message, /** @type {any} */ options) {
				sent.push({ message, options });
			},
			registerCommand(/** @type {string} */ name, /** @type {any} */ options) {
				commands[name] = options;
			},
		},
	};
}

/** Register the extension under test on a fresh fake API. */
function setup() {
	const h = makePi();
	recheckHooks(h.pi);
	return h;
}

/** Build an assistant-ended settle event so the recheck handler can fire. */
function assistantSettle(/** @type {string} */ entryId = "e1") {
	return {
		type: "agent_before_settle",
		continue: false,
		outcome: "completed",
		context: {
			contextEntries: [
				{
					sourceEntry: { id: entryId, type: "message" },
					messages: [
						{ role: "user", content: [{ type: "text", text: "do the thing" }] },
						{ role: "assistant", content: [{ type: "text", text: "done" }] },
					],
				},
			],
			contextMessages: [{ role: "user", content: [{ type: "text", text: "do the thing" }] }],
			canContinue: false,
		},
	};
}

/** @param {string} [id] */
function compactEvent(id = "c1") {
	return { type: "session_compact", compactionEntry: { id }, fromExtension: false, reason: "threshold", willRetry: false };
}

/**
 * Settle event with REAL pi 1.3.0 projection shapes (session-manager.js:256
 * buildSessionProjection): one message per entry, {sourceEntry, messages}.
 */
function settleWith(/** @type {Array<{sourceEntry: any, messages: any[]}>} */ entries) {
	return {
		type: "agent_before_settle",
		continue: false,
		outcome: "completed",
		context: { contextEntries: entries, contextMessages: entries.flatMap((e) => e.messages), canContinue: true },
	};
}

/** @param {string} id @param {any} message */
function msgEntry(id, message) {
	return { sourceEntry: { id, type: "message" }, messages: [message] };
}

/** A projected custom_message entry: one role-custom message (messages.js:57). */
function customEntry(id, customType, text) {
	return {
		sourceEntry: { id, type: "custom_message", customType },
		messages: [{ role: "custom", customType, content: [{ type: "text", text }], display: false, details: {} }],
	};
}

/** Clear every env marker so each test starts from a known baseline. */
function clearEnv() {
	delete process.env.PI_RECHECK;
	delete process.env.PI_RECHECK_ASSETS_DIR;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_AGENT;
}

/** Write `content` at `relPath` under `root`, creating parent dirs. */
function writeFileAt(root, relPath, content) {
	const file = join(root, relPath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

/**
 * Create a temp project dir (a plain cwd — task-file layout is no longer
 * relevant). `settings` writes .pi/pi-recheck-hook/settings.json,
 * `projectAssets` writes .pi/pi-recheck-hook/assets/<name>, `files` writes
 * extra repo files at the given relative paths.
 */
function makeProject({ settings = null, projectAssets = null, files = [] } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "recheck-proj-"));
	if (settings) writeFileAt(cwd, join(".pi", "pi-recheck-hook", "settings.json"), settings);
	if (projectAssets) {
		for (const [name, text] of Object.entries(projectAssets)) writeFileAt(cwd, join(".pi", "pi-recheck-hook", "assets", name), text);
	}
	for (const f of files) writeFileAt(cwd, f, "# filler\n");
	return cwd;
}

/** Project with the hooks enabled via project-local settings.json. */
function enabledProject(opts = {}) {
	return makeProject({ ...opts, settings: ENABLED });
}

/**
 * Build a fake HOME whose global extension-data dir holds `settings`
 * (settings.json) and `assets`. Return the home dir to point HOME at.
 */
function makeHome({ settings = null, assets = null } = {}) {
	const home = mkdtempSync(join(tmpdir(), "recheck-home-"));
	if (settings) writeFileAt(home, join(".pi", "agent", "extension-data", "pi-recheck-hook", "settings.json"), settings);
	if (assets) {
		for (const [name, text] of Object.entries(assets)) writeFileAt(home, join(".pi", "agent", "extension-data", "pi-recheck-hook", "assets", name), text);
	}
	return home;
}

/** Build a dir holding `assets` directly, for the PI_RECHECK_ASSETS_DIR case. */
function makeDirAssets(assets) {
	const dir = mkdtempSync(join(tmpdir(), "recheck-env-"));
	for (const [name, text] of Object.entries(assets)) writeFileSync(join(dir, name), text);
	return dir;
}

/**
 * Run `fn` (sync or async) with process.env.HOME pointed at `homeDir`, and
 * await it, so HOME is restored only after an async body has settled. If HOME
 * was unset before, it is deleted again instead of being set to `undefined`.
 */
async function withHome(homeDir, fn) {
	const prev = process.env.HOME;
	process.env.HOME = homeDir;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.HOME;
		else process.env.HOME = prev;
	}
}

// Copy the extension into a temp package whose sibling assets/ holds only
// `assets` (may be empty), so the bundled candidate can be made to miss.
function makeTempCopy(assets) {
	const root = mkdtempSync(join(tmpdir(), "recheck-copy-"));
	const extDir = join(root, "pi-extension");
	const assetsDir = join(root, "assets");
	mkdirSync(extDir, { recursive: true });
	mkdirSync(assetsDir, { recursive: true });
	copyFileSync(join(REPO_ROOT, "pi-extension", "index.ts"), join(extDir, "index.ts"));
	if (assets) {
		for (const [name, text] of Object.entries(assets)) writeFileSync(join(assetsDir, name), text);
	}
	return root;
}

// ===================== Requirement: enablement is config-driven =====================

test("disabled by default: no settings.json → no recheck, no anchor, no .pi side effects", () => {
	clearEnv();
	const cwd = makeProject();
	const { handlers, sent } = setup();
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(!res || !res.entries, "recheck must stay silent with no config");
	handlers.session_compact(compactEvent(), { cwd });
	assert.equal(sent.length, 0, "anchor must stay silent with no config");
	assert.ok(!existsSync(join(cwd, ".pi")), "disabled extension must not create .pi/pi-recheck-hook");
});

test("recheck fires when local settings.json enables the hooks", () => {
	clearEnv();
	const cwd = enabledProject(); // no tasks/factory/* at all — the old task-file gate is gone
	const { handlers } = setup();
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(res, "handler returned nothing");
	assert.equal(res.entries.length, 1);
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
	assert.equal(res.entries[0].content[0].text, bundledRecheck());
	assert.equal(res.continue, true);
});

test("task-file layout is irrelevant: fires without, with workshop-, and with root task files", () => {
	clearEnv();
	for (const files of [[], ["workshop/tasks/factory/00-obshchee.md"], ["tasks/factory/00-obshchee.md"]]) {
		const cwd = enabledProject({ files });
		const { handlers } = setup();
		const res = handlers.agent_before_settle(assistantSettle(`layout-${files.length}`), { cwd });
		assert.ok(res && res.entries, `must fire for layout ${JSON.stringify(files)}`);
	}
});

test("global settings.json enables when no project-local file", async () => {
	clearEnv();
	const home = makeHome({ settings: ENABLED });
	const cwd = makeProject();
	await withHome(home, () => {
		const { handlers } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.ok(res && res.entries, "global config must enable the hooks");
	});
});

test("local {enabled:false} overrides global {enabled:true}", async () => {
	clearEnv();
	const home = makeHome({ settings: ENABLED });
	const cwd = makeProject({ settings: '{"enabled": false}' });
	await withHome(home, () => {
		const { handlers, sent } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.ok(!res || !res.entries, "local disable must win over global enable");
		handlers.session_compact(compactEvent(), { cwd });
		assert.equal(sent.length, 0);
	});
});

test("garbage or keyless local settings count as absent, global wins", async () => {
	clearEnv();
	const home = makeHome({ settings: ENABLED });
	await withHome(home, () => {
		for (const garbage of ["{not json", '{"enabled": "yes"}', "{}"]) {
			const cwd = makeProject({ settings: garbage });
			const { handlers } = setup();
			const res = handlers.agent_before_settle(assistantSettle(`garbage-${garbage.length}`), { cwd });
			assert.ok(res && res.entries, `must fall through to global for settings '${garbage}'`);
		}
	});
});

test("PI_RECHECK=0 kills both hooks even when config enables them", () => {
	clearEnv();
	process.env.PI_RECHECK = "0";
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(!res || !res.entries, "recheck must respect PI_RECHECK=0");
	handlers.session_compact(compactEvent(), { cwd });
	assert.equal(sent.length, 0, "anchor must respect PI_RECHECK=0 too (p.4 fix)");
});

// ===================== Requirement: main-session-only =====================

test("subagent sessions stay silent (any PI_SUBAGENT_* set, even when enabled)", () => {
	clearEnv();
	for (const key of ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_NAME", "PI_SUBAGENT_AGENT"]) {
		clearEnv();
		process.env[key] = "1";
		const cwd = enabledProject();
		const { handlers, sent } = setup();
		const res = handlers.agent_before_settle(assistantSettle(`sub-${key}`), { cwd });
		assert.ok(!res || !res.entries, `recheck must skip when ${key} set`);
		handlers.session_compact(compactEvent(`sub-${key}`), { cwd });
		assert.equal(sent.length, 0, `anchor must skip when ${key} set`);
	}
});

test("in-process child sessions stay silent (parentSession in header)", () => {
	clearEnv();
	const cwd = enabledProject();
	const childCtx = {
		cwd,
		sessionManager: { getHeader: () => ({ type: "session", id: "child", parentSession: "/sessions/parent.jsonl" }) },
	};
	const { handlers, sent } = setup();
	const res = handlers.agent_before_settle(assistantSettle("child-1"), childCtx);
	assert.ok(!res || !res.entries, "recheck must skip child sessions");
	handlers.session_compact(compactEvent("child-1"), childCtx);
	assert.equal(sent.length, 0, "anchor must skip child sessions");
});

test("main session without parentSession header still fires when enabled", () => {
	clearEnv();
	const cwd = enabledProject();
	const mainCtx = { cwd, sessionManager: { getHeader: () => ({ type: "session", id: "main" }) } };
	const { handlers } = setup();
	const res = handlers.agent_before_settle(assistantSettle("main-1"), mainCtx);
	assert.ok(res && res.entries, "handler returned nothing");
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
});

// ===================== Requirement: concrete state path =====================

test("state path is substituted with the real session id when pi exposes it", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	const ctx = {
		cwd,
		sessionManager: { getHeader: () => ({ type: "session", id: "main" }), getSessionId: () => "cafebabe" },
	};
	const res = handlers.agent_before_settle(assistantSettle("inject-1"), ctx);
	assert.ok(res && res.entries, "recheck must fire");
	const recheckText = res.entries[0].content[0].text;
	assert.ok(!recheckText.includes("<session id>"), "recheck placeholder must be substituted");
	assert.ok(recheckText.includes(".pi/pi-recheck-hook/cafebabe/state.md"), "recheck must name the concrete state path");
	handlers.session_compact(compactEvent("inject-1"), ctx);
	assert.equal(sent.length, 1, "anchor must fire once");
	const anchorText = sent[0].message.content[0].text;
	assert.ok(!anchorText.includes("<session id>"), "anchor placeholder must be substituted");
	assert.ok(anchorText.includes(".pi/pi-recheck-hook/cafebabe/state.md"), "anchor must name the concrete state path");
});

test("prompts stay byte-identical to the asset when session id is unavailable", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	const res = handlers.agent_before_settle(assistantSettle("noid-1"), { cwd });
	assert.ok(res && res.entries, "recheck must fire");
	assert.equal(res.entries[0].content[0].text, bundledRecheck());
	handlers.session_compact(compactEvent("noid-1"), { cwd });
	assert.equal(sent[0].message.content[0].text, bundledAnchor());
});

// ===================== Requirement: once-per-turn / skip semantics =====================

test("same entry id twice fires both times — ids do not dedupe, the pending check does", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const first = handlers.agent_before_settle(assistantSettle("same"), { cwd });
	assert.ok(first && first.entries);
	const second = handlers.agent_before_settle(assistantSettle("same"), { cwd });
	assert.ok(second && second.entries, "no entry-id memory — the self-brake is the pending check");
});

test("entries with empty messages arrays are skipped, not trusted", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	// Real shapes: plain custom entries and context edits project to NO
	// messages (session-manager.js sessionEntryToContextMessages).
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		{ sourceEntry: { id: "c9", type: "custom", customType: "pi-recheck:recheck" }, messages: [] },
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "I claim done" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(res && res.entries, "an entry with no messages cannot be a pending check");
});

test("recheck skipped after compaction/branch_summary entry", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	for (const type of ["compaction", "branch_summary"]) {
		const ev = assistantSettle(`sum-${type}`);
		ev.context.contextEntries[0].sourceEntry.type = type;
		const res = handlers.agent_before_settle(ev, { cwd });
		assert.ok(!res || !res.entries, `must skip for ${type}`);
	}
});

test("recheck skipped after error/aborted outcome", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	for (const outcome of ["error", "aborted"]) {
		const ev = assistantSettle(`bad-${outcome}`);
			ev.outcome = outcome;
		const res = handlers.agent_before_settle(ev, { cwd });
		assert.ok(!res || !res.entries, `must skip for ${outcome}`);
	}
});

// pi 1.3.0 has NO auto-turn cap: every injected recheck spawns a
// verification turn, and the settle boundary fires again after it. Without
// a self-brake the hook re-injects forever, so the last non-model context
// message being one of our own injections must silence the hook.

test("no re-injection while our own recheck is still pending", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "I claim done" }] }),
		customEntry("x1", "pi-recheck:recheck", bundledRecheck()),
		msgEntry("e3", { role: "assistant", content: [{ type: "text", text: "Rechecked, nothing to fix" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(!res || !res.entries, "must not re-inject: our recheck is still the pending check");
});

test("no re-injection across tool-using verification (custom → toolCall → toolResult → text)", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "I claim done" }] }),
		customEntry("x1", "pi-recheck:recheck", bundledRecheck()),
		msgEntry("v1", { role: "assistant", content: [{ type: "toolCall", name: "bash", args: { command: "ls" } }] }),
		msgEntry("v2", { role: "toolResult", content: [{ type: "text", text: "file.ts" }] }),
		msgEntry("v3", { role: "assistant", content: [{ type: "text", text: "Rechecked" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(!res || !res.entries, "tool chatter after our prompt must not reopen the check");
});

test("anchor pending does NOT block the recheck", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	// Post-compaction flow: our anchor sits at the end of the projection.
	// It is not a recheck — the turn's unverified claim still needs checking.
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		customEntry("x1", "pi-recheck:anchor", bundledAnchor()),
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "All done, tests pass" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(res && res.entries, "a pending anchor must not silence the recheck");
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
});

test("control: the same shape WITHOUT the pending custom entry fires", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "I claim done" }] }),
		msgEntry("e3", { role: "assistant", content: [{ type: "text", text: "more work" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(res && res.entries, "no pending check → must fire");
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
});

test("a foreign custom message does not silence the recheck", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const ev = settleWith([
		msgEntry("e1", { role: "user", content: [{ type: "text", text: "do the thing" }] }),
		customEntry("x9", "other-ext:noise", "unrelated injection"),
		msgEntry("e2", { role: "assistant", content: [{ type: "text", text: "I claim done" }] }),
	]);
	const res = handlers.agent_before_settle(ev, { cwd });
	assert.ok(res && res.entries, "only pi-recheck:* customTypes are our own checks");
});

// ===================== Requirement: anchor fires when enabled =====================

test("anchor injected when enabled, history-only (triggerTurn false)", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	handlers.session_compact(compactEvent(), { cwd });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "pi-recheck:anchor");
	assert.equal(sent[0].message.content[0].text, bundledAnchor());
	// triggerTurn must be pinned to false: with {} (undefined) pi would steer the
	// message while streaming (auto-compaction) and elicit a model reply.
	assert.equal(sent[0].options?.triggerTurn, false);
});

test("same compaction id twice sends both anchors — replay is rare, no id memory", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	handlers.session_compact(compactEvent("samec"), { cwd });
	handlers.session_compact(compactEvent("samec"), { cwd });
	// Real sessions emit session_compact once per compaction entry; a replay
	// of the same one repeats the prompt — acceptable, no dedupe Set.
	assert.equal(sent.length, 2);
});

// ===================== Requirement: Asset resolution chain =====================

test("project-local assets override global and bundled", async () => {
	clearEnv();
	const home = makeHome({ assets: { "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" } });
	const cwd = enabledProject({ projectAssets: { "recheck.md": "PROJECT RECHECK", "anchor.md": "PROJECT ANCHOR" } });
	await withHome(home, () => {
		const { handlers, sent } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "PROJECT RECHECK");
		handlers.session_compact(compactEvent(), { cwd });
		assert.equal(sent[0].message.content[0].text, "PROJECT ANCHOR");
	});
});

test("global assets used when no project-local", async () => {
	clearEnv();
	const home = makeHome({ assets: { "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" } });
	const cwd = enabledProject(); // no project assets
	await withHome(home, () => {
		const { handlers } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "GLOBAL RECHECK");
	});
});

test("bundled assets used as fallback", async () => {
	clearEnv();
	// Empty HOME (no global assets) and no project assets → bundled wins.
	const emptyHome = mkdtempSync(join(tmpdir(), "recheck-emptyhome-"));
	const cwd = enabledProject();
	await withHome(emptyHome, () => {
		const { handlers } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, bundledRecheck());
	});
});

test("PI_RECHECK_ASSETS_DIR takes priority over project and global", async () => {
	clearEnv();
	const home = makeHome({ assets: { "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" } });
	const cwd = enabledProject({ projectAssets: { "recheck.md": "PROJECT RECHECK" } });
	const envDir = makeDirAssets({ "recheck.md": "ENV RECHECK", "anchor.md": "ENV ANCHOR" });
	process.env.PI_RECHECK_ASSETS_DIR = envDir;
	await withHome(home, () => {
		const { handlers } = setup();
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "ENV RECHECK");
	});
});

test("blank prompt files fall through the chain", () => {
	clearEnv();
	// An empty or whitespace-only asset file is treated as missing — the next
	// root (here the bundled files) answers, never a blank injection.
	const envDir = makeDirAssets({ "recheck.md": "", "anchor.md": "   \n\n" });
	process.env.PI_RECHECK_ASSETS_DIR = envDir;
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	const res = handlers.agent_before_settle(assistantSettle("blank-1"), { cwd });
	assert.ok(res && res.entries, "recheck must fire from the next root");
	assert.equal(res.entries[0].content[0].text, bundledRecheck());
	handlers.session_compact(compactEvent("blank-1"), { cwd });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.content[0].text, bundledAnchor());
});

test("missing prompt files stay silent even when enabled", async () => {
	clearEnv();
	// Copy the extension to a temp package whose bundled assets/ is EMPTY and
	// whose project/global dirs are empty, so no candidate holds recheck.md.
	const root = makeTempCopy({}); // empty assets dir
	const cwd = enabledProject();
	const emptyHome = mkdtempSync(join(tmpdir(), "recheck-home-empty-"));
	try {
		await withHome(emptyHome, async () => {
			// Load the copied module so its import.meta.dirname points into root.
			const { default: copyHooks } = await import(join(root, "pi-extension", "index.ts"));
			const h = makePi();
			copyHooks(h.pi);
			const res = h.handlers.agent_before_settle(assistantSettle(), { cwd });
			assert.ok(!res || !res.entries, "recheck must stay silent when file missing");
			h.handlers.session_compact(compactEvent(), { cwd });
			assert.equal(h.sent.length, 0, "anchor must stay silent when file missing");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ===================== Requirement: /recheck command =====================

test("/recheck on|off rewrites settings.json and the hooks follow it", async () => {
	clearEnv();
	const cwd = makeProject(); // no settings.json yet
	const { handlers, commands } = setup();
	const notes: string[] = [];
	const ctx = { cwd, ui: { notify: (m: string) => notes.push(m) } };

	const settingsPath = join(cwd, ".pi", "pi-recheck-hook", "settings.json");
	await commands.recheck.handler("junk", ctx); // usage line, no file writes
	assert.ok(!existsSync(settingsPath), "unknown arg must not touch settings");

	await commands.recheck.handler("on", ctx);
	assert.equal(readFileSync(settingsPath, "utf8"), '{\n  "enabled": true\n}\n');
	const on = handlers.agent_before_settle(assistantSettle("cmd-on"), { cwd });
	assert.ok(on && on.entries, "after /recheck on the hooks must fire");

	await commands.recheck.handler("off", ctx);
	assert.equal(readFileSync(settingsPath, "utf8"), '{\n  "enabled": false\n}\n');
	const off = handlers.agent_before_settle(assistantSettle("cmd-off"), { cwd });
	assert.ok(!off || !off.entries, "after /recheck off the hooks must stay silent");
});

test("/recheck with a broken settings dir must not throw", async () => {
	clearEnv();
	const { commands } = setup();
	// /dev/null/x is under a non-directory — mkdir under it must fail into
	// the handler's catch. Never use /proc paths for this: mkdir under /proc
	// hangs this sandbox (observed: 90s timeout on exactly that case).
	const ctx = { cwd: join("/dev/null", "x") };
	await commands.recheck.handler("", ctx);
	await commands.recheck.handler("on", ctx);
});

// ===================== Pinned pi 1.2.0 contract (re-verify on pi bump) =====================
//
// These are the exact names and shapes the extension relies on, verified against
// the installed pi 1.2.0 (core/extensions/types.d.ts):
//   ExtensionAPI.on("agent_before_settle", ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>)
//   ExtensionAPI.on("session_compact",     ExtensionHandler<SessionCompactEvent>)
//   AgentBeforeSettleEvent extends BoundaryState { entries, continue, context, outcome }
//   AgentBeforeSettleEventResult = { entries?: SessionBoundaryDraft[]; continue?: boolean }
//   SessionBoundaryDraft ⊇ CustomMessageEntryDraft { type:"custom_message", customType, content, display, details? }
//   SessionCompactEvent { compactionEntry, fromExtension, reason, willRetry }
//   sendMessage(msg: { customType, content, display, details? }, { triggerTurn?, deliverAs? })
//   ExtensionHandler = (event, ctx: { cwd, ... }) => R | void
// If pi renames any of these, this test (and the extension) must be updated together.

const PI_SETTLE_EVENT = "agent_before_settle";
const PI_COMPACT_EVENT = "session_compact";

// A synthesized settle event carrying exactly the fields the extension reads from
// the pi 1.2.0 event. Pin the field names so a pi rename is caught here.
function contractSettleEvent() {
	return {
		type: PI_SETTLE_EVENT,        // pi: "agent_before_settle"
		continue: false,              // pi: BoundaryState.continue
		outcome: "completed",         // pi: AgentActivityOutcome
		context: {                    // pi: BoundaryContextPreview
			contextEntries: [          // pi: ProjectedSessionEntry[]
				{ sourceEntry: { id: "e1", type: "message" },   // pi: SessionEntry { id, type }
				  messages: [                                  // pi: AgentMessage[]
				    { role: "user", content: [{ type: "text", text: "q" }] },
				    { role: "assistant", content: [{ type: "text", text: "a" }] },
				  ] },
			],
			contextMessages: [{ role: "user", content: [{ type: "text", text: "q" }] }], // pi: AgentMessage[]
			canContinue: false,        // pi: BoundaryContextPreview.canContinue
		},
	};
}

test("contract: factory registers exactly the two pi event names", () => {
	clearEnv();
	const { handlers } = setup();
	const registered = Object.keys(handlers).sort();
	assert.deepEqual(registered, [PI_COMPACT_EVENT, PI_SETTLE_EVENT].sort());
});

test("contract: recheck result matches AgentBeforeSettleEventResult / CustomMessageEntryDraft", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers } = setup();
	const res = handlers[PI_SETTLE_EVENT](contractSettleEvent(), { cwd });
	// AgentBeforeSettleEventResult = { entries?: SessionBoundaryDraft[]; continue?: boolean }
	assert.equal(typeof res.continue, "boolean");
	assert.ok(Array.isArray(res.entries));
	for (const draft of res.entries) {
		// CustomMessageEntryDraft { type:"custom_message", customType, content, display, details? }
		assert.equal(draft.type, "custom_message");
		assert.equal(typeof draft.customType, "string");
		assert.ok(Array.isArray(draft.content) || typeof draft.content === "string");
		assert.equal(typeof draft.display, "boolean");
	}
});

test("contract: anchor sendMessage message matches Pick<CustomMessage,...> + triggerTurn pinned", () => {
	clearEnv();
	const cwd = enabledProject();
	const { handlers, sent } = setup();
	handlers[PI_COMPACT_EVENT](
		{ type: PI_COMPACT_EVENT, compactionEntry: { id: "c1" }, fromExtension: false, reason: "manual", willRetry: false },
		{ cwd },
	);
	assert.equal(sent.length, 1);
	const msg = sent[0].message;
	// sendMessage message: { customType, content, display, details? }
	assert.equal(typeof msg.customType, "string");
	assert.ok(Array.isArray(msg.content));
	assert.equal(typeof msg.display, "boolean");
	// options: { triggerTurn? } — must be explicitly false (history-only append)
	assert.equal(sent[0].options?.triggerTurn, false);
});
