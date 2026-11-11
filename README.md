# Fórmula ½

Juego de carreras para el navegador con un motor de render "a la antigua" (un rayo por columna de pantalla).
Los circuitos de F1 se arman con el **trazado real**, sacado de la telemetría (forma, largo de vuelta y alturas), el
auto tiene una física calibrada con vueltas reales y los rivales manejan con una red neuronal entrenada por refuerzo.

## Jugar

```bash
python3 serve.py
```

Abrir http://localhost:8123. Hace falta un servidor local porque el juego lee los píxeles de la imagen.
`serve.py` le pide al navegador que no cachee, así cada recarga usa la última versión.

Publicado en AWS (S3 + CloudFront) en cada push a `main`: ver [docs/deployment.md](docs/deployment.md).

### El menú

Antes de largar hay un **menú** (que se acuerda de lo último que elegiste). La pantalla principal muestra el modo,
el **auto** elegido (el modelo 3D con su decoración) y el **circuito** (su trazado); tocando cada uno se abre su
pantalla para cambiarlo (con ← → o las flechas, y el auto se puede girar arrastrándolo). La **puesta a punto** y las
**opciones** (dificultad, rivales, vueltas, cámara, daños, ayudas y sonido) van en pantallas aparte; Enter o Esc
vuelven a la principal.

- **Modo:** **Carrera** (por defecto, vos y un auto de cada equipo rival; con la grilla completa, 22 autos; con
  tabla de posiciones y repetición al final) o **Contrarreloj** (solo en pista, vueltas sin límite y un
  **fantasma** semitransparente que repite tu mejor vuelta, para ver dónde ganás o perdés tiempo). En carrera no
  hay fantasma.
- **Equipo:** Hierrari, Merchoedes, Red Toro, McLarrón, Austin Martini, Allpain, Willyams, Audiós, Haash,
  AlfaTorito o Cadillaque, cada uno con sus colores (carrocería, detalles de la decoración y casco) y sus dos
  pilotos, inventados a partir de la grilla de 2026, con sus números (Jorge Rústico y Kimi Antojo en Merchoedes,
  Carlos Le Clic y Luis Jamónton en Hierrari, Max Verstapón, Lando Nórdico, Franco Colapuntos…;
  `src/race/teams.js`). Como en la F1, la cámara de arriba (la "T") es negra en el primer auto de cada equipo y
  amarilla en el segundo. Al elegir el auto elegís también cuál de los dos pilotos sos. Los equipos que mejor
  vienen en el campeonato (`STANDINGS` en `src/race/teams.js`, hoy Merchoedes primero) suelen largar adelante (con
  algo de azar, como en una clasificación) y tienen los mejores autos dentro de la dificultad elegida. La tabla
  muestra la sigla de cada piloto y el resultado, su nombre.
- **Dificultad:** Fácil, Normal, Difícil o Experto. Con la red entrenada (la de por defecto) cambia el agarre y la
  potencia de los rivales: en Fácil, de 0,9 veces los tuyos (el mejor equipo) a 0,85 (el peor); en Experto, de
  1,1 a 1,06. Con la IA de siempre, su ritmo (en Interlagos, de vueltas de ~75–80 s en Fácil a ~69–70 s en
  Experto).
- **Circuito:** Interlagos, Monza, Albert Park, Barcelona, Montreal, Spa, Silverstone o Red Bull Ring, todos con
  alturas reales; y **vueltas** (1, 3, 5 o 10).
- **Rivales:** 1, 3, 7, 10 (por defecto: el primer piloto de cada uno de los otros equipos) o 21 (la grilla
  completa: los dos autos de cada uno de los otros equipos y tu compañero). Con menos se toman repartidos a lo
  largo del campeonato, así sigue habiendo autos rápidos y lentos; con uno solo, es un mano a mano con el del mejor
  equipo. Dificultad, vueltas y rivales son sólo para carrera.
