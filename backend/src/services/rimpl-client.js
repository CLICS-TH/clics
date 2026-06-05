const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';

async function rimplChat({ ple_id, history, message, language, chief_complaint }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ ple_id, history, message, language, chief_complaint }),
    signal: AbortSignal.timeout(75000), // chat may make up to 2 Claude calls (initial + citation retry)
  });
  if (!res.ok) throw new Error(`RIMPL /chat error: ${res.status}`);
  return res.json();
}

async function rimplEvaluate({ ple_id, transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ ple_id, transcript }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate error: ${res.status}`);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '' },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate-criteria error: ${res.status}`);
  return res.json();
}

module.exports = { rimplChat, rimplEvaluate, rimplEvaluateCriteria };
