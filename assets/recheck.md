End-of-turn recheck. Review your last answer within five actions:
1. Every claim about code has a path:line link and you opened that place in this turn.
2. Every "no", "not called", "no tests" is backed by a search command; the command and its output are in the answer.
3. Numbers, hashes and test counts are copied from command output, not written from memory.
4. If you worked on a task, update this session's state file `.pi/pi-recheck-hook/<session id>/state.md` (create it on first write). If the session id in that path looks unresolved, list `.pi/pi-recheck-hook/` to find this session's directory and name the one you picked.
Found a discrepancy: fix the answer and say what you fixed. Ran out of the five actions: answer "Rechecked partially" and what you did not verify.
Everything matches: answer with the single line "Rechecked" and do nothing else.
