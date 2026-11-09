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
5. **Run**: the calculation uses every CPU core.
6. **Results**: daylight map per level (3D or plan), threshold lines, usable area per use, CSV export.
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

| Use | Lines (lux exceeded for half of daylight hours) | Source |
|---|---|---|
| Residential | 100 bedroom · 200 kitchen / living room | UK National Annex to EN 17037 (BRE 209:2022) |
| Office | 300 office · 500 continuous desk work | EN 17037 minimum and medium levels |
| Industrial | 300 · 500 · 750 | EN 17037 minimum, medium and high levels |

Thresholds can be edited and each line can be switched off. Inside a line there is enough daylight for that use. Areas outside the lines suit services, cores, bathrooms and storage. A room complies when at least half of its floor area is inside the right line.

For each floor the app reports the m² and percentage inside each line, mean and median DF, the EN 17037 level reached by the whole floor, and, for projects in Italy, a reminder of D.M. 5/7/1975 (mean DF ≥ 2% per room).

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
src/climate.js        location: EN 17037 table and EPW reader
src/contour.js        threshold lines (marching squares)
src/exploded.js       exploded axonometric export
src/demo.js           procedural sample model
vendor/rhino3dm/      rhino3dm.js + wasm (reads .3dm files)
test/                 engine tests, end-to-end test, sample .3dm generator
```

## Roadmap

- Automatic room detection and per-room compliance
- Angle-dependent glass transmittance and frame factor
- Clear sky and direct sun by date and time (point-in-time illuminance, sunlight hours)
- Climate-based daylight (sDA, ASE, UDI) from EPW files
- PDF report

## License

MIT
