import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser, __APP_VERSION__: 'readonly' } },
  },
  {
    files: ['mock/**/*.mjs', 'scripts/**/*.mjs', 'e2e/**/*.{ts,mjs}', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-undef': 'off', // 由 TypeScript 检查（含 env.d.ts 中的全局类型）
      'vue/require-default-prop': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  prettier,
)
