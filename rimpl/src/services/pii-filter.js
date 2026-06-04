const PATTERNS = [
  { re: /\b(?:HN:|HN)\s*:?\s*\d{5,10}\b/gi,    rep: '[HN]' },
  { re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,       rep: '[DATE]' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/g,               rep: '[DATE]' },
  { re: /\b(?:ward|ห้อง)\s+[A-Za-z0-9]+\b/gi,   rep: '[WARD]' },
];

function stripPii(text) {
  return PATTERNS.reduce((t, { re, rep }) => t.replace(re, rep), text);
}

function stripHistoryPii(history) {
  return history.map(msg => ({ ...msg, content: stripPii(msg.content) }));
}

module.exports = { stripPii, stripHistoryPii };
