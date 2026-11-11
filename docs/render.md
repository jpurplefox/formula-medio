# Rendering

How the track, the cars and the replay are drawn. Everything is in `src/render/` (and the replay, in
`src/ui/replay.js`).

## Voxel Space

`src/render/renderer.js` uses the *Comanche* (1992) technique, a cousin of *Wolfenstein 3D*'s raycasting: for each
column a ray walks the map from near to far, reads the terrain height and paints whatever was not hidden yet. The
color of each point is decided by a *fragment shader*-like function (asphalt, kerbs, grass, checkered line) with
shading by slope.

The textures (asphalt, grass, walls) are generated in code in `src/render/textures.js`, with *mipmaps* so they don't
flicker in the distance; the grass has mowing stripes. The rubber on the asphalt (`src/sim/rubber.js`) starts as a
faint strip along the racing line (as if another category had raced before) and builds up where each car's wheels
pass, more under braking, in corners and on exits: after 3 laps the racing line is visible and after 10 it is quite
black. The trees and the boards are sprites.

## The cars

The cars (yours, the rivals and the ghost) are **3D models** of about a thousand faces, built in code from rounded
sections, tubes and cylinders (`src/render/carmodel.js`: nose, sidepods, multi-element wings, halo, mirrors,
suspension, driver with helmet, visor, spoiler and HANS collar, and wheels with spoked rims) and drawn by a custom
rasterizer inside the same renderer: same camera, flat shading from the sun, z-buffer between its parts and clipping
against the terrain, so hills and walls hide them.

They have perspective-correct textures: the livery (`src/render/livery.js`: stripe, number, sponsors, generated in
code on a canvas) on the bodywork, carbon fiber on the wings, the floor, the halo and the suspension, and the tyre
sidewall with the compound stripe and the FIRELLO brand rotating with the wheel. Each face takes its texture
coordinates by projecting from above or from the side.

- **The driver** turns his head (`src/ui/pilot.js`): he follows the car ahead if it is close and within ±10° of his
  heading; otherwise he looks at the apex of the next corner (the slowest point of the racing line in the next
  140 m); if there is no corner, straight ahead.
- **The tyres** have rounded shoulders (the profile goes from the flat tread to the sidewall in a quarter circle) and
  the tread has worn rubber with marks of picked-up rubber, which show that it is turning. With WebGL they wear during
  the race: they start smooth and shiny, the shine is gone before the end of the first lap and the marks appear
  gradually until they are complete at the start of the last lap.
- **The rim** has a protruding metal ring, a recessed face with ten spokes in pairs and the slotted brake disc behind
  it (drawn on a texture that rotates with the wheel), and the center nut in the team's detail color.
- **The sidepods** have inlets with a rounded lip around the dark opening, tilted backwards. The suspension arms are
  flat oval profiles; the mirrors are a rounded shell with the glass recessed in a frame, which with WebGL reflects
  the surroundings like a convex mirror.
- **With WebGL** the whole car is lit with smoothed normals, so the rounded parts (halo, tyres, bodywork) don't look
  faceted.

The wheels spin, the front ones steer as much as the car's turn needs (a lot at low speed, barely at full speed), the
whole car follows the slope, and the bodywork (not the wheels, which stay on the ground) moves on the suspension: it
rolls outward in corners according to the lateral acceleration (up to 1.5°) and the nose dips under braking (up to
1.1°), with a damped spring; from the cockpit, the pitch moves the view, and the car casts its shadow on the ground.

The cockpit view uses the same model, seen from the driver's eyes (without the helmet), with the steering wheel drawn
on top (`src/render/cockpit.js`). The camera math uses a virtual 960×540 image. In the menu, the car being chosen and
the track layouts are drawn by `src/ui/menuview.js`.

## With WebGL and without WebGL

**With WebGL** (`src/render/glrenderer.js`, the normal case): everything is drawn on the graphics card, at the
screen resolution (up to 1440×810). The terrain is a *shader* that runs once per pixel: it builds the camera ray,
steps over the height map (a step of a few pixels, which shrinks near the walls based on the distance to the edge, so
it doesn't skip them) and refines where it hits; the ground color is the same "shader" from `renderer.js` in GLSL.
Cars, trees, boards and shadows are triangles with the same projection and the same depth, so the card's z-buffer
resolves what hides what. The cars have **reflections**: the paint and the helmet (and a little the carbon) reflect
an invented environment (asphalt below, a strip of trees on the horizon and the sky above), more from the side than
from the front, with smoothed normals so the reflection flows evenly, and a highlight where the sun bounces. The
steering wheel and the start lights go on a 2D canvas on top.

**Without WebGL** (or adding `?cpu` to the URL) the CPU renderer is used: the sky and the terrain are split across
several **Web Workers** (one per core, up to 6; `src/render/terrainworker.js`), each draws a strip of columns, and the
main thread assembles the image and draws the sprites and the cars on top.

## The racing line

In the game it is a semi-transparent ribbon floating slightly above the asphalt, with soft edges (without WebGL, it is
painted on the ground), and it changes color with your speed: **green** you can accelerate, **yellow** hold or lift,
**red** you have to brake. How it is computed: [ai.md](ai.md#the-racing-line).

## The replay

During the race the position, heading, steering and speed of every car are recorded 30 times per second
(`src/ui/replay.js`). At the end, after the result, it plays in a loop interpolating between samples, with several
cameras:

- **TV** ("TV"): fixed at the side of the track, up high, every ~230 m; it follows the one closest to the car, with
  zoom based on distance (the renderer accepts a zoom: it narrows the field of view, like a telephoto lens).
- **Chase** ("Persecución"), **Onboard** ("A bordo", above the air intake), **Helicopter** ("Helicóptero") and
  **Front** ("Frontal", looking at the car from the front).
- **Automatic** ("Automática"): a director that switches shots every 5 s.
