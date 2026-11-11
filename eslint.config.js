// ESLint: errores reales (variables sin uso, nombres sin definir, código inalcanzable), con npm run lint.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'site/', 'rl/.venv/', 'rl/runs/', 'tools/.cache/', 'tools/.out/', '.claude/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      // un argumento o una variable que empieza con _ está sin usar a propósito
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  // el juego corre en el navegador
  { files: ['src/**/*.js', 'tracks/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['src/terrainworker.js'], languageOptions: { globals: globals.worker } },
  // el entrenamiento y las herramientas, en Node
  { files: ['rl/**/*.js', 'tools/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
