# La física

Cómo se mueve el auto, cómo choca y cómo se rompe. Todo está en `src/sim/` y es lo mismo para vos, para los
rivales y para el entrenamiento de la red.

## Escala y modelo del auto

Cada circuito tiene una escala real en metros por celda, calculada con el largo real de la vuelta (de la
telemetría, o `lengthMeters`). Lo que puede hacer el auto sale de un **modelo físico calibrado con vueltas reales**
(`src/sim/dynamics.js`, ver "Calibración con vueltas reales"): carga y resistencia aerodinámicas que crecen con v² y
con la densidad del aire (la altura del circuito), dos alerones y un balance mecánico que elige cada uno (**puesta a
punto**), agarre por eje según la carga, potencia y tracción; y una caja de 8 marchas con RPM, corte y luces de
cambio (`src/sim/car.js`).

`dynamics.js` es un modelo chico, el de un simulador de vuelta:

- **Aerodinámica:** carga y resistencia = ½·ρ·C·v². Con los alerones al mínimo el auto tiene la carga del piso y
  la carrocería (`clMin`) y con los dos al máximo, ~45 % más (`clMax`). Cada alerón cobra en resistencia su carga
  sobre su eficiencia: el delantero casi nada, el trasero mucho. La densidad del aire ρ sale de la altura del
  circuito (`altitude` en `tracks/index.js`): en Interlagos hay ~9 % menos de aire que a nivel del mar.
- **Gomas:** cada rueda agarra `mu · carga^0,85` (cada kilo de más agarra un poco menos), con la carga aerodinámica
  repartida entre los ejes y el traslado de peso a las ruedas de afuera en las curvas. Con más agarre adelante que
  atrás el auto sobrevira; con menos, subvira. A lo largo agarran un poco más que de costado (`brakeMu`,
  `tractionMu`); la frenada y la tracción "a fondo" que usa la trazada son el 93 % y el 92 % de lo que aguantan.
- **Motor:** una potencia (empuja menos cuanto más rápido va); el turbo compensa casi todo el aire que falta en la
  altura. Cada kilo de nafta se suma al peso.

## Superficie por rueda

Cada rueda mira qué pisa (asfalto, piano, pasto, leca o escapatoria asfaltada; `SURFACES` en `src/sim/car.js` y
`surfaceAt` en `src/sim/track.js`). Cada eje agarra según sus dos ruedas (una trasera en el pasto suelta la cola,
una delantera quita dirección), cada rueda en el pasto frena y, si frena más de un lado, el auto tira para ese
lado; con las dos traseras en el pasto el motor no empuja más de ~90 km/h. La leca frena más y casi no deja doblar;
la escapatoria asfaltada agarra casi como la pista. Para el entrenamiento, las tres cuentan como fuera de la pista
(`car.grass`). Además: choques y gravedad en las pendientes.

## La estela de otro auto

Hasta 120 m atrás y 2,5 m de costado; a 20 m queda el 70 % y a 45 m, el 40 %. Hay menos resistencia del aire
(**rebufo**, hasta un 35 % pegado a él) pero también menos carga aerodinámica (**aire sucio**, que se nota sólo de
cerca: a 10 m se pierde ~30 % de la carga, a 20 m ~15 % y a 40 m casi nada, y más adelante que atrás; es lo
publicado de los F1 de 2023 en adelante). En la recta se gana velocidad; en una curva rápida, a 10 m de otro auto
se dobla un 19 % menos (a 20 m, 10 %) y el auto subvira, y la frenada se alarga. Vale para vos y para los rivales.

La carga también cambia con cómo va el auto: frenando se corre adelante (la trompa baja) y con el auto de costado
se pierde (hasta la mitad en un trompo). Y la **nafta** pesa: en carrera se carga la justa para las vueltas que son
(0,37 kg por km) y se gasta a 100 kg/h a fondo; con 100 kg el auto dobla ~6 % menos en las curvas rápidas.

## Balance

Al frenar el peso se pasa adelante y al acelerar, atrás (lo que dé la física: a fondo, 12 a 16 % del peso, con un
instante de demora por la suspensión), y en las curvas, a las ruedas de afuera (el **balance mecánico** de la
puesta a punto decide qué eje se lleva más de ese traslado). Cada rueda agarra según su carga, pero no en
proporción (el doble de carga da 1,8 veces el agarre), así que el eje que más traslada es el que menos agarra.
Además cada eje reparte su agarre entre frenar o empujar y doblar (**círculo de fricción**: √(frenada² + giro²) ≤
agarre; el motor empuja sólo con las de atrás). Los frenos reparten la frenada como la carga de cada eje en ese
momento, corrida adelante; cuánto, es el **reparto de frenada** de la puesta a punto.

## Bloqueos y patinamiento

