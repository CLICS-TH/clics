/** @type {import('jest').Config} */
// Coverage ratchet (see backend/jest.config.js). Thresholds sit a few points below current measured
// coverage over src/** — incl. the PII-boundary + adversarial-leak paths. Enforced with --coverage in CI.
module.exports = {
  testEnvironment: 'node',
  // Bind supertest's host-less `listen(0)` to 127.0.0.1 so a stray process on the box cannot answer our
  // requests (see tests/helpers/loopback-listen.js for the macOS port-collision it prevents).
  setupFiles: ['<rootDir>/tests/helpers/loopback-listen.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { statements: 78, branches: 62, functions: 83, lines: 81 },
  },
};
