/** @type {import('jest').Config} */
// Coverage ratchet (see backend/jest.config.js). Thresholds sit a few points below current measured
// coverage over src/** — incl. the PII-boundary + adversarial-leak paths. Enforced with --coverage in CI.
module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { statements: 78, branches: 62, functions: 83, lines: 81 },
  },
};
