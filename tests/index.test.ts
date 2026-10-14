// Tests for pi-recheck-hook. Drive the handlers directly by registering them
// on a fake ExtensionAPI, then invoke them with synthesized events. Import
// the extension from ../pi-extension/; load prompt text from ../assets/ to
// compare verbatim.
//
// Resolution chain under test (per file): PI_RECHECK_ASSETS_DIR (if set) →
// <cwd>/.pi/pi-recheck-hook/assets → ~/.pi/agent/extension-data/.../assets →
// bundled <module>/../assets. First location that contains the file wins.
//
// Note: the real extension's bundled dir always holds recheck.md/anchor.md,
// so "project overrides global/bundled", "global when no project", and
// "bundled fallback" are all reachable directly. To reach the "missing file
// stays silent" case we copy the extension into a temp dir whose sibling
// assets/ is empty, so no candidate holds the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import recheckHooks from "../pi-extension/index.ts";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const RECHECK_BUNDLED = join(REPO_ROOT, "assets", "recheck.md");
const ANCHOR_BUNDLED = join(REPO_ROOT, "assets", "anchor.md");

const bundledRecheck = () => readFileSync(RECHECK_BUNDLED, "utf8");
const bundledAnchor = () => readFileSync(ANCHOR_BUNDLED, "utf8");

// ---- Harness: a fake ExtensionAPI that records handlers + sendMessage. ----

function makePi() {
	/** @type {Record<string, Function>} */
	const handlers = {};
	/** @type {Array<{message: any, options: any}>} */
	const sent = [];
	return {
		handlers,
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
		},
	};
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

/** Clear every env marker so each test starts from a known baseline. */
function clearEnv() {
	delete process.env.PI_RECHECK;
	delete process.env.PI_RECHECK_ASSETS_DIR;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_ID;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_AGENT;
}

/**
 * Create a temp project dir. `taskFile` creates the task workspace; `root`
 * picks which task root is used — "" for `tasks/factory/00-obshchee.md`
 * (repo root layout), "workshop" for `workshop/tasks/factory/00-obshchee.md`
 * (workshop-only layout). With `projectAssets` it also holds
 * .pi/pi-recheck-hook/assets/<name>. Returns cwd to use as ctx.cwd.
 */
function makeProject({ taskFile = true, root = "", projectAssets = null } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "recheck-proj-"));
	if (taskFile) {
		const dir = join(cwd, root, "tasks", "factory");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "00-obshchee.md"), "# obshchee\n");
	}
	if (projectAssets) {
		const dir = join(cwd, ".pi", "pi-recheck-hook", "assets");
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(projectAssets)) writeFileSync(join(dir, name), text);
	}
	return cwd;
}

/**
 * Build a fake HOME whose global extension-data assets contain `assets`.
 * Return the home dir to point process.env.HOME at.
 */
function makeGlobalAssets(assets) {
	const home = mkdtempSync(join(tmpdir(), "recheck-home-"));
	const dir = join(home, ".pi", "agent", "extension-data", "pi-recheck-hook", "assets");
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(assets)) writeFileSync(join(dir, name), text);
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

// ===================== Requirement: End-of-turn recheck prompt =====================

test("recheck fires after a normal answer", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(res, "handler returned nothing");
	assert.equal(res.entries.length, 1);
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
	assert.equal(res.entries[0].content[0].text, bundledRecheck());
	assert.equal(res.continue, true);
});

test("recheck only once per turn (same entry id twice)", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	const first = handlers.agent_before_settle(assistantSettle("same"), { cwd });
	assert.ok(first.entries);
	const second = handlers.agent_before_settle(assistantSettle("same"), { cwd });
	assert.ok(!second || !second.entries, "second run must emit no entry");
});

test("recheck skipped after compaction/branch_summary entry", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	for (const type of ["compaction", "branch_summary"]) {
		const ev = assistantSettle(`sum-${type}`);
		ev.context.contextEntries[0].sourceEntry.type = type;
		const res = handlers.agent_before_settle(ev, { cwd });
		assert.ok(!res || !res.entries, `must skip for ${type}`);
	}
});

test("recheck skipped after error/aborted outcome", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	for (const outcome of ["error", "aborted"]) {
		const ev = assistantSettle(`bad-${outcome}`);
		ev.outcome = outcome;
		const res = handlers.agent_before_settle(ev, { cwd });
		assert.ok(!res || !res.entries, `must skip for ${outcome}`);
	}
});

test("recheck disabled by PI_RECHECK=0", () => {
	clearEnv();
	process.env.PI_RECHECK = "0";
	const cwd = makeProject();
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(!res || !res.entries);
});

// ===================== Requirement: Post-compaction anchor prompt =====================

test("anchor injected after compaction, no continuation", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers, sent } = makePi();
	recheckHooks(pi);
	handlers.session_compact(compactEvent(), { cwd });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "pi-recheck:anchor");
	assert.equal(sent[0].message.content[0].text, bundledAnchor());
	// empty options => no triggerTurn
	assert.notEqual(sent[0].options?.triggerTurn, true);
});

test("anchor once per compaction (same id twice)", () => {
	clearEnv();
	const cwd = makeProject();
	const { pi, handlers, sent } = makePi();
	recheckHooks(pi);
	handlers.session_compact(compactEvent("samec"), { cwd });
	handlers.session_compact(compactEvent("samec"), { cwd });
	assert.equal(sent.length, 1);
});

