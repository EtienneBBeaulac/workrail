module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['jest', '@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    // General JS/TS rules
    'prefer-const': 'error',
    'no-var': 'error',
    'no-unused-vars': 'error',

    // ---------------------------------------------------------------------
    // Naming-convention enforcement (see docs/naming-conventions.md)
    // ---------------------------------------------------------------------
    '@typescript-eslint/naming-convention': [
      'error',
      // Classes, interfaces, types, enums
      { 'selector': 'typeLike', 'format': ['PascalCase'] },
      // Variables, functions, parameters
      { 'selector': 'variableLike', 'format': ['camelCase'] },
      // Constants (UPPER_SNAKE_CASE)
      { 'selector': 'variable', 'modifiers': ['const'], 'format': ['UPPER_CASE'] },
      // Enum members
      { 'selector': 'enumMember', 'format': ['UPPER_CASE'] }
    ],
  },
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],
}; 