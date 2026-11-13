# Sound

Everything is synthesized with Web Audio, with no sound files.

## The engines

`src/audio/audio.js`. A 4-stroke V6 fires 3 times per revolution, so the pitch is rpm / 20 Hz (200 Hz at idle,
600 Hz at 12,000 rpm). Each engine mixes: that tone with many harmonics, the crankshaft rotation (a third) and half
the pitch (no two firings are the same), noise that pulses with the firings (the roughness of the exhaust), a tiny
pitch wobble and the turbo whoosh; all slightly saturated, with two exhaust resonances and a filter that opens with
rpm and throttle. When you lift off the throttle the sound moves gradually (~150 ms) to overrun, more muffled and
slightly lower.

On top of that, one-off sounds: on an **upshift**, a cut of a fraction of a second with a sharp thump; on a
**downshift**, a short blip and sometimes a soft bang (in a braking zone with many downshifts in a row, not on every
one); when **lifting off** at high revs, a brief exhaust crackle; and at the **rev limiter**, the ignition stutter.

Each car has its own engine (the 8 closest to the camera play at once) and is heard from the camera: quieter the
farther away, to the left or right depending on where it is, more muffled if it is behind, and with the Doppler
effect. In the replay they sound the same, from whichever camera is being shown.

## The menu music

The menu plays **"Gran Premio"**, an original piece in a cinematic style, also synthesized (`src/audio/music.js`):
D minor, 140 bpm, 16 bars. It opens with a string introduction in a "galloping" ostinato, timpani and a growing
choir; then the theme, with the melody in the brass, taikos and cymbal; and it closes with brass hits and a snare
drum that builds until it starts again. Everything goes through a hall reverb. The notes are scheduled on the audio
clock slightly before they play, so they don't fall behind even when the game is busy. It fades out at the start and
comes back when you return to the menu.
