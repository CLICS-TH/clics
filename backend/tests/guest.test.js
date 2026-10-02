// RIMPL is mocked so guest tests never hit the network and we can assert the cap.
jest.mock('../src/services/rimpl-client', () => ({
  rimplChat: jest.fn(async () => ({
    content: 'Per guidelines (ACC/AHA, 2024) ...', refs: [{ source: 'ACC/AHA' }],
    socratic_question: 'What is your differential?', token_count: 12,
  })),
}));

const express = require('express');
const request = require('supertest');
const { rimplChat } = require('../src/services/rimpl-client');
const { startGuestSession, verifyGuestToken, consumeGuestPrompt, GUEST_HOURLY_PROMPT_CAP, _resetGuestBudget } = require('../src/lib/guest');

const app = express();
app.use(express.json());
app.use('/guest', require('../src/routes/guest'));

describe('guest token (lib/guest)', () => {
  test('a fresh token verifies to its session id', () => {
    const { token, session_id } = startGuestSession();
    expect(verifyGuestToken(token)?.sessionId).toBe(session_id);
  });

  test('a tampered signature is rejected', () => {
    const { token } = startGuestSession();
    const [a, b] = token.split('.');
    expect(verifyGuestToken(`${a}.${b}.${'x'.repeat(43)}`)).toBeNull();
  });

  test('an expired token is rejected', () => {
    const t0 = 1_000_000;
    const { token } = startGuestSession(t0);
    expect(verifyGuestToken(token, t0 + 31 * 60 * 1000)).toBeNull();
  });

  test('the 2-prompt cap is enforced', () => {
    const { session_id } = startGuestSession();
    expect(consumeGuestPrompt(session_id).ok).toBe(true);
    const second = consumeGuestPrompt(session_id);
    expect(second.ok).toBe(true);
    expect(second.session_ended).toBe(true);
    expect(consumeGuestPrompt(session_id)).toEqual({ ok: false, reason: 'ended' });
  });
});

describe('guest route', () => {
  test('start → 2 prompts → 3rd is blocked, and nothing is persisted (no DB import)', async () => {
    const start = await request(app).post('/guest/start');
    expect(start.status).toBe(201);
    const token = start.body.token;
    expect(token).toBeTruthy();

    const m1 = await request(app).post('/guest/message')
      .set('Authorization', `Bearer ${token}`).send({ message: 'q1' });
    expect(m1.status).toBe(200);
    expect(m1.body.content).toContain('2024');
    expect(m1.body.prompts_remaining).toBe(1);
    expect(m1.body.session_ended).toBe(false);

    const m2 = await request(app).post('/guest/message')
      .set('Authorization', `Bearer ${token}`).send({ message: 'q2' });
    expect(m2.status).toBe(200);
    expect(m2.body.session_ended).toBe(true);

    const m3 = await request(app).post('/guest/message')
      .set('Authorization', `Bearer ${token}`).send({ message: 'q3' });
    expect(m3.status).toBe(403);
    expect(m3.body.reason).toBe('ended');

    // The guest router never imports the DB client — its only dependency is rimplChat.
    expect(rimplChat).toHaveBeenCalledTimes(2);
  });

  test('a missing/invalid guest token is 401', async () => {
    const r = await request(app).post('/guest/message')
      .set('Authorization', 'Bearer not.a.token').send({ message: 'x' });
    expect(r.status).toBe(401);
  });

  // The client holds and replays the history, so each item is attacker-sized input to RIMPL's PII
  // filter (review of PR #114). Over the cap is a 400 that never reaches RIMPL; a long but legitimate
  // assistant reply (one chat reply can run far past 5000 chars) still goes through.
  test('an over-length history item is a 400 and never reaches RIMPL; a long real reply is accepted', async () => {
    const { token } = (await request(app).post('/guest/start')).body;
    rimplChat.mockClear();
    const tooLong = await request(app).post('/guest/message').set('Authorization', `Bearer ${token}`)
      .send({ message: 'q', history: [{ role: 'assistant', content: 'ก'.repeat(24001) }] });
    expect(tooLong.status).toBe(400);
    expect(rimplChat).not.toHaveBeenCalled();

    const longReply = await request(app).post('/guest/message').set('Authorization', `Bearer ${token}`)
      .send({ message: 'q', history: [{ role: 'assistant', content: 'ก'.repeat(12000) }] });
    expect(longReply.status).toBe(200);
  });
});

describe('guest aggregate AI-spend brake (F2)', () => {
  test('total prompts across fresh sessions are capped at GUEST_HOURLY_PROMPT_CAP', () => {
    _resetGuestBudget();
    let consumed = 0, capped = false;
    // Mint unlimited fresh sessions (each free) and spend until the GLOBAL ceiling trips — proving
    // the per-session 2-prompt cap is no longer the only bound on guest Claude spend.
    for (let i = 0; i < GUEST_HOURLY_PROMPT_CAP + 50 && !capped; i++) {
      const { session_id } = startGuestSession();
      for (let j = 0; j < 2; j++) {
        const r = consumeGuestPrompt(session_id);
        if (r.ok) consumed++;
        else if (r.reason === 'global_cap') { capped = true; break; }
      }
    }
    expect(capped).toBe(true);
    expect(consumed).toBe(GUEST_HOURLY_PROMPT_CAP);
    _resetGuestBudget(); // don't starve other suites
  });
});

describe('guest response is a whitelist', () => {
  test("rimpl's provenance never reaches the guest's browser", async () => {
    rimplChat.mockResolvedValueOnce({
      content: 'reply (ACC/AHA, 2024)', refs: [], socratic_question: null, token_count: 5,
      provider: 'local', model: 'deepseek-v4-flash-dspark', prompt_version: 'chat-prompt-1a2b3c4d',
    });
    const start = await request(app).post('/guest/start');
    const r = await request(app).post('/guest/message')
      .set('Authorization', `Bearer ${start.body.token}`).send({ message: 'q' });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('reply (ACC/AHA, 2024)');
    for (const k of ['provider', 'model', 'prompt_version']) expect(r.body).not.toHaveProperty(k);
  });
});
