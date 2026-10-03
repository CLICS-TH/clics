// next/jest wires the SWC transform, CSS/image/next-font mocks, .env loading and node_modules
// ignores for us (see node_modules/next/dist/docs/01-app/02-guides/testing/jest.md). We only add
// the jsdom env, the jest-dom matchers, and the `@/` path alias.
const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,tsx}'],
  // Coverage ratchet scoped to the units the suites are designed to cover (the dashboard is otherwise
  // largely untested by design). These files are fully tested — keep them that way. Enforced with
  // --coverage in CI. Add to this list (and add tests) as component coverage grows.
  collectCoverageFrom: [
    'lib/labels.ts',
    'lib/pis7-rubric.ts',
    'lib/chart-colors.ts',
    'lib/theme.ts',
    'components/ThemeProvider.tsx',
    'components/DomainScorer.tsx',
    'components/TranscriptView.tsx',
    'components/BiLabel.tsx',
    'components/RaterSpread.tsx',
    'app/manual/page.tsx',
    'lib/manual-lang.ts',
    'components/UsageMeter.tsx',
    'components/ConsistencyChip.tsx',
    'components/LocalAiCapacityCard.tsx',
  ],
  coverageThreshold: {
    global: { statements: 100, branches: 90, functions: 100, lines: 100 },
  },
};

module.exports = createJestConfig(config);
