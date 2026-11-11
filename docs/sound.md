# El sonido

Todo se sintetiza con Web Audio, sin archivos de sonido.

## Los motores

`src/audio/audio.js`. Un V6 de 4 tiempos hace 3 explosiones por vuelta, así que el tono es rpm / 20 Hz (200 Hz en
ralentí, 600 Hz a 12.000 rpm). Cada motor mezcla: ese tono con muchos armónicos, el giro del cigüeñal (un tercio) y
medio tono (ninguna explosión es igual a otra), ruido que late al ritmo de las explosiones (la aspereza del escape),
un temblor mínimo del tono y el soplido del turbo; todo apenas saturado, con dos resonancias del escape y un filtro
que se abre con las rpm y el acelerador. Al soltar el acelerador el sonido pasa de a poco (~150 ms) a la retención,
más apagado y un poco más bajo.

Encima, sonidos sueltos: al **subir de marcha**, un corte de una fracción de segundo con un golpe seco; al
**bajar**, un acelerón corto y a veces una explosión suave (en una frenada con muchos rebajes seguidos, no en cada
uno); al **soltar el acelerador** a muchas vueltas, un petardeo breve del escape; y en el **corte de rpm**, el
tartamudeo del encendido.

Cada auto tiene su propio motor (suenan a la vez los 8 más cercanos a la cámara) y se escucha desde la cámara: más
bajo cuanto más lejos, a la izquierda o a la derecha según dónde esté, más apagado si está detrás y con efecto
Doppler. En la repetición suenan igual, desde la cámara que se esté viendo.

## La música del menú

En el menú suena **"Gran Premio"**, un tema original de estilo cinematográfico, también sintetizado
(`src/audio/music.js`): Re menor, 140 bpm, 16 compases. Arranca con una introducción de cuerdas en ostinato "al
galope", timbales y un coro que crece; sigue el tema, con la melodía en los metales, taikos y platillo; y cierra con
golpes de metales y un redoblante que crece hasta volver a empezar. Todo pasa por una reverberación de sala. Las
notas se programan con el reloj del audio un poquito antes de que suenen, así no se atrasan aunque el juego esté
ocupado. Se apaga de a poco al largar y vuelve al volver al menú.
