'use strict';

// A loopback stand-in for PostgREST, read side only, for the readiness tests: GET /rest/v1/<table> with
// eq. and in. filters and order=<col>.asc|desc over in-memory tables. Every write answers 405 and is
// counted in state.writes, so a test can assert the command wrote nothing.
const http = require('http');

function matches(row, col, expr) {
  const v = String(row[col]);
  if (expr.startsWith('eq.')) return v === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(') && expr.endsWith(')')) {
    return expr.slice(4, -1).split(',').map((s) => decodeURIComponent(s).replace(/^"|"$/g, '')).includes(v);
  }
  return true;
}

function startFakePostgrest(tables = {}) {
  const state = { tables, writes: 0, reads: 0 };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const send = (status, body) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
        res.end(data);
      };
      const url = new URL(req.url, 'http://fake');
      const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (!m) return send(404, { message: 'not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') { state.writes += 1; return send(405, { message: 'read only' }); }
      state.reads += 1;
      let rows = [...(state.tables[m[1]] || [])];
      let order = null;
      for (const [k, v] of url.searchParams) {
        if (k === 'select' || k === 'limit' || k === 'offset') continue;
        if (k === 'order') { order = v; continue; }
        rows = rows.filter((r) => matches(r, k, v));
      }
      if (order) {
        const [col, dir] = order.split('.');
        rows.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      send(200, rows);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state, port, url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

// One sandbox council with two fictional PLEs; the second is the longer one.
function sandboxTables() {
  const turn = (ple, i, role, content) => ({ ple_id: ple, role, content, created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z` });
  return {
    councils: [{ id: 'c-sbx', code: 'SANDBOX' }, { id: 'c-other', code: 'TMC' }],
    ples: [
      { id: 'p-short', council_id: 'c-sbx', chief_complaint: 'fictional sore throat case' },
      { id: 'p-long', council_id: 'c-sbx', chief_complaint: 'fictional chest pain case for testing' },
      { id: 'p-other', council_id: 'c-other', chief_complaint: 'not sandbox' },
    ],
    messages: [
      turn('p-short', 1, 'physician', 'Fictional question about a sore throat in this test case.'),
      turn('p-long', 1, 'physician', 'Fictional question one about chest pain triage in this test case.'),
      turn('p-long', 2, 'assistant', 'Fictional answer one about troponin timing for this test case (ESC, 2023).'),
      turn('p-long', 3, 'physician', 'Fictional follow-up about the HEART score in this test case.'),
      turn('p-other', 1, 'physician', 'A much longer message in another council that must never be chosen '.repeat(20)),
    ],
  };
}

module.exports = { startFakePostgrest, sandboxTables };
