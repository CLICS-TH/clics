/** @type {import('jest').Config} */
// Coverage ratchet: thresholds sit a few points below the current measured coverage over src/** so a
// regression (or a new untested module) fails CI, without forcing net-new tests right now. Raise these
// as coverage improves; never lower them silently. Enforced when run with --coverage (see CI).
module.exports = {
  testEnvironment: 'node',
  // Bind supertest's host-less `listen(0)` to 127.0.0.1 so a stray process on the box cannot answer our
  // requests (see tests/helpers/loopback-listen.js for the macOS port-collision it prevents).
  setupFiles: ['<rootDir>/tests/helpers/loopback-listen.js'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { statements: 52, branches: 41, functions: 48, lines: 58 },
  },
};
