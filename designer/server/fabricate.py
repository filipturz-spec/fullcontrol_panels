"""
Partition Screen — Python G-code fabricator
============================================
Collision-aware port of fabricate.js.  Uses Shapely to trim segments of
later paths that would double-print over already-committed beads.

Usage
-----
    python fabricate.py design.json [output.gcode]

design.json is produced by the "JSON" button in the designer.
If output path is omitted the .gcode is written next to the .json file.

Dependencies
------------
    pip install shapely          # overlap trimming (highly recommended)
    # numpy/plotly not needed — this script is self-contained
"""

import heapq
import json
import math
import sys
from pathlib import Path

try:
    from shapely.geometry import LineString, MultiLineString, box
    from shapely.ops import unary_union
    HAS_SHAPELY = True
except ImportError:
    HAS_SHAPELY = False

CM = 10  # cm → mm


# ── Math helpers ──────────────────────────────────────────────────────────────

def bunch_y(t, k):
    if k <= 0:
        return t
    return (math.exp(k * t) - 1) / (math.exp(k) - 1)


def cubic_bez(t, p0, p1, p2, p3):
    u = 1 - t
    return (
        u**3*p0[0] + 3*u**2*t*p1[0] + 3*u*t**2*p2[0] + t**3*p3[0],
        u**3*p0[1] + 3*u**2*t*p1[1] + 3*u*t**2*p2[1] + t**3*p3[1],
    )


def quad_bez(t, p0, p1, p2):
    u = 1 - t
    return (
        u**2*p0[0] + 2*u*t*p1[0] + t**2*p2[0],
        u**2*p0[1] + 2*u*t*p1[1] + t**2*p2[1],
    )


# ── Raw generators ────────────────────────────────────────────────────────────
# All return [(x, y), ...] relative to segment centre, coords in mm.

def gen_straight(_p, _seg_w, H):
    return [(0, 0), (0, H)]


def gen_sine(p, seg_w, H):
    amp      = p['amplitude'] * CM
    half_seg = seg_w / 2
    cycle_h  = p['cycleH'] * CM
    max_cyc  = math.floor(H / cycle_h)
    if max_cyc < 1:
        return []
    vis    = p.get('visibleCycles') or 0
    n_cyc  = min(max_cyc, vis) if vis > 0 else max_cyc
    total_h = n_cyc * cycle_h
    k      = (p.get('bunch') or 0) * 5
    phase  = (math.pi / 2  if p.get('startPhase') == 'peak'
              else -math.pi / 2 if p.get('startPhase') == 'valley'
              else 0)
    N   = max(60, n_cyc * 40)
    pts = []
    for s in range(N + 1):
        t = s / N
        x = max(-half_seg, min(half_seg,
                amp * math.sin(2 * math.pi * n_cyc * t + phase)))
        pts.append((x, bunch_y(t, k) * total_h))
    return pts


def gen_bezier(p, seg_w, H):
    amp     = min(p['amplitude'] * CM, seg_w / 2)
    cycle_h = p['cycleH'] * CM
    max_cyc = math.floor(H / cycle_h)
    if max_cyc < 1:
        return []
    vis    = p.get('visibleCycles') or 0
    n_cyc  = min(max_cyc, vis) if vis > 0 else max_cyc
    total_h = n_cyc * cycle_h
    k      = (p.get('bunch') or 0) * 5
    cp_x   = (4 / 3) * amp
    N      = 20
    pts    = []

    if p.get('startPhase', 'center') == 'center':
        pts.append((0, 0))
        for c in range(n_cyc):
            d  = 1 if c % 2 == 0 else -1
            y0 = bunch_y(c / n_cyc, k) * total_h
            y1 = bunch_y((c + 1) / n_cyc, k) * total_h
            hv = ((y1 - y0) / 2) * (p.get('sharpness') or 0)
            for s in range(1, N + 1):
                pts.append(cubic_bez(s / N,
                    (0,        y0),
                    (cp_x*d,   y0 + hv),
                    (cp_x*d,   y1 - hv),
                    (0,        y1)))
    else:
        start_x = amp if p.get('startPhase') == 'peak' else -amp
        pts.append((start_x, 0))
        for c in range(n_cyc):
            y0     = bunch_y(c / n_cyc, k) * total_h
            y1     = bunch_y((c + 1) / n_cyc, k) * total_h
            cp_y   = (y1 - y0) / 3
            from_x = start_x if c % 2 == 0 else -start_x
            to_x   = -from_x
            for s in range(1, N + 1):
                pts.append(cubic_bez(s / N,
                    (from_x, y0),
                    (from_x, y0 + cp_y),
                    (to_x,   y1 - cp_y),
                    (to_x,   y1)))
    return pts


