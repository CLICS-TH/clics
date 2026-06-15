/** @type {import('jest').Config} */
// Coverage ratchet: thresholds sit a few points below the current measured coverage over src/** so a
// regression (or a new untested module) fails CI, without forcing net-new tests right now. Raise these
// as coverage improves; never lower them silently. Enforced when run with --coverage (see CI).
module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: { statements: 52, branches: 41, functions: 48, lines: 58 },
  },
};
