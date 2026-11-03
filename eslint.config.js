// SPDX-License-Identifier: AGPL-3.0-or-later
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'vendor/**', 'dist/**', 'test/shots/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