def gen_arch(p, seg_w, H, stroke_w_cm):
    half_w  = seg_w / 2
    half_sw = (stroke_w_cm * CM) / 2
    hit_y   = min(p['depth'] * CM, H - 1)
    y_cp    = (p.get('sharpness') or 0) * hit_y
    x_land  = -half_w + half_sw + (p.get('inset') or 0) * CM
    N       = 30
    pts     = []
    for s in range(N + 1):
        pts.append(quad_bez(s / N,
            (half_w, 0),
            (x_land, y_cp),
            (x_land, hit_y)))
    pts.append((x_land, H))
    return pts


def gen_square(p, seg_w, H):
    amp     = min(p['amplitude'] * CM, seg_w / 2)
    cycle_h = p['cycleH'] * CM
    max_cyc = math.floor(H / cycle_h)
    if max_cyc < 1:
        return []
    vis    = p.get('visibleCycles') or 0
    n_cyc  = min(max_cyc, vis) if vis > 0 else max_cyc
    total_h = n_cyc * cycle_h
    k      = (p.get('bunch') or 0) * 5
    K      = 0.5523  # cubic approximation of a quarter-circle
    NA     = 8
    pts    = [(amp, 0)]

    def corner(p0, cp0, cp1, p1):
        for s in range(1, NA + 1):
            pts.append(cubic_bez(s / NA, p0, cp0, cp1, p1))

    for c in range(n_cyc):
        y0     = bunch_y(c / n_cyc, k) * total_h
        y1     = bunch_y((c + 1) / n_cyc, k) * total_h
        y_m    = (y0 + y1) / 2
        half_h = (y1 - y0) / 2
        r      = min((p.get('cornerRadius') or 0) * CM, half_h * 0.45, amp * 0.9)
        last   = (c == n_cyc - 1)

        if r <= 0:
            pts.extend([(amp, y_m), (-amp, y_m), (-amp, y1)])
            if not last:
                pts.append((amp, y1))
        else:
            pts.append((amp, y_m - r))
            corner((amp, y_m - r),       (amp, y_m - r + K*r), (amp - K*r, y_m),    (amp - r, y_m))
            pts.append((-amp + r, y_m))
            corner((-amp + r, y_m),       (-amp + r - K*r, y_m), (-amp, y_m + K*r), (-amp, y_m + r))
            if not last:
                pts.append((-amp, y1 - r))
                corner((-amp, y1 - r),    (-amp, y1 - r + K*r), (-amp + K*r, y1),   (-amp + r, y1))
                pts.append((amp - r, y1))
                corner((amp - r, y1),     (amp - r + K*r, y1),  (amp, y1 + K*r),    (amp, y1 + r))
            else:
                pts.append((-amp, y1))
    return pts


def gen_circle(p, seg_w, H):
    cy     = (p['yPos'] / 100) * H
    r      = p['diameter'] * CM / 2
    half_w = seg_w / 2
    if r <= 0:
        return []

    if r <= half_w:
        N   = 64
        pts = []
        for i in range(N + 1):
            ang = (i / N) * 2 * math.pi
            pts.append((r * math.cos(ang), cy + r * math.sin(ang)))
        return [pts]
    else:
        alpha    = math.acos(half_w / r)
        N        = 40
        top_pts  = []
        bot_pts  = []
        for i in range(N + 1):
            ang = (alpha - math.pi) + (i / N) * (math.pi - 2 * alpha)
            top_pts.append((r * math.cos(ang), cy + r * math.sin(ang)))
        for i in range(N + 1):
            ang = alpha + (i / N) * (math.pi - 2 * alpha)
            bot_pts.append((r * math.cos(ang), cy + r * math.sin(ang)))
        return [top_pts, bot_pts]


# ── Segment stamping ──────────────────────────────────────────────────────────

