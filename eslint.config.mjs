import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default ts.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/next-env.d.ts', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.{js,cjs,mjs}'], languageOptions: { globals: {
    process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', require: 'readonly', exports: 'readonly',
  } } },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { files: ['**/*.tsx'], plugins: { 'react-hooks': hooks }, rules: {
    'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn',
  } }
);
