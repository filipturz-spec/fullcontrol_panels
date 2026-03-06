/**
 * Rounded Rectangle Grid Generator
 *
 * Fills the canvas with a grid of rounded rectangles (stroke only, no fill).
 * Optional thin connector bridges link adjacent cells horizontally and/or
 * vertically, reproducing the linked-chain partition look (image 4).
 */
export function generateRoundedRect(params, W, H, paper) {
  const {
    cols         = 5,
    rows         = 8,
    gapX         = 10,
    gapY         = 10,
    cornerRadius = 18,
    linkH        = false,
    linkV        = false,
    strokeWeight = 3,
    color        = '#7a2a10',
  } = params;

  const group = new paper.Group();

  // Cell dimensions derived from canvas + gap parameters
  const cellW = (W - (cols + 1) * gapX) / cols;
  const cellH = (H - (rows + 1) * gapY) / rows;
  const r     = Math.min(cornerRadius, cellW / 2, cellH / 2);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = gapX + col * (cellW + gapX);
      const y = gapY + row * (cellH + gapY);

      const rect = new paper.Path.Rectangle({
        point:  [x, y],
        size:   [cellW, cellH],
        radius: r,
      });
      rect.strokeColor = color;
      rect.strokeWidth = strokeWeight;
      rect.fillColor   = null;
      group.addChild(rect);

      // Horizontal link: connects right side of this cell to left side of next
      if (linkH && col < cols - 1) {
        const lx0 = x + cellW;
        const lx1 = x + cellW + gapX;
        const ly  = y + cellH / 2;
        const link = new paper.Path();
        link.add(new paper.Point(lx0, ly));
        link.add(new paper.Point(lx1, ly));
        link.strokeColor = color;
        link.strokeWidth = strokeWeight * 0.6;
        link.fillColor   = null;
        group.addChild(link);
      }

      // Vertical link: connects bottom of this cell to top of cell below
      if (linkV && row < rows - 1) {
        const vx  = x + cellW / 2;
        const vy0 = y + cellH;
        const vy1 = y + cellH + gapY;
        const link = new paper.Path();
        link.add(new paper.Point(vx, vy0));
        link.add(new paper.Point(vx, vy1));
        link.strokeColor = color;
        link.strokeWidth = strokeWeight * 0.6;
        link.fillColor   = null;
        group.addChild(link);
      }
    }
  }

  return group;
}
