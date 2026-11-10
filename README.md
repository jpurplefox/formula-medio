# Fórmula ½

Juego de carreras para el navegador con un motor de render "a la antigua" (un rayo por columna de pantalla).
Los circuitos de F1 se arman con el **trazado real**, sacado de la telemetría (forma, largo de vuelta y alturas).

## Jugar

```bash
python3 serve.py
```

Abrir http://localhost:8123. Hace falta un servidor local porque el juego lee los píxeles de la imagen.
`serve.py` le pide al navegador que no cachee, así cada recarga usa la última versión.

Publicado en AWS (S3 + CloudFront) en cada push a `main`: ver [docs/deployment.md](docs/deployment.md).

Antes de largar hay un **menú** (que se acuerda de lo último que elegiste). La pantalla principal muestra el
modo, el **auto** elegido (el modelo 3D con su decoración) y el **circuito** (su trazado); tocando cada uno se abre su
pantalla para cambiarlo (con ← → o las flechas, y el auto se puede girar arrastrándolo). La **puesta a punto** y las
**opciones** (dificultad, rivales, vueltas, cámara, daños, ayudas y sonido) van en pantallas aparte; Enter o Esc vuelven a la principal
(`src/menuview.js` dibuja el auto y los trazados):
- **Modo:** **Carrera** (por defecto, vos y un auto de cada equipo rival; con la grilla completa, 22 autos; con tabla
  de posiciones y repetición al final) o **Contrarreloj**
  (solo en pista, vueltas sin límite y un **fantasma** semitransparente que repite tu mejor vuelta, para ver
  dónde ganás o perdés tiempo). En carrera no hay fantasma.
- **Equipo:** Hierrari, Merchoedes, Red Toro, McLarrón, Austin Martini, Allpain, Willyams, Audiós, Haash,
  AlfaTorito o Cadillaque, cada uno con sus colores (carrocería, detalles de la decoración y casco) y sus dos
  pilotos, inventados a partir de la grilla de 2026, con sus números (Jorge Rústico y Kimi Antojo en Merchoedes,
  Carlos Le Clic y Luis Jamónton en Hierrari, Max Verstapón, Lando Nórdico, Franco Colapuntos…; `src/teams.js`). Como en la F1, la cámara de arriba (la "T") es negra en el primer auto de cada equipo y
  amarilla en el segundo, como en la grilla de 2026. Al elegir el auto elegís también cuál de los dos pilotos sos. Por
  defecto corrés contra 10 rivales, el primer piloto de cada uno de los otros equipos; con 21, la grilla completa: los
  dos autos de cada uno de los otros equipos y tu compañero. Los equipos que mejor vienen en el campeonato (`STANDINGS` en `src/teams.js`,
  hoy Merchoedes primero) suelen largar adelante (con algo de azar, como en una clasificación) y tienen los mejores
  autos dentro de la dificultad elegida. La tabla muestra la sigla de cada piloto y el resultado, su nombre.
- **Dificultad:** Fácil, Normal, Difícil o Experto. Con la red entrenada (la de por defecto) cambia el agarre y la
  potencia de los rivales: en Fácil, de 0,9 veces los tuyos (el mejor equipo) a 0,85 (el peor); en Experto, de 1,1
  a 1,06. Con la IA de siempre, su ritmo (en Interlagos, de vueltas de ~75–80 s en Fácil a ~69–70 s en Experto).
- **Circuito:** Interlagos, Monza, Albert Park, Barcelona, Montreal, Spa, Silverstone o Red Bull Ring, todos con
  alturas reales; y **vueltas** (1, 3, 5 o 10).
- **Rivales:** 1, 3, 7, 11 o 21 (la grilla completa). Con menos se toman repartidos a lo largo del campeonato, así
  sigue habiendo autos rápidos y lentos; con uno solo, es un mano a mano con el del mejor equipo. Dificultad,
  vueltas y rivales son sólo para carrera.
- **Caja de cambios:** automática o manual. Se elige acá y queda fija durante la carrera.
- **Sonido:** prendido o apagado y volumen general, de los motores y de la música del menú. Arranca siempre
  apagado (se prende con N o desde el menú); los volúmenes sí se recuerdan.

**Enter** larga y **Esc** vuelve al menú durante la carrera.

**Largada:** el semáforo es como el de la F1: se prenden 5 luces rojas, una por segundo, y después de una espera
al azar (de 0,4 a 2,6 s) se apagan todas. Con las luces prendidas, el acelerador sube las vueltas del motor sin
mover el auto. Cuando se apagan, la largada depende de las rpm en ese momento: entre **9.500 y 10.500** sale
perfecta; con pocas vueltas el motor se ahoga, y cerca del corte las gomas patinan (en los dos casos llega menos
aceleración al piso durante el primer segundo y medio). Si no estabas acelerando, largás cuando acelerás (con el
motor bajo de vueltas). Las luces de cambio del volante y del panel muestran las rpm. Los rivales también suben de vueltas, cada uno a su manera, y reaccionan con su propio tiempo.

