# Plan: red más grande y entrenamiento por currículum

Plan para la ronda de la IA por refuerzo que vino después de la etapa 2, con cinco intentos de currículum. La red
del juego de ese plan fue `models/v5/fase7.json` (quinto intento); hoy es la que diga `GAME_NET` en `src/drivers/policy.js`,
entrenada en manada (`rl/curriculum.sh`). Las redes de acá ya no están en `models/`: quedan en el historial de git
(commit e9ff553).

## 1. Red más grande (experimento barato, primero)

- Hoy: política y crítico de 256×256.
- Probar política algo más grande (384×384 o 3×256) y crítico más grande (512×512): el crítico es el que
  más sufre al estimar el premio con varios autos alrededor.
- No se puede continuar un modelo con otro tamaño: re-entrenar la etapa 1 (35–60 min) y comparar tiempos de
  vuelta con `rl/eval.js` contra `models/etapa1.json`. Alternativa: ensanchar la red existente con las
  neuronas nuevas en cero (como hicimos con los sensores de rivales).
- En el juego no pesa: 21 autos decidiendo 20 veces por segundo sigue siendo poco cálculo.

## 1b. Autos distintos y desgaste de gomas (antes de re-entrenar la etapa 1)

Como la etapa 1 se re-entrena igual con la red grande, las entradas nuevas van desde el principio.

- **Variación por auto** (*domain randomization*): potencia, velocidad punta (resistencia al aire), agarre,
  frenos y ritmo de desgaste, sutiles (±2 % en las fases 1–3, hasta ±5 % en la 4). Opcional: algo de ruido en
  la dirección o demora de reacción.
- **Desgaste de gomas físico**: hoy es solo visual (`tyres()` en `src/main.js`). Pasa a ser parte de `Car`:
  se gasta más con el deslizamiento y el uso del agarre, y el agarre baja con el desgaste.
- **Entradas nuevas de la red** (en el grupo del propio auto, antes de los rivales): potencia, agarre,
  velocidad punta, frenos y ritmo de desgaste relativos, más el desgaste actual de las gomas. Un piloto conoce
  su auto; así puede exprimir uno bueno en vez de manejar "promedio".
- Del rival no hace falta: ya ve su velocidad relativa.
- **En el juego, la dificultad sale de acá**: misma red, rivales con autos algo peores y más ruido en Fácil,
  parejos y sin ruido en Experto.

## 2. Currículum

| Fase | Qué aprende | Mezcla aproximada |
|---|---|---|
| 1 | Manejar solo | 100 % pista limpia (lo que ya tenemos) |
| 2 | No chocar | 25 % pista limpia, 45 % pelotón / curva juntos, 30 % largadas con muchos autos |
| 3 | Pasar | 15 % pista limpia, 20 % pelotón, 20 % largadas, 45 % persecuciones |
| 4 | Consolidar | 50–60 % carreras completas + repaso de todos los escenarios, LR baja (~5e-5) |

### Reglas generales

- **Mezcla, no reemplazo**: cada fase repasa las anteriores para evitar el olvido catastrófico.
- **Episodios cortos** (10–20 s) en los escenarios: muchos más intentos por hora en las situaciones raras.
- **Calentar el crítico** (`--critic-warmup`) cada vez que cambia el premio.
- **El premio depende solo de cosas que la red ve**: con más de 2 rivales cerca no hay premio por pasar y el
  contacto pesa más; la red deduce sola "estoy en pelotón" y prioriza seguridad.

### Fase 2: no chocar

- Escenarios con 1–2 rivales que llegan juntos a una curva (lado a lado, antes de la frenada).
- Persecuciones a rebufo y largadas con muchos autos hasta pasada la primera curva.
- **Castigar el peligro, no la cercanía**: castigo por tiempo hasta el choque < 0,5 s y por contacto (más al
  que embiste de atrás). No premiar "mantener X metros", porque después hay que desaprenderlo para pasar.
- Rebufo: no castigarlo; si se premia, solo por la ganancia que da (velocidad o metros), nunca por estar ahí.

### Fase 3: pasar

- El de adelante es la IA de siempre con ritmo 0,85–0,95 (menos agarre y velocidad punta, maneja normal; no
  frena de golpe).
