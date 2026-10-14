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
    'lib/settings-patch.ts',
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
    'components/AiProviderPanel.tsx',
  ],
  coverageThreshold: {
    global: { statements: 100, branches: 90, functions: 100, lines: 100 },
  },
};

// react-markdown and the unified/remark/micromark tree under it ship ONLY as ES modules, which jest will
// not parse from node_modules. next/jest installs its own transformIgnorePatterns, so replace them
// after it has resolved: transform these packages, ignore the rest of node_modules as before. This is
// what lets Markdown.test.tsx run the REAL renderer instead of a mock that would test nothing.
const ESM_PACKAGES = [
  'react-markdown', 'remark-[^/]+', 'rehype-[^/]+', 'unified', 'bail', 'devlop', 'trough', 'vfile[^/]*',
  'unist-[^/]+', 'mdast-[^/]+', 'micromark[^/]*', 'hast-[^/]+', 'html-url-attributes', 'property-information',
  'space-separated-tokens', 'comma-separated-tokens', 'decode-named-character-reference',
  'character-entities[^/]*', 'trim-lines', 'ccount', 'markdown-table', 'zwitch', 'longest-streak',
  'is-plain-obj', 'escape-string-regexp', 'stringify-entities', 'estree-util-[^/]+',
].join('|');

module.exports = async () => {
  const resolved = await createJestConfig(config)();
  resolved.transformIgnorePatterns = [
    `/node_modules/(?!(?:\\.pnpm/)?(?:${ESM_PACKAGES})/)`,
    '^.+\\.module\\.(css|sass|scss)$',
  ];
  return resolved;
};
