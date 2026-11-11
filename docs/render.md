# El dibujo

Cómo se dibujan la pista, los autos y la repetición. Todo está en `src/render/` (y la repetición, en
`src/ui/replay.js`).

## Voxel Space

`src/render/renderer.js` usa la técnica de *Comanche* (1992), primo del raycasting de *Wolfenstein 3D*: por cada
columna se recorre el mapa con un rayo de cerca hacia lejos, se lee la altura del terreno y se pinta lo que todavía
no estaba tapado. El color de cada punto lo decide una función tipo *fragment shader* (asfalto, pianos, pasto, línea
a cuadros) con sombreado según la pendiente.

Las texturas (asfalto, césped, muros) se generan por código en `src/render/textures.js`, con *mipmaps* para que no
titilen a lo lejos; el césped tiene franjas de corte. La goma sobre el asfalto (`src/sim/rubber.js`) arranca como
una franja tenue sobre la trazada ideal (como si antes hubiera corrido otra categoría) y se va marcando por donde
pasan las ruedas de cada auto, más en frenadas, curvas y salidas: a las 3 vueltas ya se ve la línea de carrera y a
las 10 está bien negra. Los árboles y los carteles son sprites.

## Los autos

Los autos (el tuyo, los rivales y el fantasma) son **modelos 3D** de unas mil caras, armados en código con secciones
redondeadas, tubos y cilindros (`src/render/carmodel.js`: trompa, pontones, alerones de varios elementos, halo,
espejos, suspensión, piloto con casco, visera, alerón y collar HANS, y ruedas con llanta de rayos) y dibujados por
un rasterizador propio dentro del mismo renderer: misma cámara, sombreado plano según el sol, z-buffer entre sus
piezas y recorte contra el terreno, así las lomas y los muros los tapan.

Tienen texturas con corrección de perspectiva: la decoración (`src/render/livery.js`: franja, número, sponsors,
generada por código en un canvas) en la carrocería, fibra de carbono en los alerones, el piso, el halo y la
suspensión, y el flanco de las gomas con la franja del compuesto y la marca FIRELLO que gira con la rueda. Cada cara
toma sus coordenadas de textura proyectándose desde arriba o de costado.

- **El piloto** gira la cabeza (`src/ui/pilot.js`): sigue al auto de adelante si está cerca y dentro de ±10° de su
  rumbo; si no, mira el vértice de la próxima curva (el punto más lento de la trazada en los próximos 140 m); si no
  hay curva, de frente.
- **Las gomas** tienen los hombros redondeados (el perfil va de la banda plana al flanco en un cuarto de círculo) y
  la banda lleva caucho gastado con marcas de goma arrastrada, que dejan ver que gira. Con WebGL se gastan durante
  la carrera: largan lisas y brillantes, el brillo se va antes de terminar la primera vuelta y las marcas aparecen de
  a poco hasta estar completas al empezar la última.
- **La llanta** tiene un aro de metal que sobresale, la cara hundida con diez rayos de a pares y el disco de freno
  ranurado detrás (dibujados en una textura que gira con la rueda) y la tuerca central del color de los detalles del
  equipo.
- **Los pontones** tienen las tomas con un labio redondeado alrededor de la abertura oscura, inclinadas hacia atrás.
  Los brazos de la suspensión son perfiles ovalados y chatos; los espejos, una cáscara redondeada con el vidrio
  hundido en un marco, que con WebGL refleja el entorno como un espejo convexo.
- **Con WebGL** todo el auto se ilumina con normales suavizadas, así lo redondeado (halo, gomas, carrocería) no se ve
  en facetas.

Las ruedas giran, las delanteras doblan lo que hace falta para el giro del auto (mucho despacio, apenas a fondo),
todo el auto sigue la pendiente y la carrocería (no las ruedas, que quedan apoyadas) se mueve sobre la suspensión:
se inclina hacia afuera en las curvas según la aceleración de costado (hasta 1,5°) y baja la trompa al frenar (hasta
1,1°), con un resorte amortiguado; desde la cabina, el cabeceo mueve la vista, y el auto proyecta su sombra sobre el
piso.

La vista de cabina usa el mismo modelo, visto desde los ojos del piloto (sin el casco), con el volante dibujado
encima (`src/render/cockpit.js`). Las cuentas de cámara usan una imagen virtual de 960×540. En el menú, el auto que
se elige y los trazados de los circuitos los dibuja `src/ui/menuview.js`.

## Con WebGL y sin WebGL

**Con WebGL** (`src/render/glrenderer.js`, lo normal): todo se dibuja en la placa de video, a la resolución de la
pantalla (hasta 1440×810). El terreno es un *shader* que corre una vez por píxel: arma el rayo de la cámara, avanza
sobre el mapa de alturas (un paso de unos píxeles, que cerca de los muros se achica según la distancia al borde, así
no los saltea) y afina dónde choca; el color del piso es el mismo "shader" de `renderer.js` en GLSL. Autos, árboles,
carteles y sombras son triángulos con la misma proyección y la misma profundidad, así el z-buffer de la placa
resuelve qué tapa a qué. Los autos tienen **reflejos**: la pintura y el casco (y un poco el carbono) reflejan un
entorno inventado (asfalto abajo, una franja de árboles en el horizonte y el cielo arriba), más de costado que de
frente, con normales suavizadas para que el reflejo corra parejo, y un brillo donde rebota el sol. El volante y el
semáforo van en un canvas 2D encima.

**Sin WebGL** (o agregando `?cpu` a la dirección) se usa el renderer de procesador: el cielo y el terreno se
reparten entre varios **Web Workers** (uno por núcleo, hasta 6; `src/render/terrainworker.js`), cada uno dibuja una
franja de columnas y el hilo principal arma la imagen y dibuja encima los sprites y los autos.

## La trazada ideal

En el juego es una cinta semitransparente que flota un poco sobre el asfalto, con los bordes difusos (sin WebGL, se
pinta sobre el piso), y cambia de color según tu velocidad: **verde** se puede acelerar, **amarillo** mantener o
levantar, **rojo** hay que frenar. Cómo se calcula: [ai.md](ai.md#la-trazada-ideal).

## La repetición

Durante la carrera se graba la posición, el rumbo, el volante y la velocidad de todos los autos 30 veces por segundo
(`src/ui/replay.js`). Al terminar, después del resultado, se reproduce en loop interpolando entre muestras, con
varias cámaras:

- **TV:** fijas al costado de la pista, en altura, cada ~230 m; sigue la más cercana al auto, con zoom según la
  distancia (el renderer acepta un zoom: achica el campo de visión, como un teleobjetivo).
- **Persecución**, **A bordo** (arriba de la toma de aire), **Helicóptero** y **Frontal** (mirando al auto de
  frente).
- **Automática:** un director que va alternando las tomas cada 5 s.
