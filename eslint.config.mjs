import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{
		ignores: [
			'main.js',
			'node_modules/**'
		]
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
				sourceType: 'module'
			}
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			obsidianmd
		},
		rules: {
			...obsidianmd.configs.recommended,
			'@typescript-eslint/no-floating-promises': 'error'
		}
	}
];