- En recta: diferencia chica (~0,95) y que el rebufo haga el resto. En curva: más diferencia y largar cerca.
- Más adelante, rivales que defienden (cierran el interior).
- Pasada premiada solo si se sostiene 2–3 s / 50 m, sin contacto en la ventana previa ni atajos por el pasto.
- Siempre 1–2 rivales cerca; si hay más, aplica la regla de seguridad.

### Fase 4: consolidar

- Carreras completas con el mismo premio que los escenarios (si cambia, calentar el crítico).
- Rivales variados: IA de siempre a distintos ritmos, copias de la red y versiones anteriores de cada fase
  (evita que aprenda cosas que solo sirven contra sí misma).
- Si algo empeora (por ejemplo toques en la largada), subir el peso de ese escenario en el repaso.
- Con autos distintos, las pasadas (auto mejor) y las defensas (auto peor) aparecen solas.
- Defensa: castigo chico por ser pasado, castigo por cambiar de dirección más de una vez con alguien cerca
  atrás (la regla de "un solo movimiento") y contacto como siempre (paga más el que embiste).

### Que un auto mejor no se confunda con manejar mejor

- **El crítico ve el auto**: con las entradas del propio auto predice más premio para un auto mejor, y PPO
  aprende de la ventaja (premio real menos el esperado). Un auto bueno no infla lo aprendido; solo cuenta
  hacerlo mejor de lo que ese auto permitía.
- **El premio es por paso, no por resultado**: progreso, pasadas limpias, contacto, peligro. No hay premio por
  posición final, que es lo que más depende del auto.
- **Opcional**: progreso medido contra el ritmo teórico de ese auto, para que la escala del premio no dependa
  del auto.
- **Evaluación con condiciones fijas**: todos los puntos de control corren las mismas carreras (misma semilla,
  mismos autos) y cada auto lo maneja una vez cada uno, rotando; o todos los autos iguales.

## Lo que salió en el primer intento (y qué se cambió)

- **Fase 1, bien**: la red grande con autos distintos y gomas que se gastan hace las mismas vueltas que la etapa 1 y,
  en carrera de 22 autos, queda mejor que la etapa 2 (posición media 7,1 contra 7,3) con la mitad de pasto.
- **Fases 2–4, mal en carrera completa**: en los escenarios mejoró todo (toques en pelotón 2,5 → 1,1 por km,
  zigzags 1,25 → 0,16), pero en carrera de 22 autos cayó a posición media 14 y se trababa en la primera curva.
  Aprendió que frenar es "seguro":
  - El castigo por peligro (hasta 2 por segundo) pesaba más que lo que da avanzar en una curva (~0,6 por segundo):
    con alguien cerca convenía levantar el pie.
  - Quedarse quieto 6 s terminaba el episodio con un castigo chico: en un amontonamiento, donde venían toques y
    peligro, cortar ahí era más barato que salir. Nunca aprendió a destrabarse.
- **Cambios**: castigo por peligro a un tercio (como mucho 0,6 por segundo); trabado, en el pasto o para atrás ya
  no termina el episodio: se lo rescata con un castigo de 4 y además paga 1 por segundo quieto; la medición por
  escenario muestra metros recorridos y rescates (una red miedosa choca poco pero avanza menos); la red también se
  rescata sola en el juego y en `rl/race_eval.js`, como la IA de siempre.
- **Segundo intento**: ya no se traba (posición media en 22 autos 14,2 → 9,5) y es la más limpia: en 8 autos la
  mitad de toques que la fase 1 (33 contra 56), menos zigzag y menos toques en largadas y pelotón. Pero sigue
  quedando detrás de la fase 1 en carrera de 22 (9,5 contra 7,1): pasa menos (0,24 pasadas por carrera contra
  0,45) y pierde puestos en el pelotón de la largada. La vuelta sola casi igual (0,939 contra 0,928).

## Fases 5–7: conducción limpia

Prioridad: no chocar. Midiendo qué tipo de toque era cada uno, la mayoría eran **de costado**, y el castigo los
trataba como si le hubieran pegado (25 %): apretar al de al lado salía barato. Cada fase parte de la anterior
(30 M pasos, LR 5e-5, más peso en largadas y pelotón).