Es una carrera de 22 autos: largás último en la grilla. A la izquierda, debajo de los tiempos,
está la **tabla de posiciones** con la distancia (en segundos) de cada auto con el de adelante: cada auto anota a
qué hora pasó por cada punto de la pista, y la diferencia es cuánto hace que el de adelante pasó por donde está
ahora el de atrás (si lo doblaron, dice "+1 V"). El panel muestra tu posición y al
terminar aparece el resultado y, unos segundos después, la **repetición** de la carrera. R reinicia la carrera.

Controles (flechas, WASD o IJKL): I/↑/W acelerar · K/↓/S frenar y marcha atrás · J L/←→/A D doblar · R reiniciar.

**Joystick** (Xbox, PlayStation o cualquiera con el mapeo estándar): gatillo derecho acelera, izquierdo frena y la
palanca izquierda dobla, los tres **progresivos** (se puede ir a medio acelerador, frenar un poco o doblar apenas).
RB/R1 sube de marcha, LB/L1 baja (con la caja manual), Y/△ cambia la cámara, X/□ la trazada, Start larga o abre el menú, Back/Share
reinicia y la cruceta elige el auto en la repetición. La palanca tiene zona muerta y dobla menos cerca del centro,
para corregir fino a alta velocidad. Con teclado los pedales son todo o nada, pero el acelerador tarda 1/3 s en
abrirse (como el pie), así pisar en plena curva no suelta la cola de golpe.

## Cómo funciona

1. **Trazado → mapa** (`src/track.js`): los circuitos de F1 traen la línea central en metros
   (`tracks/<id>.layout.json`, ver "Trazados reales desde la telemetría de F1") y se dibujan en una grilla de
   celdas de 2 m. Un circuito sin telemetría sale de una imagen, que se reduce a una grilla (1 celda = `scale` píxeles):
   los píxeles oscuros son pista, se queda con el trazado más grande (descarta números y textos), tapa huecos
   chicos y le saca la línea central. En los dos casos la pista es una cinta del ancho del circuito alrededor de
   la línea central (puede variar por tramo); alrededor pone la escapatoria (`runoff` celdas) y después un guardrail.
   La escapatoria es de asfalto por fuera de las curvas lentas, de leca por fuera de las rápidas que vienen después
   de una recta y de pasto en el resto (`surfaces` en `tracks/index.js` lo cambia por tramo).
   Además calcula, por celda:
   - la **distancia con signo al borde** de la pista (para dibujar bordes suaves),
   - el **progreso** a lo largo de la vuelta (para validar vueltas, contramano y las franjas de los pianos),
   - dónde van los **pianos**: se calcula la curvatura de la línea central y se ponen del lado de adentro
     en las curvas cerradas y del lado de afuera a la salida de las más fuertes; en las rectas, línea blanca,
   - los **carteles de frenada** (200, 150, 100 y 50 m): antes de cada curva cerrada (radio < 110 m) que venga
     después de una recta de al menos 250 m, del lado de afuera. Se ajusta con las constantes `BOARD_*`,
   - la **altura**, a partir del perfil de elevación.
