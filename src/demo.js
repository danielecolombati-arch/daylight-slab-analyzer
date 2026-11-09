// Procedural demo model: two-storey building with openings and a neighbouring block.
// Returns the same internal format used for imported .3dm files (metres, Z up).

function box(P, x0, y0, z0, x1, y1, z1) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  for (const [a, b, c, d] of f) P.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
}
function quadY(P, y, x0, z0, x1, z1) { // vertical pane in plane y
  P.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1);
}

/** Wall along X at y (thickness t) from x0..x1, z0..z1 with openings [{x0,x1,z0,z1}] */
function wallX(P, G, y, t, x0, x1, z0, z1, openings) {
  const ops = [...openings].sort((a, b) => a.x0 - b.x0);
  let cx = x0;
  for (const o of ops) {
    if (o.x0 > cx) box(P, cx, y, z0, o.x0, y + t, z1);
    box(P, o.x0, y, z0, o.x1, y + t, o.z0);           // sill
    box(P, o.x0, y, o.z1, o.x1, y + t, z1);           // lintel
    quadY(G, y + t / 2, o.x0, o.z0, o.x1, o.z1);       // glass
    cx = o.x1;
  }
  if (cx < x1) box(P, cx, y, z0, x1, y + t, z1);
}

export function makeDemo() {
  const slabs = [], walls = [], glass = [], context = [];
  const L = 18, D = 11, H = 3.2, T = 0.3, W = 0.3;
  for (let lv = 0; lv < 3; lv++) box(slabs, 0, 0, lv * H - T, L, D, lv * H); // floors + roof
  for (let lv = 0; lv < 2; lv++) {
    const z0 = lv * H, z1 = lv * H + H - T;
    // south facade (y = 0): large windows
    const south = [];
    for (let i = 0; i < 5; i++) south.push({ x0: 1 + i * 3.4, x1: 3.2 + i * 3.4, z0: z0 + 0.3, z1: z0 + 2.5 });
    wallX(walls, glass, 0, W, 0, L, z0, z1, south);
    // north facade (y = D-W): smaller windows
    const north = [];
    for (let i = 0; i < 4; i++) north.push({ x0: 2 + i * 4.2, x1: 3.2 + i * 4.2, z0: z0 + 1.0, z1: z0 + 2.3 });
    wallX(walls, glass, D - W, W, 0, L, z0, z1, north);
    // east / west blind walls
    box(walls, 0, W, z0, W, D - W, z1);
    box(walls, L - W, W, z0, L, D - W, z1);
    // internal corridor wall with door gaps, and a partition
    box(walls, W, 6.4, z0, 7, 6.55, z1);
    box(walls, 8, 6.4, z0, L - W, 6.55, z1);
    box(walls, 9.45, W, z0, 9.6, 6.4, z1);
  }
  // balcony / overhang on the upper floor (south)
  box(slabs, 10, -1.6, H - T, L, 0, H);
  // neighbouring building to the south-west
  box(context, -4, -16, 0, 9, -11, 12);
  const toF = (a) => new Float32Array(a);
  return {
    name: 'Sample · two-storey building',
    layers: [
      { name: 'Slabs', color: '#c9b79c' },
      { name: 'Walls', color: '#d8d4cc' },
      { name: 'Glazing', color: '#8fb8d8' },
      { name: 'Context', color: '#a9aaa6' },
    ],
    objects: [
      { layer: 0, positions: toF(slabs) },
      { layer: 1, positions: toF(walls) },
      { layer: 2, positions: toF(glass) },
      { layer: 3, positions: toF(context) },
    ],
  };
}