- **Fase 5**: en un toque de costado paga entero el que se le fue encima al otro; el peligro también mira al de al
  lado (si se le va encima y lo tocaría en menos de 0,6 s).
- **Fase 6**: el peligro de adelante se mira con 1 s (antes 0,6) y provocar un toque cuesta 6 (antes 4). Embistió
  menos, pero esquivaba hacia el costado y volvieron a subir los toques de lado.
- **Fase 7**: el peligro de costado también a 1 s.

Toques por carrera (cuadros de contacto de los autos con la red; promedio de las carreras con autos iguales y con
autos distintos rotando), pasto y posición media contra la IA de siempre en Difícil:

| Red | Toques, 22 autos | Toques, 8 autos | Pasto, 22 autos | Posición, 22 autos |
|---|---|---|---|---|
| fase 1 | 447 | 67 | 59 s | 7,4 |
| fase 4 | 382 | 50 | 59 s | 9,6 |
| fase 5 | 299 | 39 | 59 s | 10,4 |
| fase 6 | 318 | 33 | 47 s | 10,2 |
| **fase 7** | **249** | **38** | **41 s** | 9,7 |

- La fase 7 tiene **44 % menos toques que la fase 1** y el menor tiempo en el pasto. Los toques de costado entre
  redes bajaron de 1031 a 206; lo que queda es casi todo con la IA de siempre, que no aprendió a cuidarse.
- Persecuciones: la que más pasa (0,60 por persecución) sin que la pasen. Vuelta sola: 0,942 (fase 1: 0,928).
- El costo: queda a mitad de tabla contra la IA de siempre (que choca más y no levanta).
- `rl/race_eval.js` ahora informa cuántos toques provocó la red (le pegó al de adelante o apretó al de al lado).

## Tercer intento: limpio primero, velocidad después

Con lo aprendido, el currículum se rearma desde cero (modelos en `models/v3/`) y se compara
con la fase 7. La idea: aprender primero a manejar limpio y recién después a ir rápido y a pasar.

| Fase | Qué aprende | Premio | Mezcla |
|---|---|---|---|
| 1 | Manejar dentro de la pista | Avanzar como siempre; pasto ×3 y muro ×2; menos pasos (no sobre-optimizar) | sola |
| 2 | No chocar en grupo | Avanzar ×0,7; sin premio por pasar; presupuesto de toques estricto; piso de ritmo | pelotón, largadas, sola |
| 3 | No chocar en carrera | Igual que la 2 | carreras, largadas, pelotón, seguir a uno más lento, sola |
| 4 | Velocidad sin chocar | Avanzar ×1, mismo presupuesto de toques | carreras + repaso |
| 5 | Pasar seguro | Premio por pasada limpia (como antes) | persecuciones + repaso |
| 6 | Integrar | Todo junto, LR baja, rivales de fases anteriores | carreras + repaso |

- **Pasto más caro en la fase 1** en vez de menos premio por avanzar: para esquivar hace falta controlar el auto
  al límite, y eso se aprende yendo rápido. "Limpio" sola en pista es no salirse.
- **Piso de ritmo** (fases 2–6): con la pista libre adelante (nadie a menos de 40 m en su carril), ir por debajo del
  75 % de la velocidad de la trazada se castiga (hasta 1 por segundo). Con alguien adelante no aplica: seguir a uno
  más lento está bien. Es lo que evita que vuelva a aprender que frenar es "seguro".
- **Presupuesto de toques**: el castigo por un toque provocado (pegarle al de adelante o apretar al de al lado) se
  multiplica por un factor que se ajusta solo durante el entrenamiento. Si la red provoca más toques por km que el
  presupuesto, el factor sube; si provoca menos, baja de a poco (entre 0,5 y 5). El factor pasa de una fase a la
  siguiente, así subir el premio por avanzar en la fase 4 no puede comprarse con toques.
- **Pasadas** sin premio hasta la fase 5: en las fases de limpieza seguir a uno más lento es lo correcto.

### Resultados del tercer intento

Toques por carrera (promedio con autos iguales y con autos distintos rotando), provocados por la red, pasto y
posición media contra la IA de siempre en Difícil; vuelta sola con `rl/eval.js` (más bajo es más rápido):

