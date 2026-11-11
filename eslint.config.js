// ESLint: errores reales (variables sin uso, nombres sin definir, código inalcanzable) y las reglas de las capas. El
// formato lo pone Prettier (.prettierrc.json): npm run lint revisa las dos cosas y npm run format formatea.
import js from '@eslint/js';
import globals from 'globals';

// Las capas de src/ (ver docs/arquitectura.md): cada una puede importar sólo las de su lista
//   sim       la física y las reglas del auto y la pista: nada de afuera
//   race      la carrera (grilla, semáforo, choques, vueltas, posiciones, abandonos) y los equipos: sim
//   drivers   quién maneja (IA clásica, red, jugador): sim y race
//   render, ui, audio, load: adaptadores del navegador, pueden usar todo lo anterior
// rl/, tools/ y test/ corren en Node: usan sim, race y drivers, nunca lo del navegador.
const BROWSER = ['render', 'ui', 'audio', 'load'];
const forbid = (layers, message, prefix = '..') => ({
  'no-restricted-imports': [
    'error',
    { patterns: [{ group: [...layers.map((l) => `${prefix}/${l}/*`), `${prefix}/main.js`], message }] },
  ],
});

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
  // el juego corre en el navegador; el dominio (sim, race, drivers) también en Node: sólo lo que hay en los dos
  {
    files: ['src/**/*.js', 'tracks/**/*.js'],
    ignores: ['src/sim/**', 'src/race/**', 'src/drivers/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/sim/**/*.js', 'src/race/**/*.js', 'src/drivers/**/*.js'],
    languageOptions: { globals: globals['shared-node-browser'] },
  },
  { files: ['src/render/terrainworker.js'], languageOptions: { globals: globals.worker } },
  // las capas
  {
    files: ['src/sim/**/*.js'],
    rules: forbid(['race', 'drivers', ...BROWSER], 'sim/ no depende de nada: es el núcleo'),
  },
  {
    files: ['src/race/**/*.js'],
    rules: forbid(['drivers', ...BROWSER], 'race/ sólo usa sim/: los pilotos se le pasan de afuera'),
  },
  { files: ['src/drivers/**/*.js'], rules: forbid(BROWSER, 'drivers/ no usa lo del navegador') },
  // el entrenamiento, las herramientas y los tests, en Node
  { files: ['rl/**/*.js', 'tools/**/*.js', 'test/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
  {
    files: ['rl/**/*.js', 'tools/**/*.js', 'test/**/*.js'],
    rules: forbid(BROWSER, 'en Node no se usa lo del navegador', '**/src'),
  },
];