// ===================== Requirement: Main-session-only with task files =====================

test("subagent sessions ignored (any PI_SUBAGENT_* set)", () => {
	clearEnv();
	const cwd = makeProject();
	for (const key of ["PI_SUBAGENT_SESSION", "PI_SUBAGENT_ID", "PI_SUBAGENT_NAME", "PI_SUBAGENT_AGENT"]) {
		clearEnv();
		process.env[key] = "1";
		const { pi, handlers, sent } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(`sub-${key}`), { cwd });
		assert.ok(!res || !res.entries, `recheck must skip when ${key} set`);
		handlers.session_compact(compactEvent(`sub-${key}`), { cwd });
		assert.equal(sent.length, 0, `anchor must skip when ${key} set`);
	}
});

test("foreign repository ignored (no task files)", () => {
	clearEnv();
	const cwd = makeProject({ taskFile: false });
	const { pi, handlers, sent } = makePi();
	recheckHooks(pi);
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(!res || !res.entries, "recheck must skip without task files");
	handlers.session_compact(compactEvent(), { cwd });
	assert.equal(sent.length, 0, "anchor must skip without task files");
});

test("workshop-only task root still triggers recheck (project-local override)", () => {
	clearEnv();
	// Only workshop/tasks/... exists — no top-level tasks/ dir.
	const cwd = makeProject({ root: "workshop", projectAssets: { "recheck.md": "WORKSHOP RECHECK" } });
	assert.ok(existsSync(join(cwd, "workshop", "tasks", "factory", "00-obshchee.md")));
	assert.ok(!existsSync(join(cwd, "tasks", "factory", "00-obshchee.md")), "project must not hold a top-level task file");
	const { pi, handlers } = makePi();
	recheckHooks(pi);
	const res = handlers.agent_before_settle(assistantSettle(), { cwd });
	assert.ok(res, "handler returned nothing");
	assert.equal(res.entries.length, 1);
	assert.equal(res.entries[0].customType, "pi-recheck:recheck");
	assert.equal(res.entries[0].content[0].text, "WORKSHOP RECHECK");
	assert.equal(res.continue, true);
});

// ===================== Requirement: Asset resolution chain =====================

test("project-local overrides global and bundled", async () => {
	clearEnv();
	const home = makeGlobalAssets({ "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" });
	const cwd = makeProject({ projectAssets: { "recheck.md": "PROJECT RECHECK", "anchor.md": "PROJECT ANCHOR" } });
	await withHome(home, () => {
		const { pi, handlers } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "PROJECT RECHECK");
	});
});

test("global used when no project-local", async () => {
	clearEnv();
	const home = makeGlobalAssets({ "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" });
	const cwd = makeProject(); // no project assets
	await withHome(home, () => {
		const { pi, handlers } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "GLOBAL RECHECK");
	});
});

test("bundled used as fallback", async () => {
	clearEnv();
	// Empty HOME (no global assets) and no project assets → bundled wins.
	const emptyHome = mkdtempSync(join(tmpdir(), "recheck-emptyhome-"));
	const cwd = makeProject();
	await withHome(emptyHome, () => {
		const { pi, handlers } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, bundledRecheck());
	});
});

test("PI_RECHECK_ASSETS_DIR takes priority over project and global", async () => {
	clearEnv();
	const home = makeGlobalAssets({ "recheck.md": "GLOBAL RECHECK", "anchor.md": "GLOBAL ANCHOR" });
	const cwd = makeProject({ projectAssets: { "recheck.md": "PROJECT RECHECK" } });
	const envDir = makeDirAssets({ "recheck.md": "ENV RECHECK", "anchor.md": "ENV ANCHOR" });
	process.env.PI_RECHECK_ASSETS_DIR = envDir;
	await withHome(home, () => {
		const { pi, handlers } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "ENV RECHECK");
	});
});

test("missing file stays silent", async () => {
	clearEnv();
	// Copy the extension to a temp package whose bundled assets/ is EMPTY and
	// whose project/global dirs are empty, so no candidate holds recheck.md.
	const root = makeTempCopy({}); // empty assets dir
	const cwd = makeProject();
	const emptyHome = mkdtempSync(join(tmpdir(), "recheck-home-empty-"));
	try {
		await withHome(emptyHome, async () => {
			// Load the copied module so its import.meta.dirname points into root.
			const { default: copyHooks } = await import(join(root, "pi-extension", "index.ts"));
			const { pi, handlers, sent } = makePi();
			copyHooks(pi);
			const res = handlers.agent_before_settle(assistantSettle(), { cwd });
			assert.ok(!res || !res.entries, "recheck must stay silent when file missing");
			handlers.session_compact(compactEvent(), { cwd });
			assert.equal(sent.length, 0, "anchor must stay silent when file missing");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Guard: sanity that none of the temp dirs accidentally exist as real
// task-file roots that would flip a "skip" assertion.
test("homedir override reaches the global candidate", async () => {
	clearEnv();
	const realHome = homedir();
	const home = makeGlobalAssets({ "recheck.md": "GLOBAL ONLY" });
	// With the override active, resolveAssets should pick GLOBAL ONLY.
	const cwd = makeProject();
	await withHome(home, () => {
		assert.notEqual(homedir(), realHome);
		const { pi, handlers } = makePi();
		recheckHooks(pi);
		const res = handlers.agent_before_settle(assistantSettle(), { cwd });
		assert.equal(res.entries[0].content[0].text, "GLOBAL ONLY");
	});
});
