# Daylight Slab Analyzer

A browser app that computes the **Daylight Factor (DF)** and natural illuminance on the interior floor slabs of a **Rhino (.3dm)** model. Nothing to install, and your file never leaves your computer.

![sky](https://img.shields.io/badge/sky-CIE%20overcast-e0892b) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## How to use

1. **Load the model**: drop a `.3dm` file (or try the sample model).
2. **Assign layers**:
   - **Slab**: surfaces where daylight is measured (the grid is built on upward-facing horizontal faces)
   - **Opaque**: walls, ceilings, context and obstructions, with a **reflectance** (empty = auto by orientation: floors 0.2, walls 0.5, ceilings 0.7)
   - **Glass**: lets light through with a **transmittance** (default 0.70)
   - **Core (excluded)**: stairs, lifts and shafts. They block light like opaque layers, but the floor area inside them is left out of all results, so percentages refer to usable floor area only. A core can be modelled as a closed volume, as shaft walls (door openings are fine), or as a flat patch drawn on the slab
   - **Ignore**: excluded from the calculation

   Roles and typical reflectances are suggested from layer names (`SLABS`, `Glass`, `Core`, `Stairs`, `Lift`, `Grass`, `Context`…).
3. **Location & building use** (see below).
4. **Settings**: grid spacing, work plane height, ground reflectance, quality.
5. **Run**: three separate buttons, **Daylight Factor**, **Sun hours** and **Radiation**. Each runs on its own and reuses the same grid; changing the grid or layers starts a fresh set of results. The calculation uses every CPU core.
6. **Results**: daylight map per level (3D or plan), threshold lines, usable area per use, a **rating per floor** (residential: band of the floor's median DF — ✓ generally acceptable or good, ~ moderate, ✗ poor or very dark; office/industrial: ✓ when half the floor reaches the first line), CSV export.
7. **Exploded axonometric**: all floors stacked in a high-resolution PNG, with level names, area percentages, legend and north arrow.

### Preparing the Rhino file

The app reads the **render meshes** saved in the file. If some polysurfaces are missing:

- save the file after viewing it in *Shaded* or *Rendered* mode, and **don't** use *Save Small*;
- or convert the geometry with `_Mesh` before saving.

Model units (mm, cm, m…) are read from the file and can be overridden from the *Units* menu.

## Location

The Daylight Factor does not depend on location: it is a ratio under a standard overcast sky. What depends on location is **how many lux a given DF corresponds to**, through the median external diffuse horizontal illuminance during daylight hours (*E<sub>v,d,med</sub>*, EN 17037). The location therefore shifts the thresholds and the lines.

- **`.epw` weather file** for any place worldwide (free from [climate.onebuilding.org](https://climate.onebuilding.org/)). The app takes the median diffuse horizontal illuminance over the hours with the sun above the horizon. If the file has no illuminance data, it estimates it from diffuse radiation × 120 lm/W.
- **33 European capitals** with the official values of EN 17037 Table A.3 (e.g. Rome 19,200 lx, London 14,100 lx, Oslo 12,400 lx).
- **Manual value**.

## Building use and threshold lines

The building use sets the work plane height and the **threshold lines** drawn on each floor plan:

| Use | Lines | Source |
|---|---|---|
| Residential | DF 0.5% · 1% · 2% · 3% → very dark / poor / moderate / generally acceptable / good | design guideline; room targets (kitchen 200 lx, living room 150 lx, bedroom 100 lx) from the UK National Annex to EN 17037 are listed with their DF at the site |
| Office | 300 office · 500 continuous desk work | EN 17037 minimum and medium levels |
| Industrial | 300 · 500 · 750 | EN 17037 minimum, medium and high levels |

Thresholds can be edited and each line can be switched off. Inside a line there is enough daylight for that use. Areas outside the lines suit services, cores, bathrooms and storage. A room complies when at least half of its floor area is inside the right line.

For each floor the app reports the m² and percentage inside each line, mean and median DF, the EN 17037 level reached by the whole floor, and, for projects in Italy, a reminder of D.M. 5/7/1975 (mean DF ≥ 2% per room).

## Direct sun and solar radiation

With the **Sun hours** and **Radiation** buttons, each floor point also gets:

- **Direct sun hours** on **21 March, 21 June and 21 December** (10-minute steps) and over the **whole year** (hourly sun positions grouped into 1.5° bins). Sun through glazing counts; any opaque obstruction blocks it.
- **EN 17037 sunlight exposure (indicative):** share of the floor with ≥ 1.5 h (minimum), ≥ 3 h (medium) and ≥ 4 h (high) of sun on 21 March, above a minimum sun altitude you can set. The standard checks one point per dwelling at the window; the app shows the whole floor.
- **Solar radiation reaching the floor (kWh/m²)** for the **year**, **summer** (Jun–Aug) and **winter** (Dec–Feb): direct sun from the EPW direct-normal radiation, reduced by glass transmittance, plus diffuse sky radiation (DF × diffuse horizontal radiation; if the Daylight Factor has not been run, a quick sky calculation is done instead). Beam light reflected inside the room is not included. Needs an **EPW** file.

Set **True North** before running: type it (degrees counter-clockwise from the model +Y axis, as in Ladybug), use the ±15° buttons, or **drag the compass** in the bottom-left corner of the viewer to point at north (Shift snaps to 15°). A north arrow is also drawn on the ground next to the building. If you change north after running Sun hours or Radiation, the app warns you to run them again. The map toolbar gets *Sun h* and *kWh/m²* modes with a period selector; per-floor tables, CSV columns and the exploded axonometric follow the selected mode.

Checks (`npm test`): an open point gets 12.0 h on 21 March, 15.2 h on 21 June and 9.0 h on 21 December at 42° N; annual global horizontal radiation rebuilt from the EPW matches the file within 1%; glass with τ 0.6 cuts radiation by 40% without changing sun hours.

## Calculation method

- **Sky**: CIE standard overcast sky, `L(γ) = Lz·(1 + 2 sin γ)/3`.
- **Monte Carlo path tracing** from each grid point over the hemisphere, with stratified cosine sampling and diffuse inter-reflections (unbiased Russian roulette with probability ρ).
- **Ground**: Lambertian plane with reflectance ρg lit by the sky.
- **Glass**: specular transmission with constant τ (no angular dependence, so it slightly overestimates light at grazing angles).
- **BVH** written from scratch (`src/engine.js`), dependency-free, also usable in Node.
- **Filters**: points with nothing overhead are treated as outdoor; points inside walls or solids are detected with rays along the 6 axis directions; core points are found by ray parity (closed volumes), a downward ray (flat patches) or 8 horizontal rays (shaft walls).
- Results are lightly smoothed (3×3 average on the grid) to reduce Monte Carlo noise.

Checks (`npm test`): an unobstructed horizontal point gives DF = 100%; an unobstructed vertical surface gives ≈ 49.6% (39.6% sky + 10% ground); the BVH matches brute force.

> ⚠️ Results are indicative and meant for design. For formal submissions, verify them with validated software (Radiance/Honeybee, DIALux, etc.).

## Development

```bash
npm install          # only for tests (three, rhino3dm, playwright-core)
npm test             # engine tests in Node
npx serve .          # or any static server, then open http://localhost:3000
```

```
index.html            user interface
src/app.js            three.js viewer, .3dm import, UI, results
src/engine.js         BVH, DF path tracing, sensor grid
src/worker.js         Web Worker for parallel computation
src/climate.js        location: EN 17037 table, EPW reader, sun position
src/sun.js            sun samples for sun hours and radiation
src/contour.js        threshold lines (marching squares)
src/exploded.js       exploded axonometric export
src/demo.js           procedural sample model
vendor/rhino3dm/      rhino3dm.js + wasm (reads .3dm files)
test/                 engine tests, end-to-end test, sample .3dm generator
```

## Roadmap

- Automatic room detection and per-room compliance
- Angle-dependent glass transmittance and frame factor
- Climate-based daylight (sDA, ASE, UDI) from EPW files
- PDF report

## License

MIT
