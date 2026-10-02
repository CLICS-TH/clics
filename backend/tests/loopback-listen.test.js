// Guards the jest `setupFiles` shim (tests/helpers/loopback-listen.js) that stops a stray process on the
// box from answering supertest's requests. See that file for the macOS port-collision it prevents.
//
// The bug is probabilistic (a foreign listener has to own the port the kernel hands out), so a test of
// the symptom would itself be flaky. These tests pin the DETERMINISTIC property that removes it: a
// host-less ephemeral listen binds 127.0.0.1 — the address the client dials — not the `::` wildcard.
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');

const listening = (server, ...args) => new Promise((resolve) => server.listen(...args, () => resolve(server.address())));
const closed = (server) => new Promise((resolve) => server.close(resolve));

test('supertest\'s own host-less listen(0) is served from 127.0.0.1, not the :: wildcard', async () => {
  const app = express();
  app.get('/who', (req, res) => res.json({ local: req.socket.localAddress }));
  const res = await request(app).get('/who');
  // Bound to `::` this reads '::ffff:127.0.0.1' (a dual-stack socket); bound to 127.0.0.1 it is plain IPv4.
  expect(res.body.local).toBe('127.0.0.1');
});

// Starts a server with the given listen() arguments, hands its address to `check`, and ALWAYS closes it
// (a failed assertion must not leave a listener open and hang jest instead of reporting the failure).
async function withServer(listenArgs, check) {
  const server = http.createServer();
  try {
    const addr = await listening(server, ...listenArgs);
    await check(addr);
  } finally {
    await closed(server);
  }
}

test('listen(0, cb) and listen({ port: 0 }) bind 127.0.0.1', async () => {
  await withServer([0], (addr) => expect(addr.address).toBe('127.0.0.1'));
  await withServer([{ port: 0 }], (addr) => expect(addr.address).toBe('127.0.0.1'));
});

test('the address is available synchronously after listen() — supertest reads .port on the next line', () => {
  const server = http.createServer();
  try {
    server.listen(0);
    expect(server.address()).toEqual(expect.objectContaining({ address: '127.0.0.1', port: expect.any(Number) }));
  } finally {
    server.close();
  }
});

test('a caller that names its own host or port is left alone', async () => {
  let port;
  await withServer([0, '127.0.0.1'], (addr) => { port = addr.port; expect(addr.address).toBe('127.0.0.1'); });
  // An explicit port must not be rewritten to an ephemeral one, and an explicit host must be honoured.
  await withServer([{ port, host: '127.0.0.1' }], (addr) => expect(addr.port).toBe(port));
});

test('the rimpl copy of the shim is byte-identical (the packages deploy separately, so it is duplicated)', () => {
  const mine = fs.readFileSync(path.join(__dirname, 'helpers/loopback-listen.js'), 'utf8');
  const theirs = fs.readFileSync(path.join(__dirname, '../../rimpl/tests/helpers/loopback-listen.js'), 'utf8');
  expect(theirs).toBe(mine);
});