2. **Render Voxel Space** (`src/renderer.js`), la técnica de *Comanche* (1992), primo del raycasting de
   *Wolfenstein 3D*: por cada columna se recorre el mapa con un rayo de cerca hacia lejos, se lee la altura del
   terreno y se pinta lo que todavía no estaba tapado. El color de cada punto lo decide una función tipo
   *fragment shader* (asfalto, pianos, pasto, línea a cuadros) con sombreado según la pendiente.
   Las texturas (asfalto, césped, muros) se generan por código en `src/textures.js`, con *mipmaps* para que no
   titilen a lo lejos; el césped tiene franjas de corte. La goma sobre el asfalto (`src/rubber.js`) arranca como una
   franja tenue sobre la trazada ideal (como si antes hubiera corrido otra categoría) y se va marcando por donde pasan
   las ruedas de cada auto, más en frenadas, curvas y salidas: a las 3 vueltas ya se ve la línea de carrera y a las
   10 está bien negra.
   Los árboles y los carteles son sprites. Los autos (el tuyo, los rivales y el fantasma) son **modelos 3D** de unas mil caras,
   armados en código con secciones redondeadas, tubos y cilindros (`src/carmodel.js`: trompa, pontones, alerones
   de varios elementos, halo, espejos, suspensión, piloto con casco, visera, alerón y collar HANS, y ruedas con llanta de rayos) y dibujados por un rasterizador propio
   dentro del mismo renderer: misma cámara, sombreado plano según el sol, z-buffer entre sus piezas y recorte contra
   el terreno, así las lomas y los muros los tapan. Tienen texturas con corrección de perspectiva: la decoración
   (`src/livery.js`: franja, número, sponsors, generada por código en un canvas) en la carrocería, fibra de carbono
   en los alerones, el piso, el halo y la suspensión, y el flanco de las gomas con la franja del compuesto y la marca FIRELLO
   que gira con la rueda. El piloto gira la cabeza: sigue al auto de adelante si está cerca y dentro de ±10° de su
   rumbo; si no, mira el vértice de la próxima curva (el punto más lento de la trazada en los próximos 140 m);
   si no hay curva, de frente. Las gomas tienen los hombros redondeados (el perfil va de la banda plana al flanco en un
   cuarto de círculo) y la banda lleva caucho gastado con marcas de goma arrastrada, que dejan ver que gira. Con
   WebGL las gomas se gastan durante la carrera: largan lisas y brillantes, el brillo se va antes de terminar la
   primera vuelta y las marcas aparecen de a poco hasta estar completas al empezar la última. Con WebGL todo el
   auto se ilumina con normales suavizadas, así lo redondeado (halo, gomas, carrocería) no se ve en facetas. Las
   tomas de los pontones tienen un labio redondeado alrededor de la abertura oscura, inclinadas hacia atrás.
   Los brazos de la suspensión son perfiles ovalados y chatos; los espejos, una cáscara redondeada con el vidrio
   hundido en un marco, que con WebGL refleja el entorno como un espejo convexo. La llanta tiene un aro de metal que
   sobresale, la cara hundida con diez rayos de a pares y el disco de freno ranurado detrás (dibujados en una
   textura que gira con la rueda) y la tuerca central del color de los detalles del equipo. Cada cara toma sus coordenadas de textura proyectándose desde arriba o de costado. La vista de cabina usa el mismo modelo, visto desde los ojos del
   piloto (sin el casco), con el volante dibujado encima. Las cuentas de cámara usan una imagen virtual de 960×540.
   **Con WebGL** (`src/glrenderer.js`, lo normal): todo se dibuja en la placa de video, a la resolución de la
   pantalla (hasta 1440×810). El terreno es un *shader* que corre una vez por píxel: arma el rayo de la cámara,
   avanza sobre el mapa de alturas (un paso de unos píxeles, que cerca de los muros se achica según la distancia al
   borde, así no los saltea) y afina dónde choca; el color del piso es el mismo "shader" de `renderer.js` en GLSL.
   Autos, árboles, carteles y sombras son triángulos con la misma proyección y la misma profundidad, así el z-buffer
   de la placa resuelve qué tapa a qué. Los autos tienen **reflejos**: la pintura y el casco (y un poco el carbono)
   reflejan un entorno inventado (asfalto abajo, una franja de árboles en el horizonte y el cielo arriba), más de
   costado que de frente, con normales suavizadas para que el reflejo corra parejo, y un brillo donde rebota el sol.
   El volante y el semáforo van en un canvas 2D encima.
   **Sin WebGL** (o agregando `?cpu` a la dirección) se usa el renderer de procesador: el cielo y el terreno se
   reparten entre varios **Web Workers** (uno por núcleo, hasta 6; `src/terrainworker.js`), cada uno dibuja una
   franja de columnas y el hilo principal arma la imagen y dibuja encima los sprites y los autos. Las ruedas giran,
   las delanteras doblan lo que hace falta para el giro del auto (mucho despacio, apenas a fondo), todo el auto sigue la pendiente y la carrocería (no las ruedas, que quedan apoyadas) se mueve sobre la
   suspensión: se inclina hacia afuera en las curvas según la aceleración de costado (hasta 1,5°) y baja la trompa
   al frenar (hasta 1,1°), con un resorte amortiguado; desde la cabina, el cabeceo mueve la vista, y el auto
   proyecta su sombra sobre el piso.