| Red | Toques, 22 autos | Provocados, 22 | Toques, 8 autos | Pasto, 22 | Posición, 22 | Posición, 8 | Vuelta sola |
|---|---|---|---|---|---|---|---|
| fase 7 (2.º intento) | 249 | 193 | 38 | 41 s | 9,7 | 3,7 | 0,942 |
| v3 fase 3 (limpia) | 182 | 130 | 27 | 183 s | 16,4 | 5,9 | |
| v3 fase 4 (velocidad) | 159 | 107 | 24 | 108 s | 16,1 | 5,6 | 0,953 |
| v3 fase 5 (pasar) | 195 | 134 | 25 | 70 s | 15,2 | 5,5 | |
| v3 fase 6 (integrar) | 194 | 128 | 23 | 49 s | 14,9 | 5,9 | 0,965 |

- **Más limpia**: la fase 6 toca un 22 % menos que la fase 7 en 22 autos (provoca un 34 % menos) y un 40 % menos en 8.
- **Pero mucho más lenta**: pierde unos 5 puestos por carrera contra la IA de siempre y en 8 autos casi siempre
  terminan las 4 redes detrás de las 4 IA. Sola, su vuelta es un 3 % más lenta que la de su propia fase 1 (0,932).
- **Por qué**: el presupuesto (la mitad de los toques de la fase 7) fue demasiado exigente. La escala del castigo
  llegó al tope (5) en la fase 2 y no bajó nunca: durante todo el currículum lo que más pesaba era no tocar, y con
  alguien adelante el piso de ritmo no aplica, así que en tráfico conviene ir detrás. La fase 4 casi no ganó ritmo.
- En la fase 3 y 4 el pasto en carrera de 22 es alto: la red se abre al pasto para no tocar.

## Cuarto intento: mantener el ritmo en vez de premiar pasadas

Modelos en `models/v4/` (~1,5 h). Parte de la v3 fase 4 (la que menos tocaba) y cambia
cuatro cosas:

- **Sin premio por pasar; piso de ritmo siempre** (salvo amontonado: más de 3 autos a menos de 30 m). Para no perder
  ritmo detrás de uno más lento tiene que pasarlo; pasar sale solo, no se premia.
- **Persecuciones con el de adelante en desventaja**: menos agarre y potencia (−20 % al principio de la fase, −8 %
  al final), para que pasar sea posible sin forzar.
- **Largadas y amontonamientos conservadores**: ahí un toque provocado cuesta ×2,5 y se mira más lejos (×1,5) para
  el peligro.
- **Presupuesto alcanzable**: 80 % de los toques provocados de la fase 7 (no 50 %), con escala inicial 2.
- **Autos más distintos**: de −15 % a +20 % (antes ±5 %), para poder subir la dificultad en el juego dándoles más
  agarre. Las entradas del auto se normalizan ahora con ±20 % (`SETUP_SPREAD`); las redes anteriores se
  reescalaron con `rl/rescale_setup.py` y dan exactamente lo mismo.

| Fase | Mezcla | Rivales | Pasos |
|---|---|---|---|
| v4 fase 5 (ritmo sin chocar) | carreras 35, persecuciones 25, largadas 15, pelotón 15, sola 10 | fase 7, v3 fase 4 | 35 M |
| v4 fase 6 (integrar) | carreras 55, largadas 15, pelotón 10, persecuciones 10, sola 10 | + v4 fase 5 | 30 M |

La escala del castigo terminó en 0,9 en la fase 5 (dentro del presupuesto) y en 2,9 en la fase 6.

### Resultados del cuarto intento

Contra la IA de siempre, igual que la tabla anterior:

| Red | Toques, 22 autos | Provocados, 22 | Toques, 8 autos | Pasto, 22 | Posición, 22 | Posición, 8 | Vuelta sola |
|---|---|---|---|---|---|---|---|
| fase 7 | 249 | 193 | 38 | 41 s | 9,7 | 3,7 | 0,942 |
| v3 fase 4 | 159 | 107 | 24 | 108 s | 16,1 | 5,6 | 0,953 |
| v3 fase 6 | 194 | 128 | 23 | 49 s | 14,9 | 5,9 | 0,965 |
| v4 fase 5 | 125 | 82 | 20 | 84 s | 16,2 | 5,6 | 0,971 |
| v4 fase 6 | **107** | **68** | **18** | 73 s | 16,3 | 5,8 | 0,969 |

