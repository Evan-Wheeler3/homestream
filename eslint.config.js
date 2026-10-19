import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'data', 'playwright-report', 'test-results', '.wrangler'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/client/**/*.{ts,tsx,js}', 'tests/client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: [
      'src/server/**/*.ts',
      'scripts/**/*.mjs',
      'tests/**/*.ts',
      'e2e/**/*.ts',
      '*.config.{js,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Command-line stand-ins for MakeMKV/HandBrake used by the browser tests.
    files: ['e2e/fixtures/**/*.cjs'],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