3. **Escala y física** (`src/car.js`): cada circuito tiene una escala real en metros por celda, calculada con el
   largo real de la vuelta (de la telemetría, o `lengthMeters`). Lo que puede hacer el auto sale de un **modelo
   físico calibrado con vueltas reales** (`src/dynamics.js`, ver abajo): carga y resistencia aerodinámicas que
   crecen con v² y con la densidad del aire (la altura del circuito), dos alerones y un balance mecánico que elige
   cada uno (**puesta a punto**), agarre por eje según la carga, potencia y tracción; y una caja de 8 marchas con
   RPM, corte y luces de cambio.
   **Superficie por rueda**: cada rueda mira qué pisa (asfalto, piano, pasto, leca o escapatoria asfaltada;
   `SURFACES` en `src/car.js` y `surfaceAt` en `src/track.js`). Cada eje agarra según sus dos ruedas (una trasera
   en el pasto suelta la cola, una delantera quita dirección), cada rueda en el pasto frena y, si frena más de un
   lado, el auto tira para ese lado; con las dos traseras en el pasto el motor no empuja más de ~90 km/h. La leca
   frena más y casi no deja doblar; la escapatoria asfaltada agarra casi como la pista. Para el entrenamiento, las
   tres cuentan como fuera de la pista (`car.grass`).
   Además: choques y gravedad en las pendientes.

   **La estela de otro auto** (hasta 120 m atrás y 2,5 m de costado; a 20 m queda el 70 % y a 45 m, el 40 %): hay
   menos resistencia del aire (**rebufo**, hasta un 35 % pegado a él) pero también menos carga aerodinámica (**aire
   sucio**, que se nota sólo de cerca: a 10 m se pierde ~30 % de la carga, a 20 m ~15 % y a 40 m casi nada, y más
   adelante que atrás; es lo publicado de los F1 de 2023 en adelante). En la recta se gana velocidad; en una curva
   rápida, a 10 m de otro auto se dobla un 19 % menos (a 20 m, 10 %) y el auto subvira, y la frenada se alarga. Vale
   para vos y para los rivales.
   La carga también cambia con cómo va el auto: frenando se corre adelante (la trompa baja) y con el auto de costado
   se pierde (hasta la mitad en un trompo). Y la **nafta** pesa: en carrera se carga la justa para las vueltas que
   son (0,37 kg por km) y se gasta a 100 kg/h a fondo; con 100 kg el auto dobla ~6 % menos en las curvas rápidas.

   **Balance:** al frenar el peso se pasa adelante y al acelerar, atrás (lo que dé la física: a fondo, 12 a 16 % del
   peso, con un instante de demora por la suspensión), y en las curvas, a las ruedas de afuera (el **balance
   mecánico** de la puesta a punto decide qué eje se lleva más de ese traslado). Cada rueda agarra según su carga,
   pero no en proporción (el doble de carga da 1,8 veces el agarre), así que el eje que más traslada es el que menos
   agarra. Además cada eje reparte su agarre entre frenar o empujar y doblar (**círculo de fricción**:
   √(frenada² + giro²) ≤ agarre; el motor empuja sólo con las de atrás). Los frenos reparten la frenada como la carga
   de cada eje en ese momento, corrida adelante; cuánto, es el **reparto de frenada** de la puesta a punto.

   **Bloqueos y patinamiento:** si a un eje se le pide frenar o empujar más de lo que agarra, sus ruedas se bloquean
   (o patinan): frenan o empujan menos, casi no sostienen de costado (con las de adelante bloqueadas el auto sigue
   derecho; con las de atrás, la cola se va), se recalientan y se gastan (un plano). El pedal de freno manda la
   fuerza de los frenos, y a fondo es lo que aguantan las gomas a la velocidad punta, con toda la carga
   aerodinámica: a medida que el auto frena hay menos carga y hay que ir soltándolo, o se bloquean (y antes sobre un
   piano, el pasto o en el aire sucio de otro). Con el **ABS** (opciones; prendido por defecto, para el teclado, que
   frena todo o nada) los frenos sueltan solos antes de bloquear. El motor puede más que las gomas hasta unos 140 km/h: sin control de tracción, a fondo en las marchas
   bajas las traseras patinan y hay que dosificar.

   **Temperatura y desgaste, rueda por rueda:** las gomas se calientan con lo que deslizan (doblando, frenando,
   empujando; mucho bloqueadas o patinando) y con rodar cargadas, y el aire las enfría. Agarran todo entre 85 y
   105 °C; salen de las mantas a 80 °C (la primera vuelta agarran un poco menos), en una vuelta normal andan entre
   87 y 103 °C de media y pasadas de temperatura pierden hasta un 20 % y se gastan más rápido. Se calienta y se gasta más la
   de afuera de cada curva. Gastadas del todo agarran 8 % menos y sobre el final (pasado el 85 %) se caen otro 6 %:
   manejando normal llegan al final de la carrera con ~80 %, justo antes; el que las maltrata se queda sin gomas. El panel, al
   lado del velocímetro, muestra las cuatro: el color es la temperatura (azul fría, verde en su punto, de amarilla
   a roja pasada), el número los °C, la barrita lo que queda de goma y un borde blanco, que está bloqueada o
   patinando. El eje delantero limita cuánto dobla el auto (si no alcanza, se va de
   trompa: subviraje); si al trasero no le alcanza para sostener la curva, la cola se abre y el auto queda cruzado
   (sobreviraje) hasta que levantás el pie o contravolanteás. La curva la tienen que sostener los dos ejes: con la
   cola corta (sin alerón trasero, o con una puesta muy sobrevirante) el auto no dobla más que lo que aguanta la
   cola (con un 5 % de margen, cruzándose) y la cola arrastrándose de costado frena. Lo que la cola gasta frenando
   o empujando no achica la curva: la abre. Y el deslizamiento de costado lo frena sólo lo que le sobra a las gomas
   después de doblar: doblando al límite, el auto se sigue abriendo. En una curva sin pedales da lo mismo que el agarre
   medido; lo que cambia es frenar fuerte doblando (la cola se pone liviana), soltar el freno de a poco al entrar
   (la trompa muerde y el auto rota) y pisar a fondo en una curva lenta (la cola se abre). El traslado de peso de
   costado también resta agarre, pero eso ya está dentro del agarre lateral medido.
4. **Choques** (`src/collision.js`): con impulsos, como un motor de física 2D. Además de la velocidad de marcha,
   cada auto tiene una velocidad de costado y un giro que le dejan los golpes, y que las gomas van frenando (más
   rápido cuanto más agarre). Entre autos, cada uno es un juego de piezas de 5,6 × 2 m en total (alerón
   delantero, trompa, las cuatro ruedas asomadas, pontones, caja y alerón trasero; `ZONES` en `src/damage.js`): se
   detecta el choque pieza contra pieza con el test de ejes separadores, el punto de contacto es el promedio de las
   esquinas que quedaron dentro de la otra pieza, y el impulso depende de con qué velocidad se acercan ahí (con un
   poco de rebote y rozamiento). **Rueda contra rueda** es distinto: la goma agarra mucho más y la parte que se
   toca gira más rápido que el auto, así que el más rápido arrastra al más lento y los dos se tuercen; y si una
   delantera le pega de atrás a una trasera, se trepa: pierde velocidad, queda girando y se rompe la suspensión. Si le pegás de atrás
   a alguien, sale empujado; si el golpe es desplazado del centro, los autos giran, y uno fuerte te hace trompear.
   Contra los muros, el auto son tres círculos a lo largo: un roce en ángulo casi no frena y lo endereza contra el
   muro; de frente, frena y rebota. Apoyados sin acercarse, se deslizan sin frenarse.
