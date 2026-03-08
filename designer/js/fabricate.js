/**
 * fabricate.js — GCode export for Partition Screen Designer
 *
 * Depends on globals defined in index.html's inline script:
 *   App, layers, bunchY(), dl()
 *
 * All output coordinates are in mm.
 * App params (amplitude, cycleH, depth, etc.) are in cm → ×10 for mm.
 */
'use strict';

const _CM = 10; // cm → mm

// ── Bezier samplers ───────────────────────────────────────────────────────

function _cubicBez(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return {
    x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
    y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
  };
}

function _quadBez(t, p0, p1, p2) {
  const u = 1 - t;
  return {
    x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
    y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y,
  };
}

// ── Raw geometry generators ───────────────────────────────────────────────
// Each returns [{x, y}, ...] relative to segment centre (x=0).
// Coordinates in mm. segW and H in mm.
// These mirror the Paper.js generators in index.html exactly.

function _rawStraight(_p, _segW, H) {
  return [{ x: 0, y: 0 }, { x: 0, y: H }];
}

function _rawSine(p, segW, H) {
  const amp     = p.amplitude * _CM;
  const halfSeg = segW / 2;
  const cycleH  = p.cycleH * _CM;
  const maxCyc  = Math.floor(H / cycleH);
  if (maxCyc < 1) return [];
  const nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
  const totalH = nCyc * cycleH;
  const k      = (p.bunch || 0) * 5;
  const phase  = p.startPhase === 'peak'   ?  Math.PI / 2
               : p.startPhase === 'valley' ? -Math.PI / 2 : 0;
  const N  = Math.max(60, nCyc * 40);
  const pts = [];
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const x = Math.max(-halfSeg, Math.min(halfSeg,
                amp * Math.sin(2 * Math.PI * nCyc * t + phase)));
    pts.push({ x, y: bunchY(t, k) * totalH });
  }
  return pts;
}

function _rawBezier(p, segW, H) {
  const amp    = Math.min(p.amplitude * _CM, segW / 2);
  const cycleH = p.cycleH * _CM;
  const maxCyc = Math.floor(H / cycleH);
  if (maxCyc < 1) return [];
  const nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
  const totalH = nCyc * cycleH;
  const k      = (p.bunch || 0) * 5;
  const cpX    = (4 / 3) * amp;
  const N      = 20; // samples per cycle
  const pts    = [];

  if (p.startPhase === 'center') {
    pts.push({ x: 0, y: 0 });
    for (let c = 0; c < nCyc; c++) {
      const dir = c % 2 === 0 ? 1 : -1;
      const y0  = bunchY(c / nCyc, k) * totalH;
      const y1  = bunchY((c + 1) / nCyc, k) * totalH;
      const hv  = ((y1 - y0) / 2) * (p.sharpness || 0);
      for (let s = 1; s <= N; s++) {
        pts.push(_cubicBez(s / N,
          { x: 0,        y: y0      },
          { x: cpX*dir,  y: y0 + hv },
          { x: cpX*dir,  y: y1 - hv },
          { x: 0,        y: y1      }));
      }
    }
  } else {
    const startX = (p.startPhase === 'peak') ? amp : -amp;
    pts.push({ x: startX, y: 0 });
    for (let c = 0; c < nCyc; c++) {
      const y0    = bunchY(c / nCyc, k) * totalH;
      const y1    = bunchY((c + 1) / nCyc, k) * totalH;
      const cpY   = (y1 - y0) / 3;
      const fromX = c % 2 === 0 ? startX : -startX;
      const toX   = -fromX;
      for (let s = 1; s <= N; s++) {
        pts.push(_cubicBez(s / N,
          { x: fromX, y: y0        },
          { x: fromX, y: y0 + cpY  },
          { x: toX,   y: y1 - cpY  },
          { x: toX,   y: y1        }));
      }
    }
  }
  return pts;
}

