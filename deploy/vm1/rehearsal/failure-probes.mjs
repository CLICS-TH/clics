// Run by rehearsal/run.sh hermetic after the replay, with mailpit stopped, on the failure paths the replay never
// takes (#427 gate on PR #460). Inside the rehearsal network, with the backend's SUPABASE_URL and service key.
//   1. GoTrue fails to send a recovery mail to a synthetic account, so run.sh can then check that no log line
//      names the recipient (R5).
//   2. One client sending wrong codes to /verify and wrong passwords to /token gets a 429 from GoTrue itself.
//      The client is named by X-Real-IP, as the host's nginx sets it.
import { randomBytes } from 'node:crypto';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const addr = `log-probe-${randomBytes(4).toString('hex')}@rehearsal.invalid`;

const created = await fetch(`${SB}/auth/v1/admin/users`, {
  method: 'POST', headers,
  body: JSON.stringify({ email: addr, password: `Rh${randomBytes(9).toString('base64url')}7`, email_confirm: true }),
});
if (!created.ok) throw new Error(`failure probes: creating the account answered ${created.status}`);
const { id } = await created.json();
try {
  const r = await fetch(`${SB}/auth/v1/recover`, { method: 'POST', headers, body: JSON.stringify({ email: addr }) });
  // The control: unless the send failed, GoTrue had no error to log and the check below it proves nothing.
  if (r.status < 500) throw new Error(`failure probes: a recovery with no mail server answered ${r.status}, want a 5xx`);
  console.log(`[failure-probes] GoTrue failed a mail send (HTTP ${r.status})`);

  const client = { ...headers, 'x-real-ip': `probe-${randomBytes(4).toString('hex')}` };
  for (const [what, path, body] of [
    ['/verify, wrong codes', '/auth/v1/verify', () => ({ type: 'recovery', email: addr, token: '000000' })],
    ['/token, wrong passwords', '/auth/v1/token?grant_type=password', (i) => ({ email: addr, password: `wrong-${i}` })],
  ]) {
    const seen = {};
    for (let i = 0; i < 60 && !seen[429]; i++) {
      const res = await fetch(`${SB}${path}`, { method: 'POST', headers: client, body: JSON.stringify(body(i)) });
      await res.text();
      seen[res.status] = (seen[res.status] || 0) + 1;
    }
    if (!seen[429]) throw new Error(`failure probes: 60 tries at ${what} from one client got no 429 (${JSON.stringify(seen)})`);
    console.log(`[failure-probes] ${what}: 429 after ${JSON.stringify(seen)}`);
  }
} finally {
  await fetch(`${SB}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers });
}
