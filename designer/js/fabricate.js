/**
 * fabricate.js — GCode export for Partition Screen Designer
 *
 * Wrapped in an IIFE so all internal const/let/function declarations are
 * local and cannot collide with anything in index.html's global scope.
 * Only window.exportGCode is exposed.
 *
 * Reads App and layers from the global scope set by index.html.
 * All output coordinates are in mm (App params are in cm, ×10).
 */
(function () {
  'use strict';

  var CM = 10; // cm → mm

  // ── Download helper ──────────────────────────────────────────────────────

  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ── bunchY (mirrors index.html) ──────────────────────────────────────────

  function bunchY(t, k) {
    if (k <= 0) return t;
    return (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
  }

  // ── Bezier samplers ──────────────────────────────────────────────────────

  function cubicBez(t, p0, p1, p2, p3) {
    var u = 1 - t;
    return {
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
  }

  function quadBez(t, p0, p1, p2) {
    var u = 1 - t;
    return {
      x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
      y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y,
    };
  }

  // ── Raw geometry generators ──────────────────────────────────────────────
  // Each returns [{x,y},...] relative to segment centre (x=0), coords in mm.

  function rawStraight(_p, _segW, H) {
    return [{ x: 0, y: 0 }, { x: 0, y: H }];
  }

  function rawSine(p, segW, H) {
    var amp     = p.amplitude * CM;
    var halfSeg = segW / 2;
    var cycleH  = p.cycleH * CM;
    var maxCyc  = Math.floor(H / cycleH);
    if (maxCyc < 1) return [];
    var nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
    var totalH = nCyc * cycleH;
    var k      = (p.bunch || 0) * 5;
    var phase  = p.startPhase === 'peak'   ?  Math.PI / 2
               : p.startPhase === 'valley' ? -Math.PI / 2 : 0;
    var N   = Math.max(60, nCyc * 40);
    var pts = [];
    for (var s = 0; s <= N; s++) {
      var t = s / N;
      var x = Math.max(-halfSeg, Math.min(halfSeg,
                amp * Math.sin(2 * Math.PI * nCyc * t + phase)));
      pts.push({ x: x, y: bunchY(t, k) * totalH });
    }
    return pts;
  }

  function rawBezier(p, segW, H) {
    var amp    = Math.min(p.amplitude * CM, segW / 2);
    var cycleH = p.cycleH * CM;
    var maxCyc = Math.floor(H / cycleH);
    if (maxCyc < 1) return [];
    var nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
    var totalH = nCyc * cycleH;
    var k      = (p.bunch || 0) * 5;
    var cpX    = (4 / 3) * amp;
    var N      = 20;
    var pts    = [];

    if (p.startPhase === 'center') {
      pts.push({ x: 0, y: 0 });
      for (var c = 0; c < nCyc; c++) {
        var dir = c % 2 === 0 ? 1 : -1;
        var y0  = bunchY(c / nCyc, k) * totalH;
        var y1  = bunchY((c + 1) / nCyc, k) * totalH;
        var hv  = ((y1 - y0) / 2) * (p.sharpness || 0);
        for (var s = 1; s <= N; s++) {
          pts.push(cubicBez(s / N,
            { x: 0,        y: y0      },
            { x: cpX*dir,  y: y0 + hv },
            { x: cpX*dir,  y: y1 - hv },
            { x: 0,        y: y1      }));
        }
      }
    } else {
      var startX = (p.startPhase === 'peak') ? amp : -amp;
      pts.push({ x: startX, y: 0 });
      for (var c = 0; c < nCyc; c++) {
        var y0    = bunchY(c / nCyc, k) * totalH;
        var y1    = bunchY((c + 1) / nCyc, k) * totalH;
        var cpY   = (y1 - y0) / 3;
        var fromX = c % 2 === 0 ? startX : -startX;
        var toX   = -fromX;
        for (var s = 1; s <= N; s++) {
          pts.push(cubicBez(s / N,
            { x: fromX, y: y0        },
            { x: fromX, y: y0 + cpY  },
            { x: toX,   y: y1 - cpY  },
            { x: toX,   y: y1        }));
        }
      }
    }
    return pts;
  }

  function rawArch(p, segW, H, strokeWidthCm) {
    var halfW  = segW / 2;
    var halfSW = (strokeWidthCm * CM) / 2;
    var hit_y  = Math.min(p.depth * CM, H - 1);
    var y_cp   = (p.sharpness || 0) * hit_y;
    var xLand  = -halfW + halfSW + (p.inset || 0) * CM;
    var N      = 30;
    var pts    = [];
    for (var s = 0; s <= N; s++) {
      pts.push(quadBez(s / N,
        { x: halfW, y: 0     },
        { x: xLand, y: y_cp  },
        { x: xLand, y: hit_y }));
    }
    pts.push({ x: xLand, y: H });
    return pts;
  }

  function rawSquare(p, segW, H) {
    var amp    = Math.min(p.amplitude * CM, segW / 2);
    var cycleH = p.cycleH * CM;
    var maxCyc = Math.floor(H / cycleH);
    if (maxCyc < 1) return [];
    var nCyc   = (p.visibleCycles > 0) ? Math.min(maxCyc, p.visibleCycles) : maxCyc;
    var totalH = nCyc * cycleH;
    var k      = (p.bunch || 0) * 5;
    var K      = 0.5523;
    var NA     = 8;
    var pts    = [{ x: amp, y: 0 }];

    function corner(p0, cp0, cp1, p1) {
      for (var s = 1; s <= NA; s++) pts.push(cubicBez(s / NA, p0, cp0, cp1, p1));
    }

    for (var c = 0; c < nCyc; c++) {
      var y0    = bunchY(c / nCyc, k) * totalH;
      var y1    = bunchY((c + 1) / nCyc, k) * totalH;
      var yM    = (y0 + y1) / 2;
      var halfH = (y1 - y0) / 2;
      var r     = Math.min((p.cornerRadius || 0) * CM, halfH * 0.45, amp * 0.9);
      var last  = c === nCyc - 1;

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

  function rawCirclePaths(p, segW, H) {
    var cy    = (p.yPos / 100) * H;
    var r     = p.diameter * CM / 2;
    var halfW = segW / 2;
    if (r <= 0) return [];

    if (r <= halfW) {
      var N = 64, pts = [];
      for (var i = 0; i <= N; i++) {
        var ang = (i / N) * 2 * Math.PI;
        pts.push({ x: r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      }
      return [pts];
    } else {
      var alpha = Math.acos(halfW / r);
      var N = 40, topPts = [], botPts = [];
      for (var i = 0; i <= N; i++) {
        var ang = (alpha - Math.PI) + (i / N) * (Math.PI - 2 * alpha);
        topPts.push({ x: r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      }
      for (var i = 0; i <= N; i++) {
        var ang = alpha + (i / N) * (Math.PI - 2 * alpha);
        botPts.push({ x: r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      }
      return [topPts, botPts];
    }
  }

  // ── Segment stamping ─────────────────────────────────────────────────────

  function stampPaths(basePaths, layer, W_mm, H_mm) {
    var n    = layer.segments;
    var segW = W_mm / n;
    var out  = [];
    for (var i = 0; i < n; i++) {
      var cx   = (i + 0.5) * segW;
      var flip = layer.direction === 'RRRR' ||
                 (layer.direction === 'LRLR' && i % 2 === 1);
      for (var b = 0; b < basePaths.length; b++) {
        var base = basePaths[b];
        out.push(base.map(function (pt) {
          return {
            x: cx + (flip ? -pt.x : pt.x),
            y: layer.flipV ? H_mm - pt.y : pt.y,
          };
        }));
      }
    }
    return out;
  }

  // ── Warp transform (mirrors applyWarp() in index.html) ──────────────────
  // Displacement: dy = A_mm * sin(π * x / W_mm) * (y / H_mm)
  // Top edge (y=0) is pinned; displacement grows toward the bottom.
  // Positive warpAmount bows the bottom edge downward (outward in Paper.js).

  function applyWarpToPaths(all, W_mm, H_mm) {
    var A = (App.warpAmount || 0) * CM;
    if (!A) return all;
    return all.map(function (path) {
      return path.map(function (pt) {
        return {
          x: pt.x,
          y: pt.y + A * Math.sin(Math.PI * pt.x / W_mm) * (pt.y / H_mm),
        };
      });
    });
  }

  // ── Extract paths at interpolation factor t ──────────────────────────────
  // t = 0 → back face geometry, t = 1 → front face geometry.
  // For layers with backParams.amplitude, the amplitude is linearly blended.
  // Border walls (if App.showGrid) are prepended to every layer's path list.
  // Warp deformation is applied to all paths before returning.

  function extractPathsAt(t) {
    var W_mm = App.panelW * CM;
    var H_mm = App.panelH * CM;
    var all  = [];

    // Border walls — printed on every Z layer as the structural frame.
    // Bottom wall uses 32 intermediate points so the warp curves it smoothly.
    if (App.showGrid && App.border) {
      var walls = App.border.walls || {};
      if (walls.top)   all.push([{ x: 0,    y: 0    }, { x: W_mm, y: 0    }]);
      if (walls.right) all.push([{ x: W_mm, y: 0    }, { x: W_mm, y: H_mm }]);
      if (walls.left)  all.push([{ x: 0,    y: 0    }, { x: 0,    y: H_mm }]);
      if (walls.bottom) {
        var N = 32, bpts = [];
        for (var wi = 0; wi <= N; wi++) bpts.push({ x: W_mm * wi / N, y: H_mm });
        all.push(bpts);
      }
    }

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!layer.visible) continue;

      var p  = layer.params;
      var bp = layer.backParams || {};

      // Blend amplitude: t=0 → back amplitude, t=1 → front amplitude.
      // Only sine and square carry backParams.amplitude; others are unchanged.
      var blended = p;
      if (bp.amplitude !== undefined && p.amplitude !== undefined
          && bp.amplitude !== p.amplitude) {
        blended = {};
        for (var key in p) if (Object.prototype.hasOwnProperty.call(p, key)) blended[key] = p[key];
        blended.amplitude = bp.amplitude + (p.amplitude - bp.amplitude) * t;
      }

      var segW      = W_mm / layer.segments;
      var sw        = layer.style ? layer.style.strokeWidth : 0.3;
      var basePaths = [];

      switch (layer.gen) {
        case 'straight': basePaths = [rawStraight(blended, segW, H_mm)];        break;
        case 'sine':     basePaths = [rawSine(blended, segW, H_mm)];             break;
        case 'bezier':   basePaths = [rawBezier(blended, segW, H_mm)];           break;
        case 'arch':     basePaths = [rawArch(blended, segW, H_mm, sw)];         break;
        case 'square':   basePaths = [rawSquare(blended, segW, H_mm)];           break;
        case 'circle':   basePaths = rawCirclePaths(blended, segW, H_mm);        break;
      }

      var stamped = stampPaths(basePaths, layer, W_mm, H_mm);
      for (var j = 0; j < stamped.length; j++) {
        if (stamped[j].length >= 2) all.push(stamped[j]);
      }
    }

    return applyWarpToPaths(all, W_mm, H_mm);
  }

  // ── Greedy nearest-endpoint path sort ────────────────────────────────────

  function sortPaths(paths) {
    if (paths.length === 0) return [];
    var used   = new Array(paths.length).fill(false);
    var sorted = [];
    var cx = 0, cy = 0;

    for (var n = 0; n < paths.length; n++) {
      var bestI = -1, bestD = Infinity, bestRev = false;
      for (var i = 0; i < paths.length; i++) {
        if (used[i]) continue;
        var s  = paths[i][0];
        var e  = paths[i][paths[i].length - 1];
        var ds = (s.x - cx) * (s.x - cx) + (s.y - cy) * (s.y - cy);
        var de = (e.x - cx) * (e.x - cx) + (e.y - cy) * (e.y - cy);
        if (ds < bestD) { bestD = ds; bestI = i; bestRev = false; }
        if (de < bestD) { bestD = de; bestI = i; bestRev = true;  }
      }
      used[bestI] = true;
      var pts = bestRev ? paths[bestI].slice().reverse() : paths[bestI];
      sorted.push(pts);
      var last = pts[pts.length - 1];
      cx = last.x; cy = last.y;
    }
    return sorted;
  }

  // ── GCode builder ────────────────────────────────────────────────────────
  // Uses M83 relative extrusion. eRate is derived from bead cross-section so
  // the extruded volume matches the intended line width × layer height.
  // Paths are re-extracted per print layer for amplitude interpolation.

  function buildGCode(cfg) {
    var H_mm      = App.panelH * CM;
    var numLayers = Math.max(1, Math.round(cfg.depth / cfg.layerH));
    var filRad    = cfg.filamentDia / 2;
    // mm of filament per mm of travel: bead area / filament cross-section area
    var eRate     = (cfg.lineW * cfg.layerH) / (Math.PI * filRad * filRad) * cfg.extMult;
    var retract   = cfg.retract;               // mm of filament to retract
    var retF      = fMin(cfg.travelV);         // retract at travel speed
    var f3        = function (v) { return v.toFixed(3); };
    function fMin(v) { return Math.round(v * 60); }

    var out = [];
    out.push(
      '; ================================================',
      '; Partition Screen \u2014 GCode',
      '; Panel ' + App.panelW + '\xD7' + App.panelH + ' cm   Depth ' + cfg.depth + ' mm',
      '; ' + numLayers + ' layers \xD7 ' + cfg.layerH + ' mm',
      '; Line ' + cfg.lineW + ' mm   Filament \u00D8' + cfg.filamentDia + ' mm   eRate ' + eRate.toFixed(4),
      '; Nozzle ' + cfg.nozzleT + ' \xB0C   Bed ' + cfg.bedT + ' \xB0C',
      '; Print ' + cfg.printV + ' mm/s   Travel ' + cfg.travelV + ' mm/s   Flow \xD7' + cfg.extMult,
      '; Retract ' + retract + ' mm',
      '; ================================================',
      ''
    );

    if (cfg.startG.trim()) {
      out.push(cfg.startG.trim(), '');
    } else {
      out.push(
        'M104 S' + cfg.nozzleT,
        'M140 S' + cfg.bedT,
        'M109 S' + cfg.nozzleT,
        'M190 S' + cfg.bedT,
        'G28',
        'G90',   // absolute XYZ
        'M83',   // relative extrusion
        'G92 E0',
        ''
      );
    }

    out.push('G0 F' + fMin(cfg.travelV) + ' Z' + f3(cfg.layerH), '');

    for (var layer = 0; layer < numLayers; layer++) {
      // t=0 → back face (first/bottom layer), t=1 → front face (last/top layer)
      var t      = numLayers <= 1 ? 1 : layer / (numLayers - 1);
      var paths  = extractPathsAt(t);
      var sorted = sortPaths(paths);

      var z = f3((layer + 1) * cfg.layerH);
      out.push(';LAYER_CHANGE');
      out.push(';Z:' + z);
      out.push('G92 E0');
      out.push('G1 Z' + z + ' F' + fMin(Math.min(cfg.printV, 10)));

      var cx = 0, cy = 0;
      var primed = false;

      for (var pi = 0; pi < sorted.length; pi++) {
        var pts = sorted[pi];
        var s0  = pts[0];
        var gy0 = H_mm - s0.y;

        // Retract before travel (skip before very first path on layer)
        if (primed && retract > 0) {
          out.push('G1 E-' + f3(retract) + ' F' + retF);
        }

        // Travel to path start
        out.push('G0 F' + fMin(cfg.travelV) + ' X' + f3(s0.x) + ' Y' + f3(gy0));

        // Un-retract / prime
        if (retract > 0) {
          out.push('G1 E' + f3(retract) + ' F' + retF);
        }
        primed = true;

        cx = s0.x; cy = s0.y;

        for (var i = 1; i < pts.length; i++) {
          var pt  = pts[i];
          var gy  = H_mm - pt.y;
          var dx  = pt.x - cx;
          var dy  = gy - (H_mm - cy);
          var de  = Math.sqrt(dx * dx + dy * dy) * eRate;
          // First segment on path sets speed; subsequent segments omit F for brevity
          if (i === 1) {
            out.push('G1 F' + fMin(cfg.printV) + ' X' + f3(pt.x) + ' Y' + f3(gy) + ' E' + f3(de));
          } else {
            out.push('G1 X' + f3(pt.x) + ' Y' + f3(gy) + ' E' + f3(de));
          }
          cx = pt.x; cy = pt.y;
        }
      }
      out.push('');
    }

    if (cfg.endG.trim()) {
      out.push(cfg.endG.trim());
    } else {
      out.push('M104 S0', 'M140 S0', 'G28 X Y', 'M84');
    }

    return out.join('\n');
  }

  // ── Public entry point ───────────────────────────────────────────────────

  window.exportGCode = function () {
    var gv  = function (id) { return document.getElementById(id).value; };
    var gn  = function (id) { return parseFloat(gv(id)) || 0; };

    try {
      var cfg = {
        depth:       gn('fab-depth'),
        layerH:      gn('fab-lh'),
        lineW:       gn('fab-lw'),
        filamentDia: gn('fab-fd') || 1.75,
        extMult:     gn('fab-em') || 1.0,
        retract:     gn('fab-ret'),
        printV:      gn('fab-ps'),
        travelV:     gn('fab-ts'),
        nozzleT:     gn('fab-nt'),
        bedT:        gn('fab-bt'),
        startG:      gv('fab-start'),
        endG:        gv('fab-end'),
      };

      var hasBorder = App.showGrid && App.border &&
        (App.border.walls.top || App.border.walls.right ||
         App.border.walls.bottom || App.border.walls.left);

      if (!hasBorder && !layers.some(function (l) { return l.visible; })) {
        alert('No visible layers to export.'); return;
      }

      var gcode = buildGCode(cfg);
      download('partition-screen.gcode', gcode, 'text/plain');
    } catch (err) {
      alert('GCode export failed:\n' + err.message);
      console.error(err);
    }
  };

}());
