# Los circuitos

Cómo se arma un circuito, de dónde salen los trazados reales y cómo agregar uno nuevo.

## Del trazado al mapa

`src/sim/track.js`: los circuitos de F1 traen la línea central en metros (`tracks/<id>.layout.json`, ver "Trazados
reales desde la telemetría de F1") y se dibujan en una grilla de celdas de 2 m. Un circuito sin telemetría sale de
una imagen (`src/load/trackimage.js`, porque necesita el navegador), que se reduce a una grilla (1 celda = `scale`
píxeles): los píxeles oscuros son pista, se queda con el trazado más grande (descarta números y textos), tapa
huecos chicos y le saca la línea central.

En los dos casos la pista es una cinta del ancho del circuito alrededor de la línea central (puede variar por
tramo); alrededor pone la escapatoria (`runoff` celdas) y después un guardrail. La escapatoria es de asfalto por
fuera de las curvas lentas, de leca por fuera de las rápidas que vienen después de una recta y de pasto en el resto
(`surfaces` en `tracks/index.js` lo cambia por tramo). Además calcula, por celda:

- la **distancia con signo al borde** de la pista (para dibujar bordes suaves),
- el **progreso** a lo largo de la vuelta (para validar vueltas, contramano y las franjas de los pianos),
- dónde van los **pianos**: se calcula la curvatura de la línea central y se ponen del lado de adentro en las curvas
  cerradas y del lado de afuera a la salida de las más fuertes; en las rectas, línea blanca,
- los **carteles de frenada** (200, 150, 100 y 50 m): antes de cada curva cerrada (radio < 110 m) que venga después
  de una recta de al menos 250 m, del lado de afuera. Se ajusta con las constantes `BOARD_*`,
- la **altura**, a partir del perfil de elevación.

## Trazados reales desde la telemetría de F1

`tools/layout.py` usa la API abierta de [OpenF1](https://openf1.org) (posiciones X, Y, Z de los autos) y junta
todas las vueltas de todos los pilotos en las prácticas y la clasificación (sin entradas ni salidas de boxes):

```bash
python3 tools/layout.py Montreal 2025 tracks/montreal.layout.json
```

Guarda la línea central cada 2 m desde la línea de largada, el largo de vuelta y la altura en cada punto; lo que
baja queda en `tools/.cache/`. Las posiciones de OpenF1 no son de GPS: el sistema de tiempos ubica a cada auto sobre
el dibujo oficial del circuito, así que todos pasan por la misma línea. De ahí sale la forma, suave y en metros
reales (sin los zigzags de sacar la línea central de una imagen), pero no los bordes: el ancho es el de cada
circuito (`widthMeters`). La telemetría viene en otra orientación que los dibujos: `rotate` en `tracks/index.js`
gira el mapa. Si la API dice que hay una sesión en vivo, sólo deja pedir datos con clave hasta que termine.

### Sólo las alturas, para un circuito de imagen

`tools/elevation.py` usa la misma API, promedia las 5 vueltas más rápidas de una carrera y guarda la altura según la
fracción de vuelta:

```bash
python3 tools/elevation.py Interlagos 2023 tracks/interlagos.elevation.json
```

El nombre del circuito es el `circuit_short_name` de OpenF1 (Interlagos, Monza, Melbourne, Catalunya, Montreal,
Spa-Francorchamps, Silverstone, Spielberg). Si la API corta por exceso de pedidos (429), el script espera y
reintenta.

La línea de largada del dibujo no siempre cae exactamente donde OpenF1 empieza la vuelta. Los perfiles de los
circuitos nuevos (carrera 2025) se alinearon comparando las curvas del trazado real con las del dibujo y rotando las
alturas lo que hacía falta (entre 0,4 % y 4,7 % de vuelta; queda anotado en `source`). En el juego, la vuelta se
escala para que las pendientes sean las reales; `elevationScale` en `tracks/index.js` permite exagerarlas o
suavizarlas.

## Agregar un circuito

Uno de F1: generar el trazado con `tools/layout.py` y agregar en `tracks/index.js` una entrada con `layout`,
`widthMeters` y, si hace falta, `rotate`.

Desde una imagen del trazado (línea oscura sobre fondo claro), en `tracks/index.js`: copiar la imagen a `tracks/` y
agregar una entrada con el punto de largada (`start`) y un punto hacia donde se corre (`towards`), ambos en píxeles
de la imagen, y opcionalmente el perfil de alturas (`elevation`).

Según cómo esté dibujado el circuito puede hacer falta:

- `scale`: más chico para imágenes chicas (menos de 1 la agranda) o con chicanas cerradas, que si no se suavizan.
- `threshold`: más bajo si hay flechas rojas u otros dibujos oscuros pegados a la pista.
- `open`: borra las líneas finas pegadas al trazado (calle de boxes, variantes viejas, el mástil de la bandera).
- `paint`: repasa en negro un tramo que la bandera a cuadros corta, o tapa un punto blanco dibujado sobre la pista.
- `smooth`: suaviza más la línea central en imágenes chicas, donde las líneas quedan escalonadas.

Para revisar que quedó bien conviene largar una carrera: si la vuelta del rival da un tiempo razonable y la grilla
está sobre la recta, el trazado se reconoció entero.