def stamp_paths(base_paths, layer, W_mm, H_mm, hw):
    n       = layer['segments']
    seg_w   = W_mm / n
    half_seg = seg_w / 2
    bound   = half_seg - hw
    out     = []

    if bound <= 0:
        return out  # lineW wider than segment — nothing to stamp

    for i in range(n):
        cx   = (i + 0.5) * seg_w
        flip = (layer.get('direction') == 'RRRR' or
                (layer.get('direction') == 'LRLR' and i % 2 == 1))
        for base in base_paths:
            stamped = []
            for (x, y) in base:
                x_rel = -x if flip else x
                sx    = cx + max(-bound, min(bound, x_rel))
                sy    = H_mm - y if layer.get('flipV') else y
                stamped.append((sx, sy))
            out.append(stamped)
    return out


# ── Warp ──────────────────────────────────────────────────────────────────────

def apply_warp(paths, W_mm, H_mm, warp_amount):
    A = (warp_amount or 0) * CM
    if not A:
        return paths
    result = []
    for path in paths:
        result.append([
            (x, y + A * math.sin(math.pi * x / W_mm) * (y / H_mm))
            for (x, y) in path
        ])
    return result


# ── Extract paths at interpolation factor t ───────────────────────────────────
# t=0 → back face, t=1 → front face.

def extract_paths_at(t, cfg, layers, app):
    W_mm = app['panelW'] * CM
    H_mm = app['panelH'] * CM
    lw   = cfg['lineW']
    hw   = lw / 2

    border = app.get('border') or {}
    walls  = (border.get('walls') or {}) if app.get('showGrid') else {}

    x_min = lw if walls.get('left')   else hw
    x_max = W_mm - (lw if walls.get('right')  else hw)
    y_min = lw if walls.get('top')    else hw
    y_max = H_mm - (lw if walls.get('bottom') else hw)

    all_paths = []

    # Border walls — added first so they have highest trim priority.
    # Walls are chained in CW order (top→right→bottom→left) so that adjacent
    # enabled walls are combined into a single continuous path, minimising
    # travel moves and retraction events.
    if app.get('showGrid') and border:
        N = 32
        # Each entry: (wall_key, point_list) in CW winding so endpoints connect.
        wall_segs = [
            ('top',    [(0, 0), (W_mm, 0)]),
            ('right',  [(W_mm, 0), (W_mm, H_mm)]),
            ('bottom', [(W_mm * (N - i) / N, H_mm) for i in range(N + 1)]),
            ('left',   [(0, H_mm), (0, 0)]),
        ]

        border_paths = []
        current = []
        for key, pts in wall_segs:
            if walls.get(key):
                if current:
                    current.extend(pts[1:])   # shared corner already in current
                else:
                    current = list(pts)
            else:
                if current:
                    border_paths.append(current)
                    current = []
        if current:
            # If all 4 walls enabled the loop is already closed (left ends at
            # (0,0) == top start), so just append as one continuous path.
            border_paths.append(current)

        all_paths.extend(border_paths)

    for layer in layers:
        if not layer.get('visible', True):
            continue

        p  = layer['params']
        bp = layer.get('backParams') or {}

        # Blend amplitude between back (t=0) and front (t=1) faces.
        blended = p
        if (bp.get('amplitude') is not None and p.get('amplitude') is not None
                and bp['amplitude'] != p['amplitude']):
            blended = dict(p)
            blended['amplitude'] = bp['amplitude'] + (p['amplitude'] - bp['amplitude']) * t

        seg_w = W_mm / layer['segments']
        sw    = (layer.get('style') or {}).get('strokeWidth', 0.3)
        gen   = layer.get('gen', 'straight')

        if   gen == 'straight': base_paths = [gen_straight(blended, seg_w, H_mm)]
        elif gen == 'sine':     base_paths = [gen_sine(blended, seg_w, H_mm)]
        elif gen == 'bezier':   base_paths = [gen_bezier(blended, seg_w, H_mm)]
        elif gen == 'arch':     base_paths = [gen_arch(blended, seg_w, H_mm, sw)]
        elif gen == 'square':   base_paths = [gen_square(blended, seg_w, H_mm)]
        elif gen == 'circle':   base_paths = gen_circle(blended, seg_w, H_mm)
        else:                   base_paths = []

        stamped = stamp_paths(base_paths, layer, W_mm, H_mm, hw)
        for sp in stamped:
            if len(sp) < 2:
                continue
            if lw > 0:
                sp = [
                    (max(x_min, min(x_max, x)), max(y_min, min(y_max, y)))
                    for (x, y) in sp
                ]
            all_paths.append(sp)

    return apply_warp(all_paths, W_mm, H_mm, app.get('warpAmount', 0))


# ── Collision trimming ────────────────────────────────────────────────────────