Si a un eje se le pide frenar o empujar más de lo que agarra, sus ruedas se bloquean (o patinan): frenan o empujan
menos, casi no sostienen de costado (con las de adelante bloqueadas el auto sigue derecho; con las de atrás, la
cola se va), se recalientan y se gastan (un plano). El pedal de freno manda la fuerza de los frenos, y a fondo es
lo que aguantan las gomas a la velocidad punta, con toda la carga aerodinámica: a medida que el auto frena hay
menos carga y hay que ir soltándolo, o se bloquean (y antes sobre un piano, el pasto o en el aire sucio de otro).
Con el **ABS** (opciones; prendido por defecto, para el teclado, que frena todo o nada) los frenos sueltan solos
antes de bloquear. El motor puede más que las gomas hasta unos 140 km/h: sin control de tracción, a fondo en las
marchas bajas las traseras patinan y hay que dosificar.

## Temperatura y desgaste, rueda por rueda

Las gomas se calientan con lo que deslizan (doblando, frenando, empujando; mucho bloqueadas o patinando) y con
rodar cargadas, y el aire las enfría. Agarran todo entre 85 y 105 °C; salen de las mantas a 80 °C (la primera
vuelta agarran un poco menos), en una vuelta normal andan entre 87 y 103 °C de media y pasadas de temperatura
pierden hasta un 20 % y se gastan más rápido. Se calienta y se gasta más la de afuera de cada curva. Gastadas del
todo agarran 8 % menos y sobre el final (pasado el 85 %) se caen otro 6 %: manejando normal llegan al final de la
carrera con ~80 %, justo antes; el que las maltrata se queda sin gomas. El panel, al lado del velocímetro, muestra
las cuatro: el color es la temperatura (azul fría, verde en su punto, de amarilla a roja pasada), el número los
°C, la barrita lo que queda de goma y un borde blanco, que está bloqueada o patinando.

## Subviraje y sobreviraje

El eje delantero limita cuánto dobla el auto (si no alcanza, se va de trompa: subviraje); si al trasero no le
alcanza para sostener la curva, la cola se abre y el auto queda cruzado (sobreviraje) hasta que levantás el pie o
contravolanteás. La curva la tienen que sostener los dos ejes: con la cola corta (sin alerón trasero, o con una
puesta muy sobrevirante) el auto no dobla más que lo que aguanta la cola (con un 5 % de margen, cruzándose) y la
cola arrastrándose de costado frena. Lo que la cola gasta frenando o empujando no achica la curva: la abre. Y el
deslizamiento de costado lo frena sólo lo que le sobra a las gomas después de doblar: doblando al límite, el auto
se sigue abriendo. En una curva sin pedales da lo mismo que el agarre medido; lo que cambia es frenar fuerte
doblando (la cola se pone liviana), soltar el freno de a poco al entrar (la trompa muerde y el auto rota) y pisar
a fondo en una curva lenta (la cola se abre). El traslado de peso de costado también resta agarre, pero eso ya
está dentro del agarre lateral medido.

## Puesta a punto

En el menú, por circuito: alerón delantero y trasero de 1 a 10 y balance mecánico de -5 a 5 (las barras
estabilizadoras: qué eje se lleva más del traslado de peso de costado; es lo que queda para las curvas lentas,
donde casi no hay carga aerodinámica). Y el **reparto de frenada**, de -5 a 5: más adelante el auto frena más
estable pero bloquea antes las delanteras y frena un poco menos; más atrás frena más y rota al entrar a la curva,
hasta que se bloquean las de atrás. Cada circuito trae una recomendada, la que llevan los equipos (`tune` en
`tracks/index.js`: Monza 1/1, Barcelona 8/8…) y los rivales usan esa; la tuya se recuerda por circuito. Abajo de
los controles el menú dice cómo queda el auto: punta, agarre en curva rápida y si subvira o sobrevira en curvas
lentas y rápidas.

## Choques

`src/sim/collision.js`, con impulsos, como un motor de física 2D. Además de la velocidad de marcha, cada auto tiene
una velocidad de costado y un giro que le dejan los golpes, y que las gomas van frenando (más rápido cuanto más
agarre). Entre autos, cada uno es un juego de piezas de 5,6 × 2 m en total (alerón delantero, trompa, las cuatro
ruedas asomadas, pontones, caja y alerón trasero; `ZONES` en `src/sim/damage.js`): se detecta el choque pieza
contra pieza con el test de ejes separadores, el punto de contacto es el promedio de las esquinas que quedaron
dentro de la otra pieza, y el impulso depende de con qué velocidad se acercan ahí (con un poco de rebote y
rozamiento). **Rueda contra rueda** es distinto: la goma agarra mucho más y la parte que se toca gira más rápido
que el auto, así que el más rápido arrastra al más lento y los dos se tuercen; y si una delantera le pega de atrás
a una trasera, se trepa: pierde velocidad, queda girando y se rompe la suspensión. Si le pegás de atrás a alguien,
sale empujado; si el golpe es desplazado del centro, los autos giran, y uno fuerte te hace trompear.

