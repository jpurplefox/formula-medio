// ESLint: errores reales (variables sin uso, nombres sin definir, código inalcanzable). El formato lo pone Prettier
// (.prettierrc.json): npm run lint revisa las dos cosas y npm run format formatea.
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
  // el entrenamiento, las herramientas y los tests, en Node
  { files: ['rl/**/*.js', 'tools/**/*.js', 'test/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
