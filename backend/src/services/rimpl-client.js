const RIMPL_URL = process.env.RIMPL_URL || 'http://localhost:3003';

async function rimplChat({ ple_id, history, message, language }) {
  const res = await fetch(`${RIMPL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ple_id, history, message, language }),
  });
  if (!res.ok) throw new Error(`RIMPL /chat error: ${res.status}`);
  return res.json();
}

async function rimplEvaluate({ ple_id, transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ple_id, transcript }),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate error: ${res.status}`);
  return res.json();
}

async function rimplEvaluateCriteria({ transcript }) {
  const res = await fetch(`${RIMPL_URL}/evaluate-criteria`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript }),
  });
  if (!res.ok) throw new Error(`RIMPL /evaluate-criteria error: ${res.status}`);
  return res.json();
}

module.exports = { rimplChat, rimplEvaluate, rimplEvaluateCriteria };
