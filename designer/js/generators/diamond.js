/**
 * Diamond Grid Generator
 *
 * Creates two families of sinusoidal vertical paths that cross each other,
 * forming diamond-shaped cells. Supports a top/bottom frequency gradient
 * so cells can be compressed at the top and open at the bottom (or vice versa).
 *
 * Visual reference: woven diamond lattice partition screens.
 */
export function generateDiamond(params, W, H, paper) {
  const {
    cols         = 9,
    amplitude    = 38,
    freqTop      = 3.5,
    freqBottom   = 2.0,
    phaseStep    = 1.0,
    angle        = 0,
    strokeWeight = 2.5,
    color        = '#8B6914',
  } = params;

  const group = new paper.Group();
  const PTS   = 120; // path resolution

  // angle: lean of each path family (degrees off vertical)
  const lean = (angle * Math.PI) / 180;
  // horizontal drift from top to bottom due to lean
  const drift = H * Math.tan(lean);

  /**
   * Generate one sinusoidal path.
   * @param {number} centerX  - X at mid-canvas (y = H/2)
   * @param {number} phaseOff - initial phase offset (radians)
   * @param {number} dir      - +1 or -1 (mirrors left/right wave families)
   */
  function makeSinePath(centerX, phaseOff, dir) {
    const pts = [];
    for (let i = 0; i <= PTS; i++) {
      const t = i / PTS;          // 0 → 1, top → bottom
      const y = t * H;

      // Variable-frequency phase:
      // freq(t) transitions linearly from freqTop to freqBottom.
      // phase(t) = 2π × ∫₀ᵗ freq(u) du
      //          = 2π × (freqTop·t + (freqBottom - freqTop)·t²/2)
      const phase = 2 * Math.PI * (
        freqTop * t + (freqBottom - freqTop) * t * t / 2
      );

      // X: lean drift + sinusoidal deviation (mirrored for second family)
      const x = centerX
        + (t - 0.5) * drift          // lean offset
        + dir * amplitude * Math.sin(phase + phaseOff);

      pts.push(new paper.Point(x, y));
    }
    return pts;
  }

  const spacing = W / (cols + 1);

  // Two families: dir = +1 and dir = -1
  for (let family = 0; family < 2; family++) {
    const dir = family === 0 ? 1 : -1;
    // Phase offset between families creates the crossing diamond shape
    const familyPhaseShift = family === 0 ? 0 : Math.PI;

    for (let c = 0; c < cols; c++) {
      const centerX  = spacing * (c + 1);
      // Adjacent paths in the same family are phase-shifted so their
      // peaks/valleys are evenly distributed across the width
      const phaseOff = (c / cols) * 2 * Math.PI * phaseStep + familyPhaseShift;

      const pts  = makeSinePath(centerX, phaseOff, dir);
      const path = new paper.Path();
      path.addSegments(pts.map(p => new paper.Segment(p)));
      path.smooth({ type: 'catmull-rom', factor: 0.5 });
      path.strokeColor  = color;
      path.strokeWidth  = strokeWeight;
      path.fillColor    = null;
      path.strokeCap    = 'round';
      group.addChild(path);
    }
  }

  return group;
}