5. **Daños** (`src/damage.js`, en el menú: no, reducidos o reales): cada golpe rompe la pieza donde pega según qué
   tan fuerte es (desde unos m/s de cambio de velocidad en el punto de contacto; los golpes se suman), con su lado
   (izquierda o derecha) para cuando haya que dibujarlos:
   - **alerón delantero:** los flaps primero, después entero. Se pierde su apoyo: en curva lenta casi no se nota y
     en las rápidas la trompa no dobla;
   - **alerón trasero:** menos apoyo atrás (la cola se abre en las rápidas) y menos resistencia (más punta);
   - **pontón y piso:** menos apoyo y el motor recalienta (rinde menos);
   - **suspensión** de cada rueda: torcida, esa rueda agarra menos y el auto tira para un lado; rota, abandono;
   - **pinchazo** (un alerón ajeno que corta la goma, o rueda contra rueda fuerte): la goma se desinfla en 4 s,
     agarra la mitad y frena.

   Con daño de un solo lado el auto agarra distinto según para dónde dobla (en curva el peso va a las ruedas de
   afuera). Un auto que abandona frena hasta pararse y a los 2 s lo sacan de la pista; en la tabla queda "AB". Con
   daños reducidos todo se rompe a la mitad y nada del todo, sin pinchazos ni abandonos. Cuando tu auto tiene algo
   roto aparece a la derecha un esquema visto desde arriba, cada pieza de su color (amarillo, naranja, rojo; rota,
   sólo el contorno). Con `?prueba` en la dirección, las teclas **1** a **9** rompen piezas (1–2 alerón delantero
   izquierdo/derecho, 3–4 trasero, 5–6 pontones, 7 pinchazo trasero izquierdo, 8 suspensión delantera derecha, 9
   dirección rota) y **0** arregla todo. Los umbrales se ajustaron con
   `JUEGO=1 DANOS=real GOLPES=1 node rl/race_eval.js models/v5/fase7.json` (cuántos autos rompen algo por carrera
   y qué tan fuertes son los golpes en cada pieza).

Cambios, con la caja manual: **O** o **X** sube, **U** o **Z** baja (la caja, automática o manual, se elige en el menú y no se cambia en carrera). **C** alterna la vista de cabina y la exterior (cada carrera larga con la que elegiste en Opciones, cabina si no elegiste ninguna). **G** muestra u oculta la trazada ideal.
Las teclas se reconocen por la letra y por su posición, así funcionan con cualquier distribución de teclado.

## Sonido

Los motores se sintetizan con Web Audio, sin archivos de sonido (`src/audio.js`). Un V6 de 4 tiempos hace 3
explosiones por vuelta, así que el tono es rpm / 20 Hz (200 Hz en ralentí, 600 Hz a 12.000 rpm). Cada motor mezcla:
ese tono con muchos armónicos, el giro del cigüeñal (un tercio) y medio tono (ninguna explosión es igual a otra),
ruido que late al ritmo de las explosiones (la aspereza del escape), un temblor mínimo del tono y el soplido del
turbo; todo apenas saturado, con dos resonancias del escape y un filtro que se abre con las rpm y el acelerador.
Al soltar el acelerador el sonido pasa de a poco (~150 ms) a la retención, más apagado y un poco más bajo.
Encima, sonidos sueltos: al **subir de marcha**, un corte de una fracción de segundo con un golpe seco; al **bajar**,
un acelerón corto y a veces una explosión suave (en una frenada con muchos rebajes seguidos, no en cada uno); al
**soltar el acelerador** a muchas vueltas, un petardeo breve del escape; y en el **corte de rpm**, el tartamudeo
del encendido. Cada auto tiene su propio motor (suenan a la vez los 8 más cercanos a la cámara) y se escucha
desde la cámara: más bajo cuanto más lejos, a la izquierda o a la derecha según dónde esté, más apagado si está
detrás y con efecto Doppler. En la repetición suenan igual, desde la cámara que se esté viendo. **N** silencia.

En el menú suena **"Gran Premio"**, un tema original de estilo cinematográfico, también sintetizado
(`src/music.js`): Re menor, 140 bpm, 16 compases. Arranca con una introducción de cuerdas en ostinato "al galope",
timbales y un coro que crece; sigue el tema, con la melodía en los metales, taikos y platillo; y cierra con golpes
de metales y un redoblante que crece hasta volver a empezar. Todo pasa por una reverberación de sala. Las notas se programan con el reloj del audio un poquito antes de que suenen,
así no se atrasan aunque el juego esté ocupado. Se apaga de a poco al largar y vuelve al volver al menú.

