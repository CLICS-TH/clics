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
};

module.exports = createJestConfig(config);
