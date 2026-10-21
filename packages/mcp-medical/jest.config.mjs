import { maxWorkers } from '../../config/jest.workers.cjs';

export default {
  collectCoverageFrom: ['src/**/*.{js,ts}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/scripts/'],
  coverageReporters: ['text', 'cobertura'],
  testResultsProcessor: 'jest-junit',
  transform: {
    // The evaluation harness under eval/ is plain .mjs so it can run with node
    // directly, without a build step. It is still covered by the suite, so the
    // grader cannot quietly stop grading.
    '\\.m?[jt]sx?$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    // Source uses NodeNext-style './x.js' specifiers, which resolve to './x.ts' on disk.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFiles: ['<rootDir>/../../config/jest.setup.logging.cjs'],
  maxWorkers,
  restoreMocks: true,
  testTimeout: 20000,
};
