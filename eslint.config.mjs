import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: { sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/protocol/**/*.ts', 'src/registry/synth/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@iobroker/adapter-core', message: 'protocol and synth must stay pure' },
          { name: 'mqtt', message: 'protocol and synth must stay pure' },
        ],
      }],
    },
  },
  { ignores: ['build/', 'node_modules/'] },
];