def trim_overlaps(paths, line_w):
    """
    Process paths in priority order (border walls first, then layers top-to-
    bottom).  Each path has any segments that would overlap an already-
    committed bead removed.

    The exclusion zone around committed paths is buffered by the full line_w
    (not half), because two beads of width line_w don't overlap when their
    centrelines are >= line_w apart.  So the exclusion zone for new centrelines
    is line_w away from committed centrelines.
    """
    if not HAS_SHAPELY:
        return paths

    min_len       = line_w * 0.5   # discard fragments shorter than half a bead
    exclusion     = None           # union of line_w buffers around accepted paths
    result        = []

    for pts in paths:
        if len(pts) < 2:
            continue

        line = LineString(pts)

        if exclusion is None:
            # First path always wins unconditionally.
            result.append(pts)
            exclusion = line.buffer(line_w * 0.95)
            continue

        remaining = line.difference(exclusion)

        if remaining.is_empty:
            continue

        geoms = list(remaining.geoms) if hasattr(remaining, 'geoms') else [remaining]
        for g in geoms:
            sub = list(g.geoms) if hasattr(g, 'geoms') else [g]
            for seg in sub:
                if seg.geom_type != 'LineString':
                    continue
                coords = list(seg.coords)
                if len(coords) < 2 or seg.length < min_len:
                    continue
                result.append(coords)
                # Only the accepted (printed) segment claims new space.
                # Use 0.95 × line_w so paths that merely touch (adjacent beads)
                # are not trimmed — only genuine overlaps are removed.
                exclusion = exclusion.union(LineString(coords).buffer(line_w * 0.95))

    return result


# ── Greedy nearest-endpoint path sort ─────────────────────────────────────────

def sort_paths(paths, start=(0.0, 0.0)):
    if not paths:
        return []
    used   = [False] * len(paths)
    result = []
    cx, cy = start

    for _ in range(len(paths)):
        best_i, best_d, best_rev = -1, float('inf'), False
        for i, path in enumerate(paths):
            if used[i]:
                continue
            sx, sy = path[0]
            ex, ey = path[-1]
            ds = (sx - cx)**2 + (sy - cy)**2
            de = (ex - cx)**2 + (ey - cy)**2
            if ds < best_d:
                best_d, best_i, best_rev = ds, i, False
            if de < best_d:
                best_d, best_i, best_rev = de, i, True
        used[best_i] = True
        pts = list(reversed(paths[best_i])) if best_rev else paths[best_i]
        result.append(pts)
        cx, cy = pts[-1]

    return result


# ── Travel-move routing (prefer on-bead paths) ────────────────────────────────
# "Avoid crossing perimeters" for a partition screen means routing travel moves
# ON TOP OF already-printed beads rather than through open air.  Ooze that
# drops while travelling over an existing bead lands on its top face; ooze
# in open air sticks to the side of the nearest bead — that's the blob problem.
#
# Implementation: weighted A* on a regular grid.
#   • Cells that overlap a printed bead  → cost 1  (preferred highway)
#   • Empty cells                        → cost 1 × PENALTY  (expensive detour)
# A* will route over beads whenever doing so is cheaper than cutting through air.

TRAVEL_PENALTY = 5.0   # how much more expensive open-air travel is vs on-bead

def build_travel_grid(paths, line_w, W_mm, H_mm):
    """
    Rasterise printed beads onto a grid and return
    (printed_set, zone, cols, rows, cell_size).
    printed_set  — (col, row) cells that overlap a bead (low-cost travel).
    zone         — Shapely union used for the fast direct-path check.
    """
    if not HAS_SHAPELY or not paths:
        return set(), None, 0, 0, 1.0

    cell = max(line_w, 3.0)
    cols = int(math.ceil(W_mm / cell)) + 2
    rows = int(math.ceil(H_mm / cell)) + 2

    bufs = [LineString(pts).buffer(line_w * 0.5) for pts in paths if len(pts) >= 2]
    if not bufs:
        return set(), None, cols, rows, cell
    zone = unary_union(bufs)

    printed = set()
    for c in range(cols):
        for r in range(rows):
            if zone.intersects(box(c * cell, r * cell, (c + 1) * cell, (r + 1) * cell)):
                printed.add((c, r))

    return printed, zone, cols, rows, cell


