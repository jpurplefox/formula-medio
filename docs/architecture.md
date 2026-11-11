# Architecture

The game, the AI training and the tools share one core: the physics, the rules and the race. That core knows nothing
about the browser, so it runs the same in the game, in Node (`rl/`, `tools/`) and in the tests. Around it are the
adapters: what you see, what you hear, the keyboard, the menu.

It is the idea of hexagonal architecture, done the JavaScript way: modules of functions and a few classes where there
is state, with no formal interfaces or dependency containers. The ports are the shape an object must have,
documented with JSDoc and checked by TypeScript.

## The layers of `src/`

| Folder | What is in it | May use |
|---|---|---|
| `sim/` | The physics and rules of the car and the track: dynamics (`dynamics.js`), the car (`car.js`), collisions and damage, the track, the racing line, the rubber, the start lights and the physics step for several cars (`traffic.js`) | nothing outside |
| `race/` | The race (`race.js`: grid, start lights, starts, laps, retirements, finish, order), the grid and the teams | `sim/` |
| `drivers/` | Who drives: the classic AI (`ai.js`), the network (`policy.js`, with what it sees in `sensors.js`) and the player (`human.js`) | `sim/`, `race/` |
| `render/` | 3D drawing (WebGL and CPU), the models and the textures | all of the above |
| `ui/` | The HUD, the menu, the saved options, the driver animation and the replay | all of the above |
| `input/` | Keyboard and gamepad | all of the above |
| `audio/` | Engines and music | all of the above |
| `load/` | Building a track from an image (needs the browser) | all of the above |

`main.js` puts everything together: it creates the game session, connects the adapters and runs the loop.

`rl/`, `tools/` and `test/` run in Node: they use `sim/`, `race/` and `drivers/`, never the browser parts.

ESLint checks the rules (`eslint.config.js`). If `sim/` imports something from `render/`, or uses `document`, lint
fails.

## The ports

- **Driver** (`Driver`, in `race/race.js`): `drive(dt, track, line, me, others)` returns
  `{ throttle, brake, steer }`. The classic AI, the network and the player implement it. Those that also have
  `grid(...)` and `seesLights` handle their own start.
- **Race** (`Race`): `step(dt)` advances the race and returns what happened (events: `start`, `lap`, `invalid`,
  `finish`, `retire`). The game shows them (laps, messages, replay); `rl/race_eval.js` counts them.
- **Physics step** (`stepCars`, in `sim/traffic.js`): wake, each car with what its driver asks for, and collisions,
  in that order. The race and the training simulators (`rl/race.js`, `rl/herd.js`) use it, so driving works the
  same everywhere.

## Python and JavaScript

| Python | Here |
|---|---|
| module / package | `.js` file with `export` / folder. Import from the specific file, with no `index.js` that re-exports |
| `Protocol` / ABC | a JSDoc `@typedef` with the shape of the object |
| type hints + mypy | JSDoc + `npm run types` (TypeScript without compiling, `tsconfig.json`) |
| dependency injection | pass the object as a parameter or to the constructor (for example, `setupMenu(app)`) |
| import-linter | `no-restricted-imports` in `eslint.config.js` |
| pytest | `node:test` (`npm test`) |

## How it is checked

`npm install` once, and then:

- `npm test`: the tests in `test/` (`node:test`, under a second): physics properties (`dynamics.js`, `lapsim.js`,
  `car.js`: top speed, braking, wings, altitude, fuel, tyres), damage, collisions, start lights, the race, teams and
  grid, sensors and a flying lap of the game network at Monza. They test properties with margins, not exact numbers:
  they still hold after recalibrating the car, and if an intentional change breaks them, check whether the test
  still makes sense.
- `npm run lint`: ESLint (errors and layers), Prettier (formatting, only the `.js` files) and the types
  (`npm run types`). `npm run format` formats.
- `npm run regress` (`tools/regress.js`): fixed-seed races compared bit for bit with `tools/regress.base.txt`. It
  covers the physics, collisions, damage, sensors, the network, the game-style race and both training simulators: if
  a change touches any of that, even in the last decimal, it fails (~1 min). When the change is intentional,
  `node tools/regress.js save` updates the baseline. It does not cover what is browser-only (camera, HUD, menu,
  sound).

CI (`.github/workflows/check.yml`) runs all three on every PR. The regression runs on macOS arm64: on x64 the math
functions can differ in the last decimal and the baseline does not match, so the baseline is saved on a Mac with
Apple Silicon.

## Where new things go

- A physics or car rule: `sim/`, with a test in `test/`.
- Something about the race (yellow flag, pit stops, penalties): `race/race.js`, which reports it with a new event.
- Another kind of driver: `drivers/`, with `drive(...)`.
- Something you see or touch: `render/`, `ui/` or `input/`, connected in `main.js`.
