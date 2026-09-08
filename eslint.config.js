// Flat config. Strictness here is a gate, not a preference: rules that protect
// the product's correctness claims are errors, never warnings.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-web/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.tooling/**',
    ],
  },

  js.configs.recommended,

  // Typed linting applies to TypeScript sources only. Config and tooling files
  // are plain Node modules and are not part of the typed program.
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // Escape hatches must not be silent. If one is genuinely needed it has to
      // be argued in review, not slipped in.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^: .{10,}$' },
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'Token quantities are bigint base units; parseFloat cannot represent them (CLAUDE.md 4).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Randomness must be injected, never imported, so results stay reproducible.',
        },
      ],
      eqeqeq: ['error', 'always'],
    },
  },

  // Tests exercise rejection paths on purpose, so they deliberately pass values
  // the types forbid. That is the point of the test, not a lapse.
  {
    files: ['**/test/**/*.{ts,tsx}', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Repository tooling: plain Node scripts, untyped.
  {
    files: ['scripts/**/*.mjs', '**/*.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
      ecmaVersion: 2024,
    },
  },
);
