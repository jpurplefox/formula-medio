# Raycast Racer

Juego de carreras para el navegador con un motor de render "a la antigua" (un rayo por columna de pantalla).
El mundo se arma a partir de una **imagen del trazado** (línea oscura sobre fondo claro) y,
opcionalmente, un **perfil de alturas** sacado de la telemetría real de F1.

## Jugar

```bash
python3 serve.py
```

Abrir http://localhost:8123. Hace falta un servidor local porque el juego lee los píxeles de la imagen.
`serve.py` le pide al navegador que no cachee, así cada recarga usa la última versión.

Antes de largar hay un **menú** (que se acuerda de lo último que elegiste):
- **Modo:** **Carrera** (22 autos, 2 por equipo, con tabla de posiciones y repetición al final) o **Contrarreloj**
  (solo en pista, vueltas sin límite y un **fantasma** semitransparente que repite tu mejor vuelta, para ver
  dónde ganás o perdés tiempo). En carrera no hay fantasma.
- **Equipo:** Hierrari, Merchoedes, Red Toro, McLarrón, Austin Martini, Allpain, Willyams, Audiós, Haash,
  AlfaTorito o Cadillaque, cada uno con sus colores (carrocería, detalles de la decoración y casco) y los números de sus dos autos
  (`src/teams.js`). Como en la F1, la cámara de arriba (la "T") es negra en el primer auto de cada equipo y
  amarilla en el segundo. Vos manejás el primero de tu equipo; los 21 rivales son los dos autos de cada uno de
  los otros equipos y tu compañero.
- **Dificultad:** Fácil, Normal, Difícil o Experto: el ritmo de los rivales (en Interlagos, de vueltas de ~75–80 s
  en Fácil a ~69–70 s en Experto).
- **Circuito:** Interlagos (con alturas reales), Monza, Albert Park, Barcelona, Montreal, Spa, Silverstone o
  Red Bull Ring (estos todavía planos), o cargar uno propio; y **vueltas** (1, 3, 5 o 10; dificultad y vueltas son sólo para carrera).
- **Sonido:** prendido o apagado y volumen general, de los motores y de la música del menú.

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
RB/R1 sube de marcha, LB/L1 baja, Y/△ cambia la cámara, X/□ la trazada, Start larga o abre el menú, Back/Share
reinicia y la cruceta elige el auto en la repetición. La palanca tiene zona muerta y dobla menos cerca del centro,
para corregir fino a alta velocidad. Con teclado los pedales son todo o nada, pero el acelerador tarda 1/3 s en
abrirse (como el pie), así pisar en plena curva no suelta la cola de golpe.

## Cómo funciona

1. **Imagen → mapa** (`src/track.js`): la imagen se reduce a una grilla (1 celda = `scale` píxeles).
   Los píxeles oscuros son pista; se queda con el trazado más grande (descarta números y textos)
   y tapa huecos chicos. Alrededor pone pasto (`runoff` celdas) y después un guardrail.
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
   titilen a lo lejos; el césped tiene franjas de corte, y sobre la trazada ideal el asfalto está oscurecido por la goma.
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
   largo real de la vuelta (de la telemetría, o `lengthMeters`). El auto se comporta según un **perfil medido con
   telemetría real** (ver abajo): aceleración y desaceleración por velocidad, frenada y agarre lateral que crecen
   con la velocidad (carga aerodinámica), y una caja de 8 marchas con RPM, corte y luces de cambio.
   Además: pasto que frena, choques y gravedad en las pendientes, y **rebufo**: detrás de otro auto (hasta 45 m
   y dentro de su estela, de 1,6 m de costado) hay menos resistencia del aire, hasta un 30 % pegado a él. Eso da
   unos 13 km/h más al final de una recta de 600 m, gana 0,3 s y sube la velocidad punta hasta el corte de 8.ª.
   Vale para vos y para los rivales.

   **Balance:** al frenar el peso se pasa adelante y al acelerar, atrás (hasta un 7 %, con un poco de demora por la
   suspensión). Cada eje agarra según su carga, pero no en proporción (el doble de carga da 1,74 veces el agarre),
   y además reparte su agarre entre frenar o empujar y doblar (**círculo de fricción**: √(frenada² + giro²) ≤ agarre;
   el motor empuja sólo con las de atrás). El eje delantero limita cuánto dobla el auto (si no alcanza, se va de
   trompa: subviraje); si al trasero no le alcanza para sostener la curva, la cola se abre y el auto queda cruzado
   (sobreviraje) hasta que levantás el pie o contravolanteás. En una curva sin pedales da lo mismo que el agarre
   medido; lo que cambia es frenar fuerte doblando (la cola se pone liviana), soltar el freno de a poco al entrar
   (la trompa muerde y el auto rota) y pisar a fondo en una curva lenta (la cola se abre). El traslado de peso de
   costado también resta agarre, pero eso ya está dentro del agarre lateral medido.
