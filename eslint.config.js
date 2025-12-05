import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import jestPlugin from 'eslint-plugin-jest';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Base JavaScript recommended config
  js.configs.recommended,
  
  // TypeScript files configuration
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      
      // General JS/TS rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': 'off', // Use TypeScript version instead
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],

      // Relaxed rules for this codebase
      '@typescript-eslint/no-explicit-any': 'warn', // Allow any but warn
      '@typescript-eslint/no-non-null-assertion': 'warn',
      
      // Naming-convention enforcement (see docs/naming-conventions.md)
      '@typescript-eslint/naming-convention': [
        'error',
        // Classes, interfaces, types, enums
        { 'selector': 'typeLike', 'format': ['PascalCase'] },
        // Variables, functions, parameters (camelCase, not UPPER_CASE)
        { 'selector': 'variableLike', 'format': ['camelCase'] },
        // Allow underscore prefix for unused parameters
        { 'selector': 'parameter', 'format': ['camelCase'], 'leadingUnderscore': 'allow' },
        // Module-level constants can be UPPER_CASE or camelCase
        { 
          'selector': 'variable', 
          'modifiers': ['const', 'global'], 
          'format': ['UPPER_CASE', 'camelCase'] 
        },
        // Enum members
        { 'selector': 'enumMember', 'format': ['UPPER_CASE'] }
      ],
    },
  },
  
  // Test files configuration
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      jest: jestPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...jestPlugin.configs.recommended.rules,
      
      // General rules
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
      
      // Test-specific rule relaxations
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/naming-convention': 'off', // Relax naming in tests
    },
  },
  
  // Prettier integration (must be last)
  prettierConfig,
  
  // Ignore patterns
  {
    ignores: [
      'dist/',
      'node_modules/',
      '*.js',
      'coverage/',
      '.nyc_output/',
      'build/',
    ],
  },
]; 