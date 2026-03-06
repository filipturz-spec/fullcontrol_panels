/**
 * Ladder / Barcode Generator
 *
 * Parallel vertical lines crossed by horizontal rungs.
 * The canvas is divided into vertical "zones"; each zone has its own
 * rung density. This produces the banded barcode-like partition look (image 2).
 *
 * zones: array of { heightFrac, rungs }
 *   heightFrac – fraction of total height this zone occupies (should sum ≈ 1)
 *   rungs      – number of horizontal crossbars inside this zone (0 = none)
 */
export function generateLadder(params, W, H, paper) {
  const {
    cols         = 12,
    strokeWeight = 2.5,
    color        = '#8B6914',
    zones        = [
      { heightFrac: 0.15, rungs: 14 },
      { heightFrac: 0.15, rungs: 8  },
      { heightFrac: 0.15, rungs: 4  },
      { heightFrac: 0.15, rungs: 2  },
      { heightFrac: 0.40, rungs: 0  },
    ],
  } = params;

  const group      = new paper.Group();
  const colSpacing = W / (cols + 1);

  // ── Vertical lines ──────────────────────────────────────────────────────
  for (let c = 1; c <= cols; c++) {
    const x    = c * colSpacing;
    const path = new paper.Path();
    path.add(new paper.Point(x, 0));
    path.add(new paper.Point(x, H));
    path.strokeColor = color;
    path.strokeWidth = strokeWeight;
    path.fillColor   = null;
    path.strokeCap   = 'butt';
    group.addChild(path);
  }

  // ── Horizontal rungs per zone ───────────────────────────────────────────
  // Normalise heightFracs so they always fill the canvas height
  const totalFrac = zones.reduce((s, z) => s + Math.max(0, z.heightFrac), 0) || 1;

  let currentY = 0;
  for (const zone of zones) {
    const zH = (zone.heightFrac / totalFrac) * H;
    const n  = Math.round(zone.rungs);

    if (n > 0) {
      // n+1 intervals → n internal rungs
      const step = zH / (n + 1);
      for (let r = 1; r <= n; r++) {
        const y    = currentY + r * step;
        const path = new paper.Path();
        path.add(new paper.Point(colSpacing,        y));
        path.add(new paper.Point(cols * colSpacing, y));
        path.strokeColor = color;
        path.strokeWidth = strokeWeight;
        path.fillColor   = null;
        path.strokeCap   = 'butt';
        group.addChild(path);
      }
    }

    currentY += zH;
  }

  return group;
}
