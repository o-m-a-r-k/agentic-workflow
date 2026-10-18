// 0.7.30 (I-153): the one prompt the engine sends when it resumes a role whose launch the model's capacity ended. The role
// verifiers (claude-agent.mjs, codex-agent.mjs) accept it after the start prompt, as many times as the ledger records a
// resume, and nothing else: any other later prompt is still a resumed or steered round.
export const RESUME_PROMPT = 'The model was at capacity and your turn ended before you finished. Continue from where you stopped; your instructions and your handoff are unchanged.';
