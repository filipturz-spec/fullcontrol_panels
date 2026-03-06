/**
 * Zigzag / Triangle Grid Generator
 *
 * Generates a triangular lattice by connecting grid vertices with diagonal
 * lines. The row height can be compressed at top / expanded at bottom,
 * reproducing the triangle-partition screen look (image 3).
 *
 * Layout: vertices sit at a staggered grid.
 *   Even rows:  x = 0, colSpacing, 2*colSpacing …
 *   Odd rows:   x = colSpacing/2, 3*colSpacing/2 …
 * Each vertex connects to its two lower-left and lower-right neighbours.
 *
 * Optional curvature: replaces straight segments with a bezier curve that
 * bows inward or outward.
 */
export function generateZigzag(params, W, H, paper) {
  const {
    cols         = 11,
    rows         = 10,
    compress     = 0.4,   // 0 = uniform, positive = top compressed
    curvature    = 0,     // 0 = straight, ±1 = curved (inward/outward bow)
    strokeWeight = 2.5,
    color        = '#8B6914',
  } = params;

  const group = new paper.Group();

  // ── Row Y positions with variable height ────────────────────────────────
  // height_r ∝ 1 + compress*(2*(r/(rows-1)) - 1)
  // so top rows are shorter, bottom rows are taller when compress > 0
  const rawH = [];
  let total  = 0;
  for (let r = 0; r <= rows; r++) {
    const t = rows > 1 ? r / rows : 0.5;
    const h = Math.max(0.05, 1 + compress * (2 * t - 1));
    rawH.push(h);
    total += h;
  }
  const scale = H / total;

  const rowY = [0];
  for (let r = 0; r <= rows; r++) {
    rowY.push(rowY[r] + rawH[r] * scale);
  }

  // ── Column X positions (even rows) ─────────────────────────────────────
  const colSpacing = W / cols;
  const halfCol    = colSpacing / 2;

  // vertex(row, col) → paper.Point
  // Even rows: col = 0…cols, x = col * colSpacing
  // Odd rows:  col = 0…cols-1, x = (col + 0.5) * colSpacing
  function vertex(r, c) {
    const isOdd = r % 2 === 1;
    const x = isOdd ? (c + 0.5) * colSpacing : c * colSpacing;
    const y = rowY[r];
    return new paper.Point(x, y);
  }

  function addSegment(p0, p1) {
    const path = new paper.Path();
    if (Math.abs(curvature) < 0.001) {
      path.add(p0, p1);
    } else {
      // Bezier bow: control points offset perpendicular to the segment
      const mid    = p0.add(p1).divide(2);
      const dx     = p1.x - p0.x;
      const dy     = p1.y - p0.y;
      const len    = Math.sqrt(dx * dx + dy * dy);
      const nx     = -dy / len;  // perpendicular
      const ny     =  dx / len;
      const bow    = curvature * len * 0.25;
      const ctrl   = mid.add(new paper.Point(nx * bow, ny * bow));
      path.add(p0);
      path.quadraticCurveTo(ctrl, p1);
    }
    path.strokeColor = color;
    path.strokeWidth = strokeWeight;
    path.fillColor   = null;
    path.strokeCap   = 'round';
    group.addChild(path);
  }

  // ── Draw edges ──────────────────────────────────────────────────────────
  for (let r = 0; r < rows + 1; r++) {
    const isOdd = r % 2 === 1;
    const colCount = isOdd ? cols - 1 : cols;

    for (let c = 0; c <= colCount; c++) {
      const p = vertex(r, c);

      if (r < rows + 0) {
        const nextOdd = (r + 1) % 2 === 1;

        if (!isOdd) {
          // Even row → connect down-left and down-right to odd row below
          if (c > 0) {
            // down-left: even(r,c) → odd(r+1, c-1)
            addSegment(p, vertex(r + 1, c - 1));
          }
          if (c < cols) {
            // down-right: even(r,c) → odd(r+1, c)
            addSegment(p, vertex(r + 1, c));
          }
        } else {
          // Odd row → connect down-left and down-right to even row below
          // odd(r,c) → even(r+1, c)   (down-left)
          addSegment(p, vertex(r + 1, c));
          // odd(r,c) → even(r+1, c+1) (down-right)
          if (c + 1 <= cols) {
            addSegment(p, vertex(r + 1, c + 1));
          }
        }
      }
    }
  }

  return group;
}