## Repetición

Durante la carrera se graba la posición, el rumbo, el volante y la velocidad de todos los autos 30 veces por
segundo (`src/replay.js`). Al terminar, después del resultado, se reproduce en loop interpolando entre muestras,
con varias cámaras:
- **TV:** fijas al costado de la pista, en altura, cada ~230 m; sigue la más cercana al auto, con zoom según la
  distancia (el renderer acepta un zoom: achica el campo de visión, como un teleobjetivo).
- **Persecución**, **A bordo** (arriba de la toma de aire), **Helicóptero** y **Frontal** (mirando al auto de frente).
- **Automática:** un director que va alternando las tomas cada 5 s.

Controles: **C** cambia la cámara, **←/→** (o J/L) el auto que se sigue, **R** empieza otra carrera.

## Rivales

Los rivales manejan con la red entrenada por refuerzo (ver "IA por refuerzo"). La IA de siempre, que sigue
disponible con `?ia=clasica`, se describe acá: cada rival (`src/ai.js`) es un auto con la misma física que el tuyo, manejado por un piloto automático:
- **Volante:** persigue un punto de la trazada ideal unos metros más adelante (*pure pursuit*) y gira lo
  justo para llegar, dentro de lo que permite el agarre.
- **Pedales:** acelera o frena para ir a la velocidad que la trazada indica en ese punto, multiplicada por su
  ritmo (`pace`, en `RIVALS` de `src/main.js`: de 1,06 a 0,98, vueltas de ~69,6 a ~72 s en Interlagos), con
  pequeñas variaciones de ritmo y de línea. Su trazada es la misma que ves, pero frenando más al límite (93% en
  vez de 85%), y en las curvas lentas no pasan de 0,975 de esa velocidad, porque más rápido se abren y salen.
- **Tráfico:** si alcanza a otro auto, se abre hacia el lado donde ya está (o donde hay más lugar) para pasarlo;
  a la par, cada uno se queda de su lado (y si no entran los dos, el que va un poco atrás levanta); si no hay
  lugar para pasar, se queda detrás guardando distancia.
- **A la par:** si el otro le lleva más de media trompa y no lo está pasando, cede y se ubica detrás.
- Si un rival se queda trabado, vuelve a la pista sobre la trazada.

## IA entrenada con aprendizaje por refuerzo (`rl/`)

Una red neuronal aprende a manejar sola, con la misma física del juego, por etapas:
1. **Sola en pista** (contrarreloj): aprende a dar la vuelta lo más rápido posible en los 8 circuitos.
2. **Contra otros autos** (`rl/race.js`): carreras de 4 autos que aprenden (la misma red, contra sí misma) y de 0 a 6
   rivales con la IA de siempre a ritmos variados; largan en grilla, en fila o repartidos por la pista. Además de
   los metros, se castigan los toques entre autos (mucho más al que le pega al de adelante).

**Qué ve** (`src/sensors.js`, 98 números; las redes entrenadas antes del agarre por rueda usan los primeros 94): su auto (velocidad, deslizamiento, giro, volante, pedales, marcha,
rpm, agarre de cada eje, rebufo, cuánto mejor o peor es que el promedio y el desgaste de las gomas), su posición en la pista, cuánto dobla la pista a 20, 40… 450 m (lo que un piloto
sabe de memoria), 19 rayos que miden la distancia al borde de la pista de -90° a +90°, y los 6 rivales más
cercanos (posición, velocidad relativa y hacia dónde apuntan; en la etapa 1 quedan en cero) y el agarre de cada
rueda según lo que pisa (así sabe de qué lado se fue al pasto).
**Qué decide**: volante y pedal (de frenar a fondo a acelerar a fondo), 20 veces por segundo, progresivos.
**Qué la premia** (`rl/env.js`): los metros que avanza sobre la línea central; la castigan el pasto, los golpes
contra el muro y quedarse quieta o ir para atrás. Cada episodio larga en un punto cualquiera de un circuito al azar.

Cómo se entrena: Python con PyTorch y stable-baselines3 (algoritmo PPO) le pasa las acciones a varios procesos de
Node (`rl/worker.js`) que simulan 128 autos a la vez; en una Mac M4 Pro van unos 30.000 pasos por segundo.

```bash
python3 -m venv rl/.venv && rl/.venv/bin/pip install torch stable-baselines3 gymnasium tensorboard
```

1. Los circuitos de F1 se arman en Node desde `tracks/*.layout.json`. Sólo los que salen de una imagen
   necesitan exportarse antes (la parte que necesita el navegador): con `serve.py` corriendo, abrir
   `http://localhost:8123/rl/bake.html` (guarda las máscaras en `rl/tracks/`).
2. Entrenar: `rl/.venv/bin/python rl/train.py --steps 30000000 --name etapa1` (las curvas, con
   `rl/.venv/bin/tensorboard --logdir rl/runs`).
