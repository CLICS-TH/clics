function hasCitation(content) {
  return /\([^)]+,\s*\d{4}[^)]*\)/.test(content);
}

function extractSocraticQuestion(content) {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('❓')) return line.replace(/^❓\s*/, '');
  }
  return null;
}

function extractReferences(content) {
  const refs = [];
  const pattern = /\(([^)]+,\s*\d{4}[^)]*)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.push({ source: match[1].trim(), title: match[1].split(',')[0].trim() });
  }
  return refs;
}

module.exports = { hasCitation, extractSocraticQuestion, extractReferences };
