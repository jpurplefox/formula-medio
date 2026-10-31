# Plan: red más grande y entrenamiento por currículum

Plan para la ronda de la IA por refuerzo que vino después de la etapa 2. Ya está implementado y entrenado: los
resultados están al final (fases 5–7) y la red recomendada es `models/fase7.json`.

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

## Métricas por fase

- Vuelta lanzada sola (`rl/eval.js`): que no empeore.
- Toques por kilómetro en pelotón.
- Pasadas limpias cada 10 persecuciones.
- Posición, toques y pasto en carrera completa (`rl/race_eval.js`, 22 y 8 autos).

## Cómo se corre

```bash
sh rl/curriculum.sh        # las 7 fases seguidas (~4 h); sh rl/curriculum.sh 3 rehace desde la fase 3
```

Cada fase parte del modelo final de la anterior y se exporta a `models/faseN.json`. Al continuar un modelo, la
tasa de aprendizaje de cada fase va de su valor inicial (`--lr`) a 0 dentro de esa fase.

- Red: política 384×384, crítico 512×512.
- Escenarios y premios: `rl/race.js`. Variación de autos y gomas al azar: `randomSetup` y `randomTyres` en `rl/env.js`.
- Desgaste calibrado con `node rl/wear.js` (una vuelta normal ≈ 1 con `wearRate = 1 / largo de vuelta`).

## Cómo se mide

```bash
node rl/eval.js models/fase4.json                                   # vuelta lanzada sola, autos iguales
node rl/scenario_eval.js models/etapa2.json models/fase4.json       # cada escenario, mismas carreras
SPREAD=0.05 node rl/race_eval.js models/fase4.json                  # 22 autos distintos, con rotación
```