def route_travel(A, B, printed, zone, cols, rows, cell_size):
    """
    Route a travel move from A to B using weighted A*.
    Prefers paths over already-printed beads (cost 1) over open air
    (cost TRAVEL_PENALTY) so ooze lands on bead tops, not on sides.
    Falls back to direct travel when no routing is needed or grid is absent.
    """
    if not HAS_SHAPELY or zone is None:
        return [A, B]

    direct = LineString([A, B])
    if not direct.crosses(zone):
        return [A, B]   # direct path stays within or outside printed zone — OK

    def to_grid(pt):
        return (max(0, min(cols - 1, int(pt[0] / cell_size))),
                max(0, min(rows - 1, int(pt[1] / cell_size))))

    def to_world(c, r):
        return (c * cell_size + cell_size * 0.5, r * cell_size + cell_size * 0.5)

    ga, gb = to_grid(A), to_grid(B)
    if ga == gb:
        return [A, B]

    # Weighted A* — every cell is reachable; cost depends on whether it's printed.
    INF = float('inf')
    g_score  = {ga: 0.0}
    came_from = {}
    open_set  = [(math.hypot(gb[0] - ga[0], gb[1] - ga[1]), ga)]

    while open_set:
        _, cur = heapq.heappop(open_set)
        if cur == gb:
            break
        cur_g = g_score.get(cur, INF)
        for dc in (-1, 0, 1):
            for dr in (-1, 0, 1):
                if dc == 0 and dr == 0:
                    continue
                nb = (cur[0] + dc, cur[1] + dr)
                if not (0 <= nb[0] < cols and 0 <= nb[1] < rows):
                    continue
                step = math.hypot(dc, dr)
                # Penalise moving INTO an empty (non-printed) cell.
                if nb not in printed:
                    step *= TRAVEL_PENALTY
                ng = cur_g + step
                if ng < g_score.get(nb, INF):
                    g_score[nb]  = ng
                    came_from[nb] = cur
                    h = math.hypot(gb[0] - nb[0], gb[1] - nb[1])
                    heapq.heappush(open_set, (ng + h, nb))

    if gb not in came_from and ga != gb:
        return [A, B]

    grid_path, cur = [], gb
    while cur != ga:
        grid_path.append(cur)
        cur = came_from.get(cur)
        if cur is None:
            return [A, B]
    grid_path.append(ga)
    grid_path.reverse()

    # Convert grid path → world coords, keeping only direction-change waypoints.
    world_path = [A]
    for i in range(1, len(grid_path) - 1):
        p, n = grid_path[i - 1], grid_path[i + 1]
        if (grid_path[i][0] - p[0], grid_path[i][1] - p[1]) != \
           (n[0] - grid_path[i][0], n[1] - grid_path[i][1]):
            world_path.append(to_world(*grid_path[i]))
    world_path.append(B)
    return world_path


# ── G-code builder ────────────────────────────────────────────────────────────

