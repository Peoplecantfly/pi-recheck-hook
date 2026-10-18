End-of-turn recheck. Review your last answer within five actions:
1. Every claim about code has a path:line link and you opened that place in this turn.
2. Every "no", "not called", "no tests" is backed by a search command; the command and its output are in the answer.
3. Numbers, hashes and test counts are copied from command output, not written from memory.
4. If you worked on a task, update the state file `.pi/pi-recheck-hook/state.md` (create it on first write). It is shared by all agents in this project: re-read it before writing, then update only your own section — one `## <agent name>` section per agent (main session: `## main`) — never rewrite other sections or the whole file.
Found a discrepancy: fix the answer and say what you fixed. Ran out of the five actions: answer "Rechecked partially" and what you did not verify.
Everything matches: answer with the single line "Rechecked" and do nothing else.
