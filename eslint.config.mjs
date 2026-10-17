// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores([
    'dist',
    'coverage',
    'examples',
    'playwright-report',
    'test-results'
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // `Utils` is a public static-only namespace class
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowStaticOnly: true }
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['test/**', 'e2e/**', '*.config.{ts,mts}'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node }
  },
  prettier
)