3. Exportar la red a JSON: `rl/.venv/bin/python rl/export.py rl/runs/etapa1/model.zip models/etapa1.json`.
4. Medirla contra la IA de siempre: `node rl/eval.js models/etapa1.json`.
5. Verla en el juego: `http://localhost:8123/?ia=models/etapa1.json` (los rivales manejan con esa red). Sin `?ia`
   manejan con la red elegida (`CURRENT_NET` en `src/main.js`, hoy `models/v5/fase7.json`); con `?ia=clasica`,
   con la IA de siempre (`src/ai.js`), que es también la que queda si la red no carga.

Para que el entrenamiento no se desarme (PPO es inestable), la tasa de aprendizaje baja de a poco hasta 0, cada
actualización usa 32.768 pasos y las recompensas se normalizan; conviene igual medir los puntos de control con
`rl/eval.js` y quedarse con el mejor. Cada episodio larga en cualquier punto de la vuelta, a veces parado o
cruzado y con ruedas afuera, para que aprenda también a largar y a volver a la pista.

Para medir en carrera: `node rl/race_eval.js models/etapa2.json` (22 autos, la mitad con la red y la mitad con la
IA de siempre; con `CARS=8` delante, 8 autos): posición media, toques y pasto.

**Etapa 1** (`models/etapa1.json`, 60 millones de pasos, ~35 minutos): completa las vueltas en los 8 circuitos,
en promedio un 7 % más rápido que la IA de siempre a su mejor ritmo (de 1 % en Monza a 15 % en el Red Bull Ring;
en Interlagos, 66,2 s contra 70,4 s).

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

**Currículum** (`models/fase1.json` a `models/fase7.json`): red más grande (política 384×384,
crítico 512×512), autos con potencia, agarre y frenos algo distintos y gomas que se gastan, y fases que enseñan de a
una cosa (manejar sola, no chocar, pasar, carreras completas) y después tres fases más dedicadas a manejar limpio.
La fase 7 tocaba un 44 % menos que la fase 1. Dos intentos más (`models/v3/`, `models/v4/`) priorizaron manejar
limpio antes que rápido, y el quinto (`models/v5/`, con el agarre por rueda y el pasto que frena) sumó ritmo en las
largadas y una fase contra rivales más rápidos: **`models/v5/fase7.json` es la red del juego**, con un 36 % menos de
toques que la v4, un tercio del pasto y algo más rápida (en el juego los rivales llevan menos agarre y potencia).
Para volver a entrenarla desde cero: `NOMBRE=v6 sh rl/curriculum.sh` (~3 h). Detalle, resultados y lo que salió
mal en el camino: `rl/CURRICULO.md`.

## Trazada ideal

`src/racingline.js` calcula, al cargar el circuito, la trazada curva por curva como la hacen los pilotos: se llega
por el lado de afuera, se toca el vértice (el punto más cerrado) del lado de adentro y se sale abriendo de nuevo
(en las eses, de vértice a vértice), con un suavizado final que saca los zigzags. Después calcula la velocidad
máxima en cada punto con los límites del auto (`src/lapsim.js`): lo que aguanta el agarre en la curva, cuánto hay que frenar antes y cuánto acelera el motor después.
En el juego es una cinta semitransparente que flota un poco sobre el asfalto, con los bordes difusos (sin WebGL,
se pinta sobre el piso), y cambia de color según tu velocidad: **verde** se puede acelerar,
**amarillo** mantener o levantar, **rojo** hay que frenar. **G** la muestra u oculta.

## Física calibrada con vueltas reales

`src/dynamics.js` es un modelo chico, el de un simulador de vuelta:

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

**Puesta a punto** (menú, por circuito): alerón delantero y trasero de 1 a 10 y balance mecánico de -5 a 5 (las
barras estabilizadoras: qué eje se lleva más del traslado de peso de costado; es lo que queda para las curvas
lentas, donde casi no hay carga aerodinámica). Y el **reparto de frenada**, de -5 a 5: más adelante el auto
frena más estable pero bloquea antes las delanteras y frena un poco menos; más atrás frena más y rota al entrar a
la curva, hasta que se bloquean las de atrás. Cada circuito trae una
recomendada, la que llevan los equipos (`tune` en `tracks/index.js`: Monza 1/1, Barcelona 8/8…) y los rivales usan esa; la tuya
se recuerda por circuito. Abajo de los controles el menú dice cómo queda el auto: punta, agarre en curva rápida y
si subvira o sobrevira en curvas lentas y rápidas.

Los números del auto (`cars/f1-2025.json`) se ajustaron con `tools/calibrate.js` contra las poles de 2025 en los
8 circuitos (lo que ya bajó `tools/layout.py` a `tools/.cache/`):

```bash
node tools/calibrate.js          # cómo da el auto como está (y tools/.out/calibracion.html con los gráficos)
node tools/calibrate.js --fit    # busca los números que mejor ajustan y los escribe
```

Simula cada vuelta sobre la trazada que hace la red y la compara con la velocidad real a lo largo de la vuelta
(tools/openf1.js: las 5 mejores vueltas de la clasificación, proyectadas sobre el trazado), la punta con las
trampas de velocidad y además pide que la puesta a punto de cada circuito sea la más rápida ahí (así se ajusta
cuánto cuesta el alerón). Cosas a saber:

- La velocidad sale de las posiciones (~4 por segundo), no de la telemetría del auto: los tiempos bailan, así que
  está suavizada y la punta sale unos km/h de más (la de verdad es la de las trampas). Las frenadas no se pueden
  medir bien, así que la frenada y la sensibilidad a la carga quedan fijas en valores razonables.
- Las chicanas del juego (variantes de Monza, la última de Montreal) quedaron más abiertas que las reales: ahí el
  juego va más rápido y por eso el error cuenta lineal pasados los 15 km/h.
- La adherencia (`mu`) tiene tope en 1,9, lo que da una goma slick: sin tope el ajuste cambia carga aerodinámica
  por agarre mecánico. Con ese tope el auto tiene más carga (iguala a su peso a ~165 km/h) y menos agarre en lento.
- Resultado: punta de 310 a 355 km/h según el circuito (como las trampas), ~2,0 g en curva lenta, ~5 g a
  250 km/h y ~6,2 g a 300 km/h, frenadas de hasta ~6 g, y vueltas simuladas de -4,3 a +0,7 s de la pole (lo más
  rápido, en los circuitos de chicanas).

`node tools/lapcompare.js` grafica la pole real contra la red del juego dando una vuelta
(`tools/.out/vueltas.html`).

Las marchas y RPM siguen saliendo de `tools/car_profile.py` (las 15 vueltas más rápidas de una carrera en
OpenF1: `python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json`), que además mide aceleración, frenada y
agarre lateral, lo que usaba la física de antes.

## Trazados reales desde la telemetría de F1

`tools/layout.py` usa la API abierta de [OpenF1](https://openf1.org) (posiciones X, Y, Z de los autos) y junta
todas las vueltas de todos los pilotos en las prácticas y la clasificación (sin entradas ni salidas de boxes):

```bash
python3 tools/layout.py Montreal 2025 tracks/montreal.layout.json
```

Guarda la línea central cada 2 m desde la línea de largada, el largo de vuelta y la altura en cada punto; lo que
baja queda en `tools/.cache/`. Las posiciones de OpenF1 no son de GPS: el sistema de tiempos ubica a cada auto
sobre el dibujo oficial del circuito, así que todos pasan por la misma línea. De ahí sale la forma, suave y en
metros reales (sin los zigzags de sacar la línea central de una imagen), pero no los bordes: el ancho es el de
cada circuito (`widthMeters`). La telemetría viene en otra orientación que los dibujos: `rotate` en
`tracks/index.js` gira el mapa. Si la API dice que hay una sesión en vivo, sólo deja pedir datos con clave hasta
que termine.

### Sólo las alturas, para un circuito de imagen

`tools/elevation.py` usa la API abierta de [OpenF1](https://openf1.org) (posiciones X, Y, Z de los autos),
promedia las 5 vueltas más rápidas de una carrera y guarda la altura según la fracción de vuelta:

```bash
python3 tools/elevation.py Interlagos 2023 tracks/interlagos.elevation.json
```

El nombre del circuito es el `circuit_short_name` de OpenF1 (Interlagos, Monza, Melbourne, Catalunya, Montreal,
Spa-Francorchamps, Silverstone, Spielberg). Si la API corta por exceso de pedidos (429), el script espera y reintenta.

La línea de largada del dibujo no siempre cae exactamente donde OpenF1 empieza la vuelta. Los perfiles de los
circuitos nuevos (carrera 2025) se alinearon comparando las curvas del trazado real con las del dibujo y rotando
las alturas lo que hacía falta (entre 0,4 % y 4,7 % de vuelta; queda anotado en `source`). En el juego, la vuelta se escala para que las
pendientes sean las reales; `elevationScale` en `tracks/index.js` permite exagerarlas o suavizarlas.

## Agregar un circuito

Uno de F1: generar el trazado con `tools/layout.py` y agregar en `tracks/index.js` una entrada con `layout`,
`widthMeters` y, si hace falta, `rotate`.

Desde una imagen del trazado (línea oscura sobre fondo claro), en `tracks/index.js`: copiar la imagen a `tracks/` y agregar una entrada con el punto de largada
(`start`) y un punto hacia donde se corre (`towards`), ambos en píxeles de la imagen, y opcionalmente el
perfil de alturas (`elevation`).

Según cómo esté dibujado el circuito puede hacer falta:
- `scale`: más chico para imágenes chicas (menos de 1 la agranda) o con chicanas cerradas, que si no se suavizan.
- `threshold`: más bajo si hay flechas rojas u otros dibujos oscuros pegados a la pista.
- `open`: borra las líneas finas pegadas al trazado (calle de boxes, variantes viejas, el mástil de la bandera).
- `paint`: repasa en negro un tramo que la bandera a cuadros corta, o tapa un punto blanco dibujado sobre la pista.
- `smooth`: suaviza más la línea central en imágenes chicas, donde las líneas quedan escalonadas.

Para revisar que quedó bien conviene largar una carrera: si la vuelta del rival da un tiempo razonable y la
grilla está sobre la recta, el trazado se reconoció entero.