4. **Choques** (`src/collision.js`): con impulsos, como un motor de física 2D. Además de la velocidad de marcha,
   cada auto tiene una velocidad de costado y un giro que le dejan los golpes, y que las gomas van frenando (más
   rápido cuanto más agarre). Entre autos, cada uno es un rectángulo de 5,6 × 2 m: se detecta el choque con el test
   de ejes separadores, el punto de contacto es el promedio de las esquinas que quedaron dentro del otro, y el
   impulso depende de con qué velocidad se acercan ahí (con un poco de rebote y rozamiento). Si le pegás de atrás
   a alguien, sale empujado; si el golpe es desplazado del centro, los autos giran, y uno fuerte te hace trompear.
   Contra los muros, el auto son tres círculos a lo largo: un roce en ángulo casi no frena y lo endereza contra el
   muro; de frente, frena y rebota. Apoyados sin acercarse, se deslizan sin frenarse.

Cambios: **O** o **X** sube, **U** o **Z** baja (si estabas en automático, pasa a manual); **M** alterna automática / manual. **C** alterna la vista de cabina (por defecto) y la exterior. **G** muestra u oculta la trazada ideal.
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

Cada rival (`src/ai.js`) es un auto con la misma física que el tuyo, manejado por un piloto automático:
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

## Trazada ideal

`src/racingline.js` calcula, al cargar el circuito, la trazada curva por curva como la hacen los pilotos: se llega
por el lado de afuera, se toca el vértice (el punto más cerrado) del lado de adentro y se sale abriendo de nuevo
(en las eses, de vértice a vértice), con un suavizado final que saca los zigzags. Después calcula la velocidad
máxima en cada punto con el perfil del auto: lo que aguanta el agarre en la curva, cuánto hay que frenar antes y cuánto acelera el motor después.
En el juego es una cinta semitransparente que flota un poco sobre el asfalto, con los bordes difusos (sin WebGL,
se pinta sobre el piso), y cambia de color según tu velocidad: **verde** se puede acelerar,
**amarillo** mantener o levantar, **rojo** hay que frenar. **G** la muestra u oculta.

## Perfil del auto desde la telemetría de F1

`tools/car_profile.py` toma las 15 vueltas más rápidas de una carrera en OpenF1 (velocidad, RPM, marcha,
acelerador, freno y posición) y genera `cars/f1-2023.json`:

```bash
python3 tools/car_profile.py Interlagos 2023 cars/f1-2023.json
```

- **Marchas y RPM:** km/h por rpm de cada marcha (las que no se usan a fondo se estiman), RPM de corte y de cambio.
- **Aceleración y desaceleración sin pedales:** tablas por velocidad (aceleración a fondo con la marcha justa).
- **Frenada y agarre lateral:** `base + perV2·v²` ajustado a lo medido (el agarre sale de v² × curvatura de la
  trayectoria real). La telemetría tiene ~3,7 muestras por segundo, así que los picos de frenada se subestiman un poco.

Con este perfil, las velocidades del juego a lo largo de la vuelta coinciden con las reales (curvas lentas
~95-110 km/h, punta ~305-325 km/h). Un piloto automático por el centro de la pista hace ~1:17,7; la vuelta real
fue 1:12,5 (con trazada de carrera y al 100 %).

## Alturas reales desde la telemetría de F1

`tools/elevation.py` usa la API abierta de [OpenF1](https://openf1.org) (posiciones X, Y, Z de los autos),
promedia las 5 vueltas más rápidas de una carrera y guarda la altura según la fracción de vuelta:

```bash
python3 tools/elevation.py Interlagos 2023 tracks/interlagos.elevation.json
```

El nombre del circuito es el `circuit_short_name` de OpenF1. En el juego, la vuelta se escala para que las
pendientes sean las reales; `elevationScale` en `tracks/index.js` permite exagerarlas o suavizarlas.

## Agregar un circuito

Desde el juego: "Cargar tu circuito" o arrastrar una imagen, y marcar con dos clicks la línea de largada
y el sentido de giro (sin alturas).

O fijo, en `tracks/index.js`: copiar la imagen a `tracks/` y agregar una entrada con el punto de largada
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