function _rawArch(p, segW, H, strokeWidthCm) {
  const halfW  = segW / 2;
  const halfSW = (strokeWidthCm * _CM) / 2;
  const hit_y  = Math.min(p.depth * _CM, H - 1);
  const y_cp   = (p.sharpness || 0) * hit_y;
  const xLand  = -halfW + halfSW + (p.inset || 0) * _CM;
  const N      = 30;
  const pts    = [];
  for (let s = 0; s <= N; s++) {
    pts.push(_quadBez(s / N,
      { x: halfW, y: 0     },
      { x: xLand, y: y_cp  },
      { x: xLand, y: hit_y }));
  }
  pts.push({ x: xLand, y: H });
  return pts;
}

function _rawSquare(p, segW, H) {
  const amp    = Math.min(p.amplitude * _CM, segW / 2);
  const cycleH = p.cycleH * _CM;
  const maxCyc = Math.floor(H / cycleH);
  if (maxCyc < 1) return [];
  const nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
  const totalH = nCyc * cycleH;
  const k      = (p.bunch || 0) * 5;
  const K      = 0.5523; // bezier quarter-circle factor
  const NA     = 8;      // arc samples per corner
  const pts    = [{ x: amp, y: 0 }];

  function corner(p0, cp0, cp1, p1) {
    for (let s = 1; s <= NA; s++) pts.push(_cubicBez(s / NA, p0, cp0, cp1, p1));
  }

  for (let c = 0; c < nCyc; c++) {
    const y0    = bunchY(c / nCyc, k) * totalH;
    const y1    = bunchY((c + 1) / nCyc, k) * totalH;
    const yM    = (y0 + y1) / 2;
    const halfH = (y1 - y0) / 2;
    const r     = Math.min((p.cornerRadius || 0) * _CM, halfH * 0.45, amp * 0.9);
    const last  = c === nCyc - 1;

    if (r <= 0) {
      pts.push({ x:  amp, y: yM });
      pts.push({ x: -amp, y: yM });
      pts.push({ x: -amp, y: y1 });
      if (!last) pts.push({ x: amp, y: y1 });
    } else {
      pts.push({ x: amp, y: yM - r });
      corner(
        { x: amp,       y: yM - r         },
        { x: amp,       y: yM - r + K * r },
        { x: amp - K*r, y: yM             },
        { x: amp - r,   y: yM             }
      );
      pts.push({ x: -amp + r, y: yM });
      corner(
        { x: -amp + r,       y: yM         },
        { x: -amp + r - K*r, y: yM         },
        { x: -amp,           y: yM + K * r },
        { x: -amp,           y: yM + r     }
      );
      if (!last) {
        pts.push({ x: -amp, y: y1 - r });
        corner(
          { x: -amp,       y: y1 - r         },
          { x: -amp,       y: y1 - r + K * r },
          { x: -amp + K*r, y: y1             },
          { x: -amp + r,   y: y1             }
        );
        pts.push({ x: amp - r, y: y1 });
        corner(
          { x: amp - r,       y: y1         },
          { x: amp - r + K*r, y: y1         },
          { x: amp,           y: y1 + K * r },
          { x: amp,           y: y1 + r     }
        );
      } else {
        pts.push({ x: -amp, y: y1 });
      }
    }
  }
  return pts;
}

// Circle returns an array of paths (1 full circle, or 2 arcs if overflowing)
function _rawCirclePaths(p, segW, H) {
  const cy    = (p.yPos / 100) * H;
  const r     = p.diameter * _CM / 2;
  const halfW = segW / 2;
  if (r <= 0) return [];

  if (r <= halfW) {
    const N = 64;
    const pts = [];
    for (let t = 0; t <= N; t++) {
      const θ = (t / N) * 2 * Math.PI;
      pts.push({ x: r * Math.cos(θ), y: cy + r * Math.sin(θ) });
    }
    return [pts];
  } else {
    const α = Math.acos(halfW / r);
    const N = 40;
    const topPts = [], botPts = [];
    for (let t = 0; t <= N; t++) {
      const θ = (α - Math.PI) + (t / N) * (Math.PI - 2 * α);
      topPts.push({ x: r * Math.cos(θ), y: cy + r * Math.sin(θ) });
    }
    for (let t = 0; t <= N; t++) {
      const θ = α + (t / N) * (Math.PI - 2 * α);
      botPts.push({ x: r * Math.cos(θ), y: cy + r * Math.sin(θ) });
    }
    return [topPts, botPts];
  }
}

