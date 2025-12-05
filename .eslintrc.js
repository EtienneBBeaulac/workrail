module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    // ==========================================================================
    // ERRORS - Critical issues that must be fixed
    // ==========================================================================
    'no-var': 'error',

    // ==========================================================================
    // WARNINGS - Should fix but don't fail CI (gradual improvement)
    // ==========================================================================
    'prefer-const': 'warn',
    
    // TypeScript-specific
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-var-requires': 'warn', // Legacy code uses require()
    '@typescript-eslint/ban-ts-comment': 'warn',   // Some files need @ts-nocheck

    // ==========================================================================
    // DISABLED - Not applicable or too noisy for this codebase
    // ==========================================================================
    'no-case-declarations': 'off',
    'no-constant-condition': 'off',
    'no-empty': 'off',              // Empty catch blocks are intentional sometimes
    'no-useless-escape': 'off',     // Regex escapes can be noisy
    'no-prototype-builtins': 'off', // hasOwnProperty pattern is fine
    '@typescript-eslint/naming-convention': 'off',
  },
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.js',
    '!.eslintrc.js',
  ],
};
