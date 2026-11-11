# Los rivales

Los rivales manejan con una red neuronal entrenada por refuerzo, la que diga `GAME_NET` en `src/drivers/policy.js`.
Con `?ia=clasica` en la dirección manejan con la IA de siempre, que es también la que queda si la red no carga.
Las dos usan la trazada ideal.

## La trazada ideal

`src/sim/racingline.js` calcula, al cargar el circuito, la trazada curva por curva como la hacen los pilotos: se
llega por el lado de afuera, se toca el vértice (el punto más cerrado) del lado de adentro y se sale abriendo de
nuevo (en las eses, de vértice a vértice), con un suavizado final que saca los zigzags. Después calcula la velocidad
máxima en cada punto con los límites del auto (`src/sim/lapsim.js`): lo que aguanta el agarre en la curva, cuánto
hay que frenar antes y cuánto acelera el motor después. Cómo se ve en el juego: [render.md](render.md#la-trazada-ideal).

## La IA de siempre

Cada rival (`src/drivers/ai.js`) es un auto con la misma física que el tuyo, manejado por un piloto automático:

- **Volante:** persigue un punto de la trazada ideal unos metros más adelante (*pure pursuit*) y gira lo justo para
  llegar, dentro de lo que permite el agarre.
- **Pedales:** acelera o frena para ir a la velocidad que la trazada indica en ese punto, multiplicada por su ritmo
  (`pace`, según la dificultad: `DIFFICULTIES` en `src/race/teams.js`; en Interlagos, de vueltas de ~75–80 s en
  Fácil a ~69–70 s en Experto), con pequeñas variaciones de ritmo y de línea. Su trazada es la misma que ves, pero
  frenando más al límite (93 % en vez de 85 %), y en las curvas lentas no pasan de 0,975 de esa velocidad, porque
  más rápido se abren y salen.
- **Tráfico:** si alcanza a otro auto, se abre hacia el lado donde ya está (o donde hay más lugar) para pasarlo; a
  la par, cada uno se queda de su lado (y si no entran los dos, el que va un poco atrás levanta); si no hay lugar
  para pasar, se queda detrás guardando distancia.
- **A la par:** si el otro le lleva más de media trompa y no lo está pasando, cede y se ubica detrás.
- Si un rival se queda trabado, vuelve a la pista sobre la trazada.

## La IA entrenada con aprendizaje por refuerzo (`rl/`)

Una red neuronal aprende a manejar sola, con la misma física del juego, por etapas:

1. **Sola en pista** (contrarreloj): aprende a dar la vuelta lo más rápido posible en los 8 circuitos.
2. **Contra otros autos** (`rl/race.js`): carreras de 4 autos que aprenden (la misma red, contra sí misma) y de 0 a
   6 rivales con la IA de siempre a ritmos variados; largan en grilla, en fila o repartidos por la pista. Además de
   los metros, se castigan los toques entre autos (mucho más al que le pega al de adelante).

**Qué ve** (`src/drivers/sensors.js`, 98 números; las redes entrenadas antes del agarre por rueda usan los primeros
94): su auto (velocidad, deslizamiento, giro, volante, pedales, marcha, rpm, agarre de cada eje, rebufo, cuánto
mejor o peor es que el promedio y el desgaste de las gomas), su posición en la pista, cuánto dobla la pista a 20,
40… 450 m (lo que un piloto sabe de memoria), 19 rayos que miden la distancia al borde de la pista de -90° a +90°, y
los 6 rivales más cercanos (posición, velocidad relativa y hacia dónde apuntan; en la etapa 1 quedan en cero) y el
agarre de cada rueda según lo que pisa (así sabe de qué lado se fue al pasto).

**Qué decide**: volante y pedal (de frenar a fondo a acelerar a fondo), 20 veces por segundo, progresivos.

**Qué la premia** (`rl/env.js`): los metros que avanza sobre la línea central; la castigan el pasto, los golpes
contra el muro y quedarse quieta o ir para atrás. Cada episodio larga en un punto cualquiera de un circuito al azar.

### Cómo se entrena

Python con PyTorch y stable-baselines3 (algoritmo PPO) le pasa las acciones a varios procesos de Node
(`rl/worker.js`) que simulan 128 autos a la vez; en una Mac M4 Pro van unos 30.000 pasos por segundo.

```bash
python3 -m venv rl/.venv && rl/.venv/bin/pip install torch stable-baselines3 gymnasium tensorboard
```

1. Los circuitos de F1 se arman en Node desde `tracks/*.layout.json`. Sólo los que salen de una imagen necesitan
   exportarse antes (la parte que necesita el navegador): con `serve.py` corriendo, abrir
   `http://localhost:8123/rl/bake.html` (guarda las máscaras en `rl/tracks/`).
2. Entrenar: `rl/.venv/bin/python rl/train.py --steps 30000000 --name etapa1` (las curvas, con
   `rl/.venv/bin/tensorboard --logdir rl/runs`).
3. Exportar la red a JSON: `rl/.venv/bin/python rl/export.py rl/runs/etapa1/model.zip models/etapa1.json`.
4. Medirla contra la IA de siempre: `node rl/eval.js models/etapa1.json`.
5. Verla en el juego: `http://localhost:8123/?ia=models/etapa1.json` (los rivales manejan con esa red).

Para que el entrenamiento no se desarme (PPO es inestable), la tasa de aprendizaje baja de a poco hasta 0, cada
actualización usa 32.768 pasos y las recompensas se normalizan; conviene igual medir los puntos de control con
`rl/eval.js` y quedarse con el mejor. Cada episodio larga en cualquier punto de la vuelta, a veces parado o cruzado
y con ruedas afuera, para que aprenda también a largar y a volver a la pista.

Para medir en carrera: `node rl/race_eval.js models/v22/fase18.json` (22 autos, la mitad con la red y la mitad con
la IA de siempre; con `CARS=8` delante, 8 autos): posición media, toques y pasto.

### Historia

**Etapa 1** (`models/etapa1.json`, 60 millones de pasos, ~35 minutos): completa las vueltas en los 8 circuitos, en
promedio un 7 % más rápido que la IA de siempre a su mejor ritmo (de 1 % en Monza a 15 % en el Red Bull Ring; en
Interlagos, 66,2 s contra 70,4 s).

**Etapa 2** (`models/etapa2.json`, 35 millones de pasos más):

```bash
rl/.venv/bin/python rl/train.py --race --envs 4 --steps 40000000 --name etapa2 --resume rl/runs/etapa1c/model.zip \
    --fresh-opponents --critic-warmup 3000000 --lr 1e-4
```

Hicieron falta tres cosas para que la etapa 2 no desarmara lo aprendido:

- `--fresh-opponents`: los pesos que reciben los datos de los rivales nunca se entrenaron en la etapa 1 (siempre
  eran cero) y quedaron al azar; en cero, la red arranca manejando exactamente igual.
- `--critic-warmup`: con la recompensa nueva el crítico (la parte que estima cuánto va a ganar) está desajustado y
  sus errores desarman la parte que maneja; los primeros 3 millones de pasos sólo aprende el crítico.
- `--lr 1e-4` y pasos más cortos (`target_kl` 0,015).

Un premio por pasar y por defender le enseñó a zigzaguear y a meterse aunque hubiera contacto: por ahora no se usa.

Contra la etapa 1, en carreras de 22 autos se toca un 18 % menos y pisa un 26 % menos el pasto, con el mismo ritmo
(posición media 6,9 contra 7,2); con 8 autos, un 29 % menos de toques.

**Currículum** (`models/fase1.json` a `models/fase7.json`): red más grande (política 384×384, crítico 512×512),
autos con potencia, agarre y frenos algo distintos y gomas que se gastan, y fases que enseñan de a una cosa (manejar
sola, no chocar, pasar, carreras completas) y después tres fases más dedicadas a manejar limpio. La fase 7 tocaba un
44 % menos que la fase 1. Dos intentos más (`models/v3/`, `models/v4/`) priorizaron manejar limpio antes que rápido,
y el quinto (`models/v5/`, con el agarre por rueda y el pasto que frena) sumó ritmo en las largadas y una fase
contra rivales más rápidos: `models/v5/fase7.json` fue la red del juego, con un 36 % menos de toques que la v4, un
tercio del pasto y algo más rápida (en el juego los rivales llevan menos agarre y potencia). Detalle, resultados y
lo que salió mal en el camino: `rl/CURRICULO.md`.

Después vino el entrenamiento en manada (22 autos con la red, desde la v8; receta en `rl/curriculum.sh`, ~3 h:
`NOMBRE=v23 sh rl/curriculum.sh`). La red del juego hoy es la que diga `GAME_NET` en `src/drivers/policy.js`. En
`models/` queda sólo esa: las redes de las etapas y de los intentos anteriores (`models/etapa1.json`,
`models/fase1.json` a `fase7.json`, `models/v3/` a `models/v21/`) están en el historial de git, en el commit
e9ff553.
