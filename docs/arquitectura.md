# Arquitectura

El juego, el entrenamiento de la IA y las herramientas comparten un mismo núcleo: la física, las reglas y la
carrera. Ese núcleo no sabe nada del navegador, así que corre igual en el juego, en Node (`rl/`, `tools/`) y en los
tests. Alrededor van los adaptadores: lo que se ve, lo que se oye, el teclado, el menú.

Es la idea de la arquitectura hexagonal, a la manera de JavaScript: módulos de funciones y algunas clases donde hay
estado, sin interfaces formales ni contenedores de dependencias. Los puertos son la forma que tiene que tener un
objeto, documentada con JSDoc y revisada por TypeScript.

## Las capas de `src/`

| Carpeta | Qué hay | Puede usar |
|---|---|---|
| `sim/` | La física y las reglas del auto y la pista: dinámica (`dynamics.js`), el auto (`car.js`), choques y daños, la pista, la trazada, la goma, el semáforo y el paso físico de varios autos (`traffic.js`) | nada de afuera |
| `race/` | La carrera (`race.js`: grilla, semáforo, largadas, vueltas, abandonos, llegada, orden), la grilla y los equipos | `sim/` |
| `drivers/` | Quién maneja: la IA clásica (`ai.js`), la red (`policy.js`, con lo que ve en `sensors.js`) y el jugador (`human.js`) | `sim/`, `race/` |
| `render/` | El dibujo 3D (WebGL y CPU), los modelos y las texturas | todo lo anterior |
| `ui/` | El HUD, el menú, las opciones guardadas, la animación del piloto y la repetición | todo lo anterior |
| `input/` | Teclado y joystick | todo lo anterior |
| `audio/` | Motores y música | todo lo anterior |
| `load/` | Armar un circuito desde una imagen (necesita el navegador) | todo lo anterior |

`main.js` arma todo: crea la partida, conecta los adaptadores y corre el bucle.

`rl/`, `tools/` y `test/` corren en Node: usan `sim/`, `race/` y `drivers/`, nunca lo del navegador.

Las reglas las revisa ESLint (`eslint.config.js`). Si `sim/` importa algo de `render/`, o usa `document`, el lint
falla.

## Los puertos

- **Piloto** (`Driver`, en `race/race.js`): `drive(dt, track, line, me, others)` devuelve
  `{ throttle, brake, steer }`. Lo implementan la IA clásica, la red y el jugador. Los que además tienen
  `grid(...)` y `seesLights` manejan su propia largada.
- **Carrera** (`Race`): `step(dt)` avanza la carrera y devuelve lo que pasó (eventos: `start`, `lap`, `invalid`,
  `finish`, `retire`). El juego los muestra (vueltas, mensajes, repetición); `rl/race_eval.js` los cuenta.
- **Paso físico** (`stepCars`, en `sim/traffic.js`): estela, cada auto con lo que pide su piloto y choques, en ese
  orden. Lo usan la carrera y los simuladores de entrenamiento (`rl/race.js`, `rl/herd.js`), así se maneja igual
  en todos lados.

## Python y JavaScript

| Python | Acá |
|---|---|
| módulo / paquete | archivo `.js` con `export` / carpeta. Se importa del archivo concreto, sin `index.js` que reexporte |
| `Protocol` / ABC | un `@typedef` de JSDoc con la forma del objeto |
| type hints + mypy | JSDoc + `npm run types` (TypeScript sin compilar, `tsconfig.json`) |
| inyección de dependencias | pasar el objeto por parámetro o al constructor (por ejemplo, `setupMenu(app)`) |
| import-linter | `no-restricted-imports` en `eslint.config.js` |
| pytest | `node:test` (`npm test`) |

## Cómo se revisa

- `npm test`: los tests de `test/`, en menos de un segundo.
- `npm run lint`: ESLint (errores y capas), Prettier (formato) y los tipos.
- `npm run regress`: carreras con semilla fija comparadas bit a bit con `tools/regress.base.txt`. Cubre la física,
  los choques, los daños, los sensores, la red, la carrera tipo juego y los dos simuladores de entrenamiento. Sólo da
  idéntico en Apple Silicon (en x64 las funciones matemáticas difieren en el último decimal); el CI la corre en
  macOS.

El CI (`.github/workflows/check.yml`) corre las tres cosas en cada PR.

## Dónde va cada cosa nueva

- Una regla de física o del auto: `sim/`, con un test en `test/`.
- Algo de la carrera (bandera amarilla, boxes, penalizaciones): `race/race.js`, que avisa con un evento nuevo.
- Otro tipo de piloto: `drivers/`, con `drive(...)`.
- Algo que se ve o se toca: `render/`, `ui/` o `input/`, y se conecta en `main.js`.
