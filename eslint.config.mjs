// Flat config for ESLint 10.
// TypeScript ESLint is intentionally NOT added here: no typescript-eslint
// version was supplied in the pinned list, so adding an unpinned version
// would invent a dependency. This config lints JS/MJS/CJS files with the
// bundled @eslint/js rules. TypeScript correctness is enforced by
// `npm run typecheck` in each workspace.
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    files: ['apps/api/test/*.cjs'],
    languageOptions: { globals: { require: 'readonly' } },
  },
  {
    // Service worker: declare its globals explicitly (no new dependency).
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
];