Contra los muros, el auto son tres círculos a lo largo: un roce en ángulo casi no frena y lo endereza contra el
muro; de frente, frena y rebota. Apoyados sin acercarse, se deslizan sin frenarse.

## Daños

`src/sim/damage.js`, en el menú: no, reducidos o reales. Cada golpe rompe la pieza donde pega según qué tan fuerte
es (desde unos m/s de cambio de velocidad en el punto de contacto; los golpes se suman), con su lado (izquierda o
derecha) para cuando haya que dibujarlos:

- **alerón delantero:** los flaps primero, después entero. Se pierde su apoyo: en curva lenta casi no se nota y en
  las rápidas la trompa no dobla;
- **alerón trasero:** menos apoyo atrás (la cola se abre en las rápidas) y menos resistencia (más punta);
- **pontón y piso:** menos apoyo y el motor recalienta (rinde menos);
- **suspensión** de cada rueda: torcida, esa rueda agarra menos y el auto tira para un lado; rota, abandono;
- **pinchazo** (un alerón ajeno que corta la goma, o rueda contra rueda fuerte): la goma se desinfla en 4 s, agarra
  la mitad y frena.

Con daño de un solo lado el auto agarra distinto según para dónde dobla (en curva el peso va a las ruedas de
afuera). Un auto que abandona frena hasta pararse y a los 2 s lo sacan de la pista; en la tabla queda "AB". Con
daños reducidos todo se rompe a la mitad y nada del todo, sin pinchazos ni abandonos. Cuando tu auto tiene algo
roto aparece a la derecha un esquema visto desde arriba, cada pieza de su color (amarillo, naranja, rojo; rota,
sólo el contorno).

Con `?prueba` en la dirección, las teclas **1** a **9** rompen piezas (1–2 alerón delantero izquierdo/derecho, 3–4
trasero, 5–6 pontones, 7 pinchazo trasero izquierdo, 8 suspensión delantera derecha, 9 dirección rota) y **0**
arregla todo. Los umbrales se ajustaron con `JUEGO=1 DANOS=real GOLPES=1 node rl/race_eval.js models/v22/fase18.json`
(cuántos autos rompen algo por carrera y qué tan fuertes son los golpes en cada pieza).

## Calibración con vueltas reales

Los números del auto (`cars/f1-2025.json`) se ajustaron con `tools/calibrate.js` contra las poles de 2025 en los 8
circuitos (lo que ya bajó `tools/layout.py` a `tools/.cache/`):

```bash
node tools/calibrate.js          # cómo da el auto como está (y tools/.out/calibracion.html con los gráficos)
node tools/calibrate.js --fit    # busca los números que mejor ajustan y los escribe
```

Simula cada vuelta sobre la trazada que hace la red y la compara con la velocidad real a lo largo de la vuelta
(`tools/openf1.js`: las 5 mejores vueltas de la clasificación, proyectadas sobre el trazado), la punta con las
trampas de velocidad y además pide que la puesta a punto de cada circuito sea la más rápida ahí (así se ajusta
cuánto cuesta el alerón). Cosas a saber:

- La velocidad sale de las posiciones (~4 por segundo), no de la telemetría del auto: los tiempos bailan, así que
  está suavizada y la punta sale unos km/h de más (la de verdad es la de las trampas). Las frenadas no se pueden
  medir bien, así que la frenada y la sensibilidad a la carga quedan fijas en valores razonables.
- Las chicanas del juego (variantes de Monza, la última de Montreal) quedaron más abiertas que las reales: ahí el
  juego va más rápido y por eso el error cuenta lineal pasados los 15 km/h.
- La adherencia (`mu`) tiene tope en 1,9, lo que da una goma slick: sin tope el ajuste cambia carga aerodinámica
  por agarre mecánico. Con ese tope el auto tiene más carga (iguala a su peso a ~165 km/h) y menos agarre en lento.
- Resultado: punta de 310 a 355 km/h según el circuito (como las trampas), ~2,0 g en curva lenta, ~5 g a 250 km/h
  y ~6,2 g a 300 km/h, frenadas de hasta ~6 g, y vueltas simuladas de -4,3 a +0,7 s de la pole (lo más rápido, en
  los circuitos de chicanas).

`node tools/lapcompare.js` grafica la pole real contra la red del juego dando una vuelta (`tools/.out/vueltas.html`).

Las marchas y RPM siguen saliendo de `tools/car_profile.py` (las 15 vueltas más rápidas de una carrera en OpenF1:
`python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json`), que además mide aceleración, frenada y agarre
lateral, lo que usaba la física de antes.
