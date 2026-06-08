// Single source of truth for Claude token pricing -> USD cost.
// Defaults are the published claude-sonnet-4-6 rates ($/1M tokens); override via env if the
// model or pricing changes (CLAUDE_INPUT_PER_M / CLAUDE_OUTPUT_PER_M).
const INPUT_PER_M = parseFloat(process.env.CLAUDE_INPUT_PER_M || '3');
const OUTPUT_PER_M = parseFloat(process.env.CLAUDE_OUTPUT_PER_M || '15');

// Cost in USD for a call that billed `inputTokens` input + `outputTokens` output.
function costUsd(inputTokens = 0, outputTokens = 0) {
  const inT = Number(inputTokens) || 0;
  const outT = Number(outputTokens) || 0;
  return (inT / 1e6) * INPUT_PER_M + (outT / 1e6) * OUTPUT_PER_M;
}

module.exports = { INPUT_PER_M, OUTPUT_PER_M, costUsd };
