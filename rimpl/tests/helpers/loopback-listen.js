// jest `setupFiles` entry: make every kernel-assigned test server bind to IPv4 loopback.
//
// WHY. supertest starts the app with `http.createServer(app).listen(0)` — no host, so Node binds the
// dual-stack wildcard `::` — and then dials `http://127.0.0.1:<port>`. On macOS the kernel does NOT
// treat a wildcard bind on port P as conflicting with another PROCESS that already listens on
// 127.0.0.1:P (an explicit-port dev server, a vendor agent, a sibling worktree's test server …), so
// the "ephemeral" port it hands out can be one that process owns. The test's request is then answered
// by that stranger: a 401/302/501 with a body the route never produced, or "socket hang up". It is
// rare per request (~ foreign-ports / 16k) but a suite makes thousands of requests, so a run fails now
// and then, on a different test each time, and passes on rerun. Nothing in the app or the mock is at
// fault.
//
// Measured on the dev box with 3500 foreign explicit-port listeners on 127.0.0.1: 10 000 wildcard
// `listen(0)` landed on a foreign port 2014 times (≈ the 2136 expected if the kernel were blind to
// them); 10 000 `listen(0, '127.0.0.1')` landed on one 0 times. Binding the same address the client
// dials makes the kernel's conflict check see them.
//
// WHAT. Only a host-less ephemeral listen is rewritten — `listen(0[, cb])` and `listen({ port: 0 })` —
// which is exactly what supertest does. A caller that names a host (rimpl's tests bind 127.0.0.1
// themselves) or a fixed port is left alone. A test server reachable only from this machine is the
// right default anyway.
//
// HOW. supertest reads `server.address().port` on the line AFTER `listen(0)`, so the bind must be
// synchronous. `listen(0, '127.0.0.1')` is not (Node resolves the host first, on the next tick), so we
// bind a TCP handle ourselves with net._createServerHandle and hand it to the real `listen`. That
// helper is underscore-prefixed Node API; if a Node upgrade ever removes it the shim falls back to the
// stock behaviour and backend/tests/loopback-listen.test.js fails loudly instead of the suite going
// flaky again.
//
// rimpl/tests/helpers/loopback-listen.js is a byte-identical copy (the packages deploy separately);
// the test above also fails if the two drift.
const net = require('net');

const LOOPBACK = '127.0.0.1';
const PATCHED = Symbol.for('clics.tests.loopbackListen');

// A TCP handle already bound to 127.0.0.1 on a kernel-assigned port, or null if that is unavailable.
function loopbackHandle() {
  if (typeof net._createServerHandle !== 'function') return null;
  const handle = net._createServerHandle(LOOPBACK, 0, 4);
  return typeof handle === 'object' && handle !== null ? handle : null; // a number is an errno
}

if (!net.Server.prototype.listen[PATCHED]) {
  const realListen = net.Server.prototype.listen;
  const isEphemeralPort = (p) => p === 0 || p === '0';
  const listen = function listen(...args) {
    const [first] = args;
    const hostless = (isEphemeralPort(first) && typeof args[1] !== 'string') // a string in args[1] is a host
      || (first && typeof first === 'object' && !Array.isArray(first) && isEphemeralPort(first.port)
        && Object.keys(first).length === 1);
    if (hostless) {
      const handle = loopbackHandle();
      // listen(0[, backlog][, cb]) | listen({ port: 0 }[, cb]) -> listen(handle[, backlog][, cb])
      if (handle) args[0] = handle;
    }
    return realListen.apply(this, args);
  };
  listen[PATCHED] = true;
  net.Server.prototype.listen = listen;
}