// ── Segment stamping ──────────────────────────────────────────────────────
// Translates base paths (centred at x=0) into absolute mm coordinates
// for each segment, applying LRLR/RRRR mirroring and flipV.

function _stampPaths(basePaths, layer, W_mm, H_mm) {
  const n    = layer.segments;
  const segW = W_mm / n;
  const out  = [];

  for (let i = 0; i < n; i++) {
    const cx   = (i + 0.5) * segW;
    const flip = layer.direction === 'RRRR' ||
                 (layer.direction === 'LRLR' && i % 2 === 1);
    for (const base of basePaths) {
      out.push(base.map(pt => ({
        x: cx + (flip ? -pt.x : pt.x),
        y: layer.flipV ? H_mm - pt.y : pt.y,
      })));
    }
  }
  return out;
}

// ── Collect paths from all visible layers ─────────────────────────────────

function _extractPaths() {
  const W_mm = App.panelW * _CM;
  const H_mm = App.panelH * _CM;
  const all  = [];

  for (const layer of layers) {
    if (!layer.visible) continue;

    // Use front params for GCode (back face at Z=0 would need separate pass)
    const p    = layer.params;
    const segW = W_mm / layer.segments;
    const sw   = layer.style ? layer.style.strokeWidth : 0.3;
    let basePaths = [];

    switch (layer.gen) {
      case 'straight': basePaths = [_rawStraight(p, segW, H_mm)];               break;
      case 'sine':     basePaths = [_rawSine(p, segW, H_mm)];                    break;
      case 'bezier':   basePaths = [_rawBezier(p, segW, H_mm)];                  break;
      case 'arch':     basePaths = [_rawArch(p, segW, H_mm, sw)];                break;
      case 'square':   basePaths = [_rawSquare(p, segW, H_mm)];                  break;
      case 'circle':   basePaths = _rawCirclePaths(p, segW, H_mm);               break;
    }

    const stamped = _stampPaths(basePaths, layer, W_mm, H_mm);
    all.push(...stamped.filter(pts => pts.length >= 2));
  }
  return all;
}

// ── Greedy nearest-endpoint path sort ────────────────────────────────────

function _sortPaths(paths) {
  if (paths.length === 0) return [];
  const used   = new Array(paths.length).fill(false);
  const sorted = [];
  let cx = 0, cy = 0;

  for (let n = 0; n < paths.length; n++) {
    let bestI = -1, bestD = Infinity, bestRev = false;
    for (let i = 0; i < paths.length; i++) {
      if (used[i]) continue;
      const s = paths[i][0];
      const e = paths[i][paths[i].length - 1];
      const ds = (s.x - cx) ** 2 + (s.y - cy) ** 2;
      const de = (e.x - cx) ** 2 + (e.y - cy) ** 2;
      if (ds < bestD) { bestD = ds; bestI = i; bestRev = false; }
      if (de < bestD) { bestD = de; bestI = i; bestRev = true;  }
    }
    used[bestI] = true;
    const pts = bestRev ? [...paths[bestI]].reverse() : paths[bestI];
    sorted.push(pts);
    const last = pts[pts.length - 1];
    cx = last.x; cy = last.y;
  }
  return sorted;
}

// ── GCode builder ─────────────────────────────────────────────────────────