Carrera tipo juego (`JUEGO=1`: 21 autos con la red y uno de la IA de siempre al ritmo más alto de Difícil
haciendo de jugador; los 8 circuitos), por auto de la red:

| Red | Toques | Provocados | Pasto | Tiempo del ganador | El jugador termina |
|---|---|---|---|---|---|
| fase 7 | 30,9 | 24,7 | 4,2 s | 240,1 s | 11,9.º |
| v3 fase 4 | 16,1 | 11,9 | 9,4 s | 251,2 s | 2,6.º |
| v3 fase 6 | 14,7 | 11,5 | 3,8 s | 250,4 s | 3,8.º |
| v4 fase 5 | 12,5 | 9,2 | 7,3 s | 251,2 s | 2,4.º |
| v4 fase 6 | **11,5** | **8,9** | 5,9 s | 247,9 s | 3,4.º |

Escenarios (`rl/scenario_eval.js`, toques provocados por km):

| Red | Pelotón | Largada | Persecución | Carrera |
|---|---|---|---|---|
| fase 7 | 0,77 | 4,10 | 0,65 | 0,82 |
| v3 fase 4 | 0,34 | 2,98 | 0,76 | 0,52 |
| v4 fase 5 | 0,62 | 2,17 | 0,72 | 0,39 |
| v4 fase 6 | 0,53 | **1,98** | **0,58** | **0,34** |

- **La más limpia de todas**: la v4 fase 6 toca un 57 % menos que la fase 7 en 22 autos (provoca un 65 % menos) y
  un 22 % menos que la v3 fase 6. En la carrera tipo juego, 11,5 toques por auto contra 30,9.
- **Largadas**: los toques provocados bajan a la mitad que en la fase 7 y un tercio menos que en la v3.
- **Ritmo**: en tráfico de redes, el ganador es 1 % más rápido que con la v3 y 3 % más lento que con la fase 7.
  Sola, la vuelta es un 2–3 % más lenta que la de la fase 7: se compensa en el juego con más agarre.
- **Pasto**: sigue más alto que en la fase 7; en 22 autos se abre para no tocar.
- Contra la IA de siempre sigue perdiendo puestos: la IA de siempre es más agresiva y la red le cede lugar.

## Quinto intento (v5): agarre por rueda y ritmo en las largadas

Modelos en `models/v5/` (~3 h desde cero con `rl/curriculum.sh`). Cambia el juego: el agarre se calcula por rueda
según la superficie (el pasto frena y tira para afuera), los trazados salen de la telemetría y la red recibe 98
entradas (el agarre de cada rueda al final). La receta suma `paceCrowd` en las fases 5–7 (piso de ritmo también
amontonado, para no hacer fila en las largadas) y la fase 7, contra rivales 8 % más rápidos.

Carrera tipo juego (`JUEGO=1`, Difícil de entonces, con el rescate en el pasto de abajo):

| Red | Toques por auto | Provocados | Pasto por auto | Ganador | Jugador |
|---|---|---|---|---|---|
| v4 fase 6 | 10,5 | 8,4 | 9,5 s | 243,2 s | 2,1.º |
| v5 fase 3 | 7,3 | 5,9 | — | 243,6 s | 2,4.º |
| v5 fase 4 | **4,6** | **3,3** | — | 242,1 s | 3,0.º |
| v5 fase 5 | 7,7 | 6,0 | — | 241,3 s | 4,4.º |
| v5 fase 6 | 6,7 | 4,9 | 2,9 s | 240,3 s | 4,9.º |
| v5 fase 7 | 6,7 | 5,0 | **2,7 s** | **239,8 s** | 6,9.º |

- **La fase 1 sola ya es más rápida** que la v4 y la IA de siempre: 1 a 5 s por vuelta según el circuito.
- **Las fases 5–7 cambian limpieza por ritmo**: la 4 es la que menos toca; la 7 la más rápida (6–8 s por carrera
  más que la v4 con el mismo auto), con los mismos toques que la 6. En el juego se compensa con menos agarre y
  potencia para los rivales (`setups` en `src/race/teams.js`, de 0,83 en Fácil a 1,02 en Experto).
