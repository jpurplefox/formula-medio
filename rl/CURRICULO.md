# Plan: red más grande y entrenamiento por currículum

Plan acordado para la próxima ronda de la IA por refuerzo (todavía no implementado).

## 1. Red más grande (experimento barato, primero)

- Hoy: política y crítico de 256×256.
- Probar política algo más grande (384×384 o 3×256) y crítico más grande (512×512): el crítico es el que
  más sufre al estimar el premio con varios autos alrededor.
- No se puede continuar un modelo con otro tamaño: re-entrenar la etapa 1 (35–60 min) y comparar tiempos de
  vuelta con `rl/eval.js` contra `models/etapa1.json`. Alternativa: ensanchar la red existente con las
  neuronas nuevas en cero (como hicimos con los sensores de rivales).
- En el juego no pesa: 21 autos decidiendo 20 veces por segundo sigue siendo poco cálculo.

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

## Métricas por fase

- Vuelta lanzada sola (`rl/eval.js`): que no empeore.
- Toques por kilómetro en pelotón.
- Pasadas limpias cada 10 persecuciones.
- Posición, toques y pasto en carrera completa (`rl/race_eval.js`, 22 y 8 autos).