function _buildGCode(sorted, cfg) {
  const H_mm      = App.panelH * _CM;
  const numLayers = Math.max(1, Math.round(cfg.depth / cfg.layerH));
  const filArea   = Math.PI * (cfg.filmD / 2) ** 2;
  const eRate     = (cfg.lineW * cfg.layerH) / filArea; // mm filament per mm travel
  const f3        = v => v.toFixed(3);
  const fMin      = v => Math.round(v * 60);            // mm/s → mm/min

  const out = [];
  out.push(
    '; ================================================',
    `; Partition Screen — GCode`,
    `; Panel ${App.panelW}×${App.panelH} cm   Depth ${cfg.depth} mm`,
    `; ${numLayers} layers × ${cfg.layerH} mm   Line width ${cfg.lineW} mm`,
    `; Nozzle ${cfg.nozzleT} °C   Bed ${cfg.bedT} °C   Ø${cfg.filmD} mm filament`,
    `; Print ${cfg.printV} mm/s   Travel ${cfg.travelV} mm/s`,
    '; ================================================',
    '',
  );

  if (cfg.startG.trim()) {
    out.push(cfg.startG.trim(), '');
  } else {
    out.push(
      `M104 S${cfg.nozzleT}`,
      `M140 S${cfg.bedT}`,
      `M109 S${cfg.nozzleT}`,
      `M190 S${cfg.bedT}`,
      `G28`,
      `G92 E0`,
      `G90`,
      `M82`,
      '',
    );
  }

  out.push(`G0 F${fMin(cfg.travelV)} Z${f3(cfg.layerH)}`, '');

  let E = 0;
  for (let layer = 0; layer < numLayers; layer++) {
    const z = f3((layer + 1) * cfg.layerH);
    out.push(`; --- Layer ${layer + 1}/${numLayers}  Z=${z} ---`);
    out.push(`G0 Z${z}`);

    let cx = 0, cy = 0;
    for (const pts of sorted) {
      const s0 = pts[0];
      // Flip Y: canvas Y=0 is top; printer Y=0 is front (bottom of panel)
      const gy0 = H_mm - s0.y;
      out.push(`G0 F${fMin(cfg.travelV)} X${f3(s0.x)} Y${f3(gy0)}`);
      out.push(`G1 F${fMin(cfg.printV)}`);
      cx = s0.x; cy = s0.y;

      for (let i = 1; i < pts.length; i++) {
        const pt  = pts[i];
        const gy  = H_mm - pt.y;
        const dx  = pt.x - cx;
        const dy  = gy - (H_mm - cy);
        E += Math.sqrt(dx * dx + dy * dy) * eRate;
        out.push(`G1 X${f3(pt.x)} Y${f3(gy)} E${f3(E)}`);
        cx = pt.x; cy = pt.y;
      }
    }
    out.push('');
  }

  if (cfg.endG.trim()) {
    out.push(cfg.endG.trim());
  } else {
    out.push(`M104 S0`, `M140 S0`, `G28 X Y`, `M84`);
  }

  return out.join('\n');
}

// ── Public entry point ────────────────────────────────────────────────────

function exportGCode() {
  const gv  = id => document.getElementById(id).value;
  const gn  = id => parseFloat(gv(id)) || 0;

  const cfg = {
    depth:   gn('fab-depth'),
    layerH:  gn('fab-lh'),
    lineW:   gn('fab-lw'),
    printV:  gn('fab-ps'),
    travelV: gn('fab-ts'),
    nozzleT: gn('fab-nt'),
    bedT:    gn('fab-bt'),
    filmD:   gn('fab-fd'),
    startG:  gv('fab-start'),
    endG:    gv('fab-end'),
  };

  if (!layers.some(l => l.visible)) {
    alert('No visible layers to export.'); return;
  }

  const paths  = _extractPaths();
  const sorted = _sortPaths(paths);
  const gcode  = _buildGCode(sorted, cfg);
  dl('partition-screen.gcode', gcode, 'text/plain');
}
