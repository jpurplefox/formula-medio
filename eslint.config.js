// ESLint: real errors (unused variables, undefined names, unreachable code) and the layer rules. Formatting is
// Prettier's job (.prettierrc.json): npm run lint checks both and npm run format formats.
import js from '@eslint/js';
import globals from 'globals';

// The layers of src/ (see docs/architecture.md): each one may import only the ones in its list
//   sim       the physics and the rules of the car and the track: nothing from outside
//   race      the race (grid, start lights, collisions, laps, positions, retirements) and the teams: sim
//   drivers   who drives (classic AI, network, player): sim and race
//   render, ui, audio, input, load: browser adapters, may use all of the above
// rl/, tools/ and test/ run in Node: they use sim, race and drivers, never the browser code.
const BROWSER = ['render', 'ui', 'audio', 'input', 'load'];
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
      // an argument or variable that starts with _ is unused on purpose
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  // the game runs in the browser; the domain (sim, race, drivers) also in Node: only what exists in both
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
  // the layers
  {
    files: ['src/sim/**/*.js'],
    rules: forbid(['race', 'drivers', ...BROWSER], 'sim/ depends on nothing: it is the core'),
  },
  {
    files: ['src/race/**/*.js'],
    rules: forbid(['drivers', ...BROWSER], 'race/ only uses sim/: drivers are passed in from outside'),
  },
  { files: ['src/drivers/**/*.js'], rules: forbid(BROWSER, 'drivers/ does not use browser code') },
  // training, tools and tests, in Node
  { files: ['rl/**/*.js', 'tools/**/*.js', 'test/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
  {
    files: ['rl/**/*.js', 'tools/**/*.js', 'test/**/*.js'],
    rules: forbid(BROWSER, 'browser code is not used in Node', '**/src'),
  },
];