- **Largadas**: la fase 6 avanza un 8 % más que la v4 con los mismos toques provocados; la 7 vuelve a tocar algo más.
- **Lo que salió mal: autos perdidos en el pasto.** Medido sin cambios, la v5 pasaba 23–27 s por auto en el pasto,
  pero no por cortar curvas (con una sola rueda afuera casi nunca va): 2 a 6 autos por carrera se quedaban minutos
  dando vueltas ahí. Al entrenar se la rescata a los 6 s en el pasto, así que nunca aprendió a volver de lejos, y
  en el juego sólo se la rescataba quieta (en el pasto anda a ~90 km/h). Ahora `NeuralDriver` (`src/drivers/policy.js`)
  también la rescata a los 6 s en el pasto, igual que al entrenar.

## Métricas por fase

- Vuelta lanzada sola (`rl/eval.js`): que no empeore.
- Toques por kilómetro en pelotón.
- Pasadas limpias cada 10 persecuciones.
- Posición, toques y pasto en carrera completa (`rl/race_eval.js`, 22 y 8 autos).

## Cómo se corre

`rl/curriculum.sh` entrena desde cero la receta de la red del juego: las fases 1–4 del tercer intento, las 5–6
del cuarto y una 7 de ritmo contra rivales más rápidos (~3 h). En la fase 7 los rivales llevan 8 % más de agarre y
potencia (`--rivals-boost 0.08`) y la IA de siempre corre a 1–1,1 de ritmo: entre redes iguales el ritmo sólo
mejora hasta el del de adelante, así que hace falta tener adelante autos más rápidos. Hace falta `rl/.venv` y los circuitos exportados en `rl/tracks/` (README, "IA por refuerzo").

```bash
NOMBRE=v5 sh rl/curriculum.sh        # modelos en models/v5/, logs y checkpoints en rl/runs/v5faseN
NOMBRE=v5 sh rl/curriculum.sh 5      # rehace desde la fase 5 (usa rl/runs/v5fase4/model.zip)
```

Cada fase parte del modelo final de la anterior y se exporta a `models/$NOMBRE/faseN.json`. Al continuar un modelo,
la tasa de aprendizaje de cada fase va de su valor inicial (`--lr`) a 0 dentro de esa fase. Al terminar mide la
nueva contra la del juego en la carrera tipo juego; si es mejor, se cambia `GAME_NET` en `src/drivers/policy.js`.

Para cambiar la receta, lo que más pesa:
- `--contact-budget` (fracción de los toques provocados de la fase 7 que se permiten) y `--contact-scale`.
- `--rewards`: `progress`, `pass`, `paceFloor`, `paceAlways`, `paceCrowd`, `crowd`, `grass`, `wall` (`rl/race.js`,
  `rl/env.js`). `paceCrowd` (desde el quinto intento de la receta, 0,6): el piso de ritmo también amontonado, más
  bajo, para que en las largadas meterse en fila levantando el pie cueste tiempo y convenga seguir a la par.
- `--spread`: cuánto varían los autos (de −15 % a +20 % hoy). Pasar de ±20 % obliga a cambiar `SETUP_SPREAD` en
  `src/drivers/sensors.js` y a reescalar las redes viejas con `rl/rescale_setup.py`.
- La desventaja del de adelante en las persecuciones: `CHASE_HANDICAP` en `rl/race.js`.

Los scripts de los intentos anteriores (`curriculum.sh` de 7 fases, `curriculum3.sh`, `curriculum4.sh`) están en
el commit b3253db.

- Red: política 384×384, crítico 512×512.
- Escenarios y premios: `rl/race.js`. Variación de autos y gomas al azar: `randomSetup` y `randomTyres` en `rl/env.js`.
- Desgaste calibrado con `node rl/wear.js` (una vuelta normal ≈ 1 con `wearRate = 1 / largo de vuelta`).

## Cómo se mide

```bash
JUEGO=1 node rl/race_eval.js models/v22/fase18.json                 # carrera tipo juego: 21 redes y un "jugador"
node rl/eval.js models/v22/fase18.json                              # vuelta lanzada sola, autos iguales
node rl/scenario_eval.js models/a.json models/b.json                # cada escenario, mismas carreras
SPREAD=0.05 node rl/race_eval.js models/v22/fase18.json             # 22 autos distintos, con rotación
```