def build_gcode(cfg, layers, app):
    W_mm       = app['panelW'] * CM
    H_mm       = app['panelH'] * CM
    num_layers = max(1, round(cfg['depth'] / cfg['layerH']))
    e_rate     = cfg['feedRate']
    retract    = cfg['retract']

    def f3(v):        return f'{v:.3f}'
    def fmm(v):       return str(round(v * 60))   # mm/s → mm/min

    out = [
        '; ================================================',
        '; Partition Screen — GCode  [Python fabricator]',
        f'; Panel {app["panelW"]}×{app["panelH"]} cm   Depth {cfg["depth"]} mm',
        f'; {num_layers} layers × {cfg["layerH"]} mm',
        f'; Line {cfg["lineW"]} mm   Feed rate {e_rate} E/mm',
        f'; Nozzle {cfg["nozzleT"]} °C   Bed {cfg["bedT"]} °C',
        f'; Print {cfg["printV"]} mm/s   Travel {cfg["travelV"]} mm/s',
        f'; Retract {retract} mm',
        f'; Overlap trimming: {"ON (shapely)" if HAS_SHAPELY else "OFF — pip install shapely"}',
        '; ================================================',
        '',
    ]

    start_g = (cfg.get('startG') or '').strip()
    if start_g:
        out += [start_g, '']
    else:
        out += [
            f'M104 S{cfg["nozzleT"]}',
            f'M140 S{cfg["bedT"]}',
            f'M109 S{cfg["nozzleT"]}',
            f'M190 S{cfg["bedT"]}',
            'G28',
            'G90',    # absolute XYZ
            'M83',    # relative extrusion
            'G92 E0',
            '',
        ]

    # When warp bows the bottom edge downward it can push Y below 0 in G-code
    # coordinates (gy = H_mm - y becomes negative when y > H_mm).  Shift the
    # entire print up by the maximum warp extent so the lowest point stays at 0.
    A_warp     = (app.get('warpAmount', 0) or 0) * CM
    y_offset   = max(0.0, A_warp)

    out.append(f'G0 F{fmm(cfg["travelV"])} Z{f3(cfg["layerH"])}')
    out.append('')

    # Carry the head's XY position between layers so sort_paths begins from
    # wherever the nozzle actually is, rather than always (0, 0).
    sort_start = (0.0, 0.0)

    for layer_idx in range(num_layers):
        t      = 1.0 if num_layers <= 1 else layer_idx / (num_layers - 1)
        paths  = extract_paths_at(t, cfg, layers, app)
        paths  = trim_overlaps(paths, cfg['lineW'])
        sorted_paths = sort_paths(paths, sort_start)

        # Build printed-bead grid + zone once per layer (reused for every travel move).
        printed, printed_zone, grid_cols, grid_rows, cell_size = \
            build_travel_grid(paths, cfg['lineW'], W_mm, H_mm)

        z = f3((layer_idx + 1) * cfg['layerH'])
        out += [';LAYER_CHANGE', f';Z:{z}', 'G92 E0',
                f'G1 Z{z} F{fmm(min(cfg["printV"], 10))}']

        cx, cy  = sort_start
        primed  = False

        for pts in sorted_paths:
            if not pts:
                continue
            x0, y0 = pts[0]
            gy0    = H_mm - y0 + y_offset

            if primed and retract > 0:
                out.append(f'G1 E-{f3(retract)} F{fmm(cfg["travelV"])}')

            # Route travel so it avoids crossing bead sides.
            travel_pts = route_travel((cx, cy), (x0, y0),
                                      printed, printed_zone,
                                      grid_cols, grid_rows, cell_size)
            if len(travel_pts) > 2:
                # Intermediate waypoints (first is current pos, last is x0/y0).
                for wx, wy in travel_pts[1:-1]:
                    gwy = H_mm - wy + y_offset
                    out.append(f'G0 F{fmm(cfg["travelV"])} X{f3(wx)} Y{f3(gwy)}')
            out.append(f'G0 F{fmm(cfg["travelV"])} X{f3(x0)} Y{f3(gy0)}')

            if retract > 0:
                out.append(f'G1 E{f3(retract)} F{fmm(cfg["travelV"])}')
            primed = True

            cx, cy = x0, y0
            for i, (px, py) in enumerate(pts[1:], 1):
                gy = H_mm - py + y_offset
                dx = px - cx
                dy = gy - (H_mm - cy + y_offset)
                de = math.sqrt(dx*dx + dy*dy) * e_rate
                if i == 1:
                    out.append(f'G1 F{fmm(cfg["printV"])} X{f3(px)} Y{f3(gy)} E{f3(de)}')
                else:
                    out.append(f'G1 X{f3(px)} Y{f3(gy)} E{f3(de)}')
                cx, cy = px, py

        # Update start position for next layer's path sort.
        sort_start = (cx, cy)

        out.append('')

    end_g = (cfg.get('endG') or '').strip()
    if end_g:
        out.append(end_g)
    else:
        out += ['M104 S0', 'M140 S0', 'G28 X Y', 'M84']

    return '\n'.join(out)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print('Usage: python fabricate.py design.json [output.gcode]')
        print()
        print('design.json is saved from the designer using the JSON button.')
        sys.exit(1)

    design_path = Path(sys.argv[1])
    out_path    = Path(sys.argv[2]) if len(sys.argv) > 2 else design_path.with_suffix('.gcode')

    print(f'Reading {design_path} …')
    with open(design_path) as f:
        design = json.load(f)

    app    = design['app']
    layers = design['layers']
    cfg    = design['cfg']

    if not HAS_SHAPELY:
        print('WARNING: shapely not installed — overlap trimming disabled.')
        print('         Run:  pip install shapely')

    print(f'Generating G-code  ({max(1, round(cfg["depth"] / cfg["layerH"]))} layers) …')
    gcode = build_gcode(cfg, layers, app)

    with open(out_path, 'w') as f:
        f.write(gcode)

    print(f'Done → {out_path}')


if __name__ == '__main__':
    main()
