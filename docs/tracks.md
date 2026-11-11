# Tracks

How a track is built, where the real layouts come from and how to add a new one.

## From layout to map

`src/sim/track.js`: the F1 tracks come with the centerline in meters (`tracks/<id>.layout.json`, see "Real layouts
from F1 telemetry") and are drawn on a grid of 2 m cells. A track without telemetry comes from an image
(`src/load/trackimage.js`, because it needs the browser), which is reduced to a grid (1 cell = `scale` pixels): dark
pixels are track, it keeps the largest shape (discarding numbers and text), fills small holes and extracts the
centerline.

In both cases the track is a ribbon as wide as the track around the centerline (it can vary per section); around it
goes the runoff (`runoff` cells) and then a barrier. The runoff is asphalt on the outside of slow corners, gravel on
the outside of fast ones that come after a straight, and grass everywhere else (`surfaces` in `tracks/index.js`
changes it per section). It also computes, per cell:

- the **signed distance to the edge** of the track (to draw smooth edges),
- the **progress** along the lap (to validate laps, detect driving the wrong way and draw the kerb stripes),
- where the **kerbs** go: the curvature of the centerline is computed and they are placed on the inside of tight
  corners and on the outside at the exit of the sharpest ones; on the straights, a white line,
- the **braking boards** (200, 150, 100 and 50 m): before each tight corner (radius < 110 m) that comes after a
  straight of at least 250 m, on the outside. Tuned with the `BOARD_*` constants,
- the **elevation**, from the elevation profile.

## Real layouts from F1 telemetry

`tools/layout.py` uses the open [OpenF1](https://openf1.org) API (X, Y, Z positions of the cars) and combines every
lap of every driver in practice and qualifying (without pit entries or exits):

```bash
python3 tools/layout.py Montreal 2025 tracks/montreal.layout.json
```

It saves the centerline every 2 m from the start line, the lap length and the elevation at each point; what it
downloads goes to `tools/.cache/`. The OpenF1 positions are not GPS: the timing system places each car on the
official track drawing, so they all follow the same line. That gives the shape, smooth and in real meters (without the
zigzags of extracting the centerline from an image), but not the edges: the width is each track's (`widthMeters`).
The telemetry comes in a different orientation than the drawings: `rotate` in `tracks/index.js` rotates the map. If
the API says there is a live session, it only allows requests with a key until it ends.

### Elevation only, for an image track

`tools/elevation.py` uses the same API, averages the 5 fastest laps of a race and saves the elevation by lap
fraction:

```bash
python3 tools/elevation.py Interlagos 2023 tracks/interlagos.elevation.json
```

The track name is OpenF1's `circuit_short_name` (Interlagos, Monza, Melbourne, Catalunya, Montreal,
Spa-Francorchamps, Silverstone, Spielberg). If the API cuts off for too many requests (429), the script waits and
retries.

The start line of the drawing doesn't always fall exactly where OpenF1 starts the lap. The profiles of the new tracks
(2025 race) were aligned by comparing the corners of the real layout with those of the drawing and rotating the
elevation as much as needed (between 0.4 % and 4.7 % of a lap; it is noted in `source`). In the game, the lap is
scaled so the slopes are the real ones; `elevationScale` in `tracks/index.js` lets you exaggerate or soften them.

## Adding a track

An F1 one: generate the layout with `tools/layout.py` and add an entry in `tracks/index.js` with `layout`,
`widthMeters` and, if needed, `rotate`.

From an image of the layout (dark line on a light background), in `tracks/index.js`: copy the image to `tracks/` and
add an entry with the start point (`start`) and a point in the direction of travel (`towards`), both in image pixels,
and optionally the elevation profile (`elevation`).

Depending on how the track is drawn you may need:

- `scale`: smaller for small images (less than 1 enlarges it) or with tight chicanes, which otherwise get smoothed
  out.
- `threshold`: lower if there are red arrows or other dark drawings touching the track.
- `open`: erases thin lines touching the layout (pit lane, old variants, the flag pole).
- `paint`: paints over in black a section that the checkered flag cuts, or covers a white dot drawn on the track.
- `smooth`: smooths the centerline more in small images, where the lines come out stepped.

To check that it came out right, start a race: if the rival's lap gives a reasonable time and the grid is on the
straight, the whole layout was recognized.
