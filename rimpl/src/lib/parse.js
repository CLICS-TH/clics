// Extract the first JSON object from an LLM text response.
// Matches the original inline behaviour: no JSON found -> {} (not an error);
// malformed JSON -> JSON.parse throws (callers map that to a 502).
function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : '{}');
}

module.exports = { parseJsonObject };
