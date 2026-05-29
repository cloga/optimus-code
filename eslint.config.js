// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'out/**',
      'node_modules/**',
      'optimus-plugin/**',
      '.optimus/**',
      'test-ipc/**',
      'scripts/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Pragmatic baseline for a large, fast-moving codebase. These surface
      // real bugs without drowning the team in stylistic noise. Tighten over time.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      // Initial eslint adoption on a large existing codebase: surface these as
      // warnings (many are legitimate, e.g. declare-then-assign timer handles or
      // intentionally readable regex escapes). Promote to 'error' over time.
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      // ANSI/terminal handling legitimately matches control characters.
      'no-control-regex': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