- **Puesta a punto:** alerones, balance mecánico y reparto de frenada, por circuito (qué hace cada uno:
  [docs/fisica.md](docs/fisica.md#puesta-a-punto)).
- **Caja de cambios:** automática o manual. Se elige acá y queda fija durante la carrera.
- **Daños:** no, reducidos o reales ([docs/fisica.md](docs/fisica.md#daños)).
- **Sonido:** prendido o apagado y volumen general, de los motores y de la música del menú. Arranca siempre apagado
  (se prende con N o desde el menú); los volúmenes sí se recuerdan.

### La carrera

**Largada:** el semáforo es como el de la F1: se prenden 5 luces rojas, una por segundo, y después de una espera al
azar (de 0,4 a 2,6 s) se apagan todas. Con las luces prendidas, el acelerador sube las vueltas del motor sin mover
el auto. Cuando se apagan, la largada depende de las rpm en ese momento: entre **9.500 y 10.500** sale perfecta;
con pocas vueltas el motor se ahoga, y cerca del corte las gomas patinan (en los dos casos llega menos aceleración
al piso durante el primer segundo y medio). Si no estabas acelerando, largás cuando acelerás (con el motor bajo de
vueltas). Las luces de cambio del volante y del panel muestran las rpm. Los rivales también suben de vueltas, cada
uno a su manera, y reaccionan con su propio tiempo.

Largás último en la grilla. A la izquierda, debajo de los tiempos, está la **tabla de posiciones** con la distancia
(en segundos) de cada auto con el de adelante: cada auto anota a qué hora pasó por cada punto de la pista, y la
diferencia es cuánto hace que el de adelante pasó por donde está ahora el de atrás (si lo doblaron, dice "+1 V").
El panel muestra tu posición, las gomas (temperatura y desgaste) y, si algo se rompió, un esquema del auto con los
daños. Al terminar aparece el resultado y, unos segundos después, la **repetición** de la carrera, con varias
cámaras.

### Controles

| | Teclado | Joystick |
|---|---|---|
| Acelerar | I / ↑ / W | gatillo derecho |
| Frenar y marcha atrás | K / ↓ / S | gatillo izquierdo |
| Doblar | J L / ← → / A D | palanca izquierda |
| Subir / bajar de marcha (caja manual) | O o X / U o Z | RB/R1 / LB/L1 |
| Cabina o exterior | C | Y/△ |
| Mostrar la trazada ideal | G | X/□ |
| Sonido | N | |
| Reiniciar la carrera | R | Back/Share |
| Largar / volver al menú | Enter / Esc | Start |
| En la repetición: cámara, auto que se sigue | C, ← → (o J L) | Y/△, cruceta |

Las teclas se reconocen por la letra y por su posición, así funcionan con cualquier distribución de teclado. Con
teclado los pedales son todo o nada, pero el acelerador tarda 1/3 s en abrirse (como el pie), así pisar en plena
curva no suelta la cola de golpe. Con joystick (Xbox, PlayStation o cualquiera con el mapeo estándar) los tres son
**progresivos**; la palanca tiene zona muerta y dobla menos cerca del centro, para corregir fino a alta velocidad.

Cada carrera larga con la cámara que elegiste en Opciones (cabina si no elegiste ninguna). La trazada ideal cambia
de color según tu velocidad: **verde** se puede acelerar, **amarillo** mantener o levantar, **rojo** hay que
frenar.

En la dirección: `?ia=clasica` hace manejar a los rivales con la IA de siempre, `?ia=models/….json` con otra red,
`?cpu` dibuja sin WebGL y `?prueba` habilita teclas para romper piezas del auto (ver
[docs/fisica.md](docs/fisica.md#daños)).

## Cómo funciona

- [docs/circuitos.md](docs/circuitos.md): del trazado al mapa, trazados reales desde la telemetría de F1 y cómo
  agregar un circuito.
- [docs/fisica.md](docs/fisica.md): el modelo del auto (aerodinámica, gomas, balance, bloqueos, temperatura),
  estela, choques, daños, puesta a punto y la calibración con vueltas reales.
- [docs/ia.md](docs/ia.md): la trazada ideal, la IA de siempre y la red entrenada por refuerzo (cómo se entrena y
  su historia).
- [docs/render.md](docs/render.md): Voxel Space, los modelos 3D de los autos, WebGL y procesador, y la repetición.
- [docs/sonido.md](docs/sonido.md): los motores y la música, sintetizados.

## Para tocar el código

```bash
npm install
npm test          # tests de test/, menos de un segundo
npm run lint      # ESLint (errores y capas), Prettier y tipos
npm run regress   # carreras con semilla fija comparadas bit a bit (~1 min)
```

Cómo está organizado (capas, puertos, qué va dónde) y cómo se revisa: [docs/arquitectura.md](docs/arquitectura.md).
