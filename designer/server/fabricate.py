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
    from shapely.geometry import LineString, MultiLineString
    from shapely.ops import unary_union, nearest_points as shp_nearest_pts
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


# ── Travel routing via existing path curves ───────────────────────────────────
#
# Every vertex of every printed path becomes a graph node.  Edges:
#
#   along-path  — adjacent vertices on the same path (both directions),
#                 cost = arc length.  Traversal follows exact printed coords.
#
#   tiny hop    — between nodes on different paths that are ≤ line_w×_HOP_FACTOR
#                 apart AND whose connecting segment does NOT cross the printed
#                 zone; cost = distance × _TRAVEL_PENALTY.
#
# There are NO free-space edges beyond line_w×_HOP_FACTOR.  Any longer gap
# must be bridged by boarding a printed path and following its coordinates.
# The same path may be traversed multiple times; that is fine and desirable.

_TRAVEL_PENALTY = 5.0   # cost multiplier for tiny hops vs on-bead travel
_K_NEAR         = 20    # nearest candidates checked when connecting A/B
_HOP_FACTOR     = 3.0   # max hop distance = line_w × this


def build_path_graph(paths, line_w):
    """
    Build the travel graph for one layer.
    Returns (nodes, adj, zone):
      nodes — list of (x, y) tuples, one per path vertex + transit nodes
      adj   — list of edge lists; each edge is (cost, neighbor_idx)
      zone  — Shapely union of path buffers

    Graph edges:
      on-bead   — consecutive vertices along each path; cost = arc length × 1.
      transit   — intermediate nodes inserted at the closest approach between
                  any two non-adjacent segments that come within line_w × 2.
                  Each transit node is connected along its parent segment
                  (on-bead cost) and across to the opposite transit node
                  (cost = gap × _TRAVEL_PENALTY).
      tiny-hop  — any two nodes within line_w × _HOP_FACTOR of each other
                  get a direct air-hop edge; cost = distance × _TRAVEL_PENALTY.
    """
    if not HAS_SHAPELY or not paths:
        return [], [], None

    valid = [p for p in paths if len(p) >= 2]
    if not valid:
        return [], [], None

    bufs = [LineString(p).buffer(line_w * 0.5) for p in valid]
    zone = unary_union(bufs)

    max_hop = line_w * _HOP_FACTOR
    nodes: list = []
    adj:   list = []

    # ── Phase 1: vertex nodes + along-path edges ──────────────────────────────
    seg_list = []  # (node_idx_start, node_idx_end) for each segment

    for pts in valid:
        base = len(nodes)
        for pt in pts:
            nodes.append(tuple(pt))
            adj.append([])
        for i in range(base, len(nodes) - 1):
            d = math.hypot(nodes[i+1][0] - nodes[i][0],
                           nodes[i+1][1] - nodes[i][1])
            if d > 0:
                adj[i    ].append((d, i + 1))
                adj[i + 1].append((d, i))
                seg_list.append((i, i + 1))

    # ── Phase 2: transit nodes at segment-to-segment closest approaches ────────
    # When two non-adjacent segments come within line_w × 2 of each other,
    # inject a node at the closest point on each and connect them.
    transit_thresh = line_w * 2.0
    snap_eps       = line_w * 0.05  # don't add a node if it's basically an endpoint

    for si in range(len(seg_list)):
        na, nb = seg_list[si]
        pa1, pa2 = nodes[na], nodes[nb]
        ls_a = LineString([pa1, pa2])
        xa1, ya1 = pa1;  xa2, ya2 = pa2
        bb_ax1 = min(xa1, xa2) - transit_thresh
        bb_ax2 = max(xa1, xa2) + transit_thresh
        bb_ay1 = min(ya1, ya2) - transit_thresh
        bb_ay2 = max(ya1, ya2) + transit_thresh

        for sj in range(si + 1, len(seg_list)):
            nc, nd = seg_list[sj]
            # Skip segments that share an endpoint with si
            if na in (nc, nd) or nb in (nc, nd):
                continue
            pb1, pb2 = nodes[nc], nodes[nd]
            xb1, yb1 = pb1;  xb2, yb2 = pb2
            # Bounding-box pre-filter
            if (max(xb1, xb2) < bb_ax1 or min(xb1, xb2) > bb_ax2 or
                    max(yb1, yb2) < bb_ay1 or min(yb1, yb2) > bb_ay2):
                continue
            ls_b = LineString([pb1, pb2])
            if ls_a.distance(ls_b) > transit_thresh:
                continue

            # Find exact closest points on each segment
            pt_a_shp, pt_b_shp = shp_nearest_pts(ls_a, ls_b)
            pta = (pt_a_shp.x, pt_a_shp.y)
            ptb = (pt_b_shp.x, pt_b_shp.y)

            # Transit node on segment si — skip if within snap_eps of an endpoint
            da1 = math.hypot(pta[0] - pa1[0], pta[1] - pa1[1])
            da2 = math.hypot(pta[0] - pa2[0], pta[1] - pa2[1])
            if da1 <= snap_eps:
                ta = na
            elif da2 <= snap_eps:
                ta = nb
            else:
                ta = len(nodes)
                nodes.append(pta);  adj.append([])
                adj[ta].append((da1, na));  adj[na].append((da1, ta))
                adj[ta].append((da2, nb));  adj[nb].append((da2, ta))

            # Transit node on segment sj
            db1 = math.hypot(ptb[0] - pb1[0], ptb[1] - pb1[1])
            db2 = math.hypot(ptb[0] - pb2[0], ptb[1] - pb2[1])
            if db1 <= snap_eps:
                tb = nc
            elif db2 <= snap_eps:
                tb = nd
            else:
                tb = len(nodes)
                nodes.append(ptb);  adj.append([])
                adj[tb].append((db1, nc));  adj[nc].append((db1, tb))
                adj[tb].append((db2, nd));  adj[nd].append((db2, tb))

            # Air-hop edge between the two transit nodes
            hop_d = math.hypot(pta[0] - ptb[0], pta[1] - ptb[1])
            if hop_d > 0:
                c = hop_d * _TRAVEL_PENALTY
                adj[ta].append((c, tb))
                adj[tb].append((c, ta))

    # ── Phase 3: tiny-hop edges between all nearby nodes ──────────────────────
    # Includes transit nodes added above.
    cell = max(max_hop, 1.0)
    grid: dict = {}
    for i, (x, y) in enumerate(nodes):
        grid.setdefault((int(x / cell), int(y / cell)), []).append(i)

    for i, (xi, yi) in enumerate(nodes):
        gx, gy = int(xi / cell), int(yi / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), []):
                    if j <= i:
                        continue
                    xj, yj = nodes[j]
                    d = math.hypot(xj - xi, yj - yi)
                    if 0 < d <= max_hop:
                        c = d * _TRAVEL_PENALTY
                        adj[i].append((c, j))
                        adj[j].append((c, i))

    return nodes, adj, zone


def route_travel(A, B, base_nodes, base_adj, zone, line_w):
    """
    Route a travel move from A to B.
    Travel strictly follows printed path coordinates; only tiny open-air
    hops ≤ line_w × _HOP_FACTOR are permitted between different paths.
    """
    max_hop  = line_w * _HOP_FACTOR
    d_direct = math.hypot(B[0] - A[0], B[1] - A[1])

    # Short hops always allowed — user explicitly permits ≤ line_w × _HOP_FACTOR
    if d_direct <= max_hop:
        return [A, B]

    if not HAS_SHAPELY or zone is None or not base_nodes:
        return [A, B]

    # Prepend A (idx 0) and B (idx 1); base_nodes shift by OFF=2
    OFF       = 2
    all_nodes = [A, B] + base_nodes
    n         = len(all_nodes)
    all_adj   = [[] for _ in range(n)]

    for i, edges in enumerate(base_adj):
        for cost, j in edges:
            all_adj[i + OFF].append((cost, j + OFF))

    # Connect A and B to all graph nodes within max_hop (no crossing check)
    for u_idx, u_pt in ((0, A), (1, B)):
        ranked = sorted(
            (math.hypot(base_nodes[v][0] - u_pt[0],
                        base_nodes[v][1] - u_pt[1]), v)
            for v in range(len(base_nodes))
        )
        for d, v in ranked[:_K_NEAR]:
            if d > max_hop:
                break
            c = d * _TRAVEL_PENALTY
            all_adj[u_idx    ].append((c, v + OFF))
            all_adj[v + OFF  ].append((c, u_idx))

    # Very expensive direct fallback (last resort, avoids hard failure)
    all_adj[0].append((d_direct * _TRAVEL_PENALTY * 50, 1))

    # Dijkstra from A (0) to B (1)
    INF  = float('inf')
    dist = [INF] * n
    prev = [-1]  * n
    dist[0] = 0.0
    pq = [(0.0, 0)]

    while pq:
        d, u = heapq.heappop(pq)
        if u == 1:
            break
        if d > dist[u]:
            continue
        for cost, v in all_adj[u]:
            nd = d + cost
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if dist[1] >= INF:
        return [A, B]

    # Reconstruct path as coordinate list
    idx_path = []
    cur = 1
    while cur != 0:
        idx_path.append(cur)
        cur = prev[cur]
        if cur == -1:
            return [A, B]
    idx_path.append(0)
    idx_path.reverse()
    return [all_nodes[i] for i in idx_path]



# ── Graph-aware greedy layer planner ─────────────────────────────────────────

def plan_layer(paths, nodes, adj, line_w, start):
    """
    Order paths and choose their print direction using actual routed travel
    cost — not straight-line Euclidean distance.

    At each step a single-source Dijkstra is run from the current head
    position using the pre-built path graph.  The unused path whose nearer
    endpoint has the lowest true travel cost is selected next, and the path
    is reversed if the endpoint is its last vertex.

    Falls back to Euclidean greedy (sort_paths) when no graph is available.
    """
    if not paths:
        return []
    if not nodes:
        return sort_paths(paths, start)

    max_hop = line_w * _HOP_FACTOR

    # Fast endpoint lookup: coordinate → list of node indices
    pt_nodes: dict = {}
    for idx, pt in enumerate(nodes):
        pt_nodes.setdefault(pt, []).append(idx)

    used   = [False] * len(paths)
    result = []
    cur    = tuple(start)

    for _ in range(len(paths)):
        # ── Single-source Dijkstra from cur ──────────────────────────────────
        # Seed from every graph node reachable within max_hop.
        # If cur is itself a graph node its hop distance is 0, so it seeds
        # with cost 0 — equivalent to a standard Dijkstra from that node.
        INF  = float('inf')
        dist = [INF] * len(nodes)
        pq   = []

        ranked = sorted(
            (math.hypot(nodes[v][0] - cur[0], nodes[v][1] - cur[1]), v)
            for v in range(len(nodes))
        )
        for d_hop, v in ranked[:_K_NEAR]:
            if d_hop > max_hop:
                break
            seed = d_hop * _TRAVEL_PENALTY
            if seed < dist[v]:
                dist[v] = seed
                heapq.heappush(pq, (seed, v))

        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for cost, v in adj[u]:
                nd = d + cost
                if nd < dist[v]:
                    dist[v] = nd
                    heapq.heappush(pq, (nd, v))

        # ── Pick cheapest unused path + direction ─────────────────────────────
        best_cost = INF
        best_i    = -1
        best_rev  = False

        for i, pts in enumerate(paths):
            if used[i]:
                continue
            cs = min((dist[idx] for idx in pt_nodes.get(tuple(pts[0]),  [])), default=INF)
            ce = min((dist[idx] for idx in pt_nodes.get(tuple(pts[-1]), [])), default=INF)
            if cs < best_cost:
                best_cost, best_i, best_rev = cs, i, False
            if ce < best_cost:
                best_cost, best_i, best_rev = ce, i, True

        if best_i == -1:
            # Fallback: Euclidean nearest among remaining paths
            for i, pts in enumerate(paths):
                if used[i]:
                    continue
                for rev, ep in ((False, tuple(pts[0])), (True, tuple(pts[-1]))):
                    d = math.hypot(ep[0] - cur[0], ep[1] - cur[1])
                    if d < best_cost:
                        best_cost, best_i, best_rev = d, i, rev

        used[best_i] = True
        pts = list(reversed(paths[best_i])) if best_rev else list(paths[best_i])
        result.append(pts)
        cur = tuple(pts[-1])

    return result


# ── G-code builder ────────────────────────────────────────────────────────────

def _split_into_edges(paths):
    """
    Decompose every path into its individual print edges (consecutive vertex
    pairs).  Each edge becomes an independent planning atom so the layer
    planner can interleave or split paths freely to minimise total travel.
    Consecutive edges of the same path still cost 0 to chain (they share an
    endpoint node), so they will naturally run together unless a cheaper
    ordering exists.
    """
    edges = []
    for pts in paths:
        for i in range(len(pts) - 1):
            edges.append([tuple(pts[i]), tuple(pts[i + 1])])
    return edges

def build_gcode(cfg, layers, app):
    W_mm       = app['panelW'] * CM
    H_mm       = app['panelH'] * CM
    num_layers = max(1, round(cfg['depth'] / cfg['layerH']))
    e_rate      = cfg['feedRate']
    retract     = cfg['retract']
    retract_v   = cfg.get('retractV',  45.0)   # retract/de-retract speed mm/s
    extra_prime = cfg.get('extraPrime', 0.0)    # extra filament after de-retract
    no_retract_d = cfg.get('noRetractD', cfg['lineW'] * 4.0)  # min travel to retract

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
        f'; Retract {retract} mm @ {retract_v} mm/s   Extra prime {extra_prime} mm   No-retract below {no_retract_d} mm',
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

    # Initial head position in path-space coordinates.
    # Machine home (G-code X=0 Y=0) maps to path (0, H_mm): left edge,
    # bottom of panel (gy = H_mm - H_mm + y_offset = y_offset ≈ 0).
    sort_start = (0.0, H_mm)

    for layer_idx in range(num_layers):
        t      = 1.0 if num_layers <= 1 else layer_idx / (num_layers - 1)
        paths  = extract_paths_at(t, cfg, layers, app)
        paths  = trim_overlaps(paths, cfg['lineW'])

        # Build graph from full paths (every vertex is a node).
        graph_nodes, graph_adj, printed_zone = \
            build_path_graph(paths, cfg['lineW'])

        # Decompose every path into individual print edges, then sequence
        # them using actual routed cost.  Consecutive edges of the same path
        # share an endpoint (cost 0 to continue), so they run together
        # naturally unless splitting / interleaving gives a shorter total.
        print_edges   = _split_into_edges(paths)
        sorted_paths  = plan_layer(print_edges, graph_nodes, graph_adj,
                                   cfg['lineW'], sort_start)

        z = f3((layer_idx + 1) * cfg['layerH'])
        out += [';LAYER_CHANGE', f';Z:{z}', 'G92 E0',
                f'G1 Z{z} F{fmm(min(cfg["printV"], 10))}']

        cx, cy  = sort_start
        primed  = False

        for pts in sorted_paths:
            if not pts:
                continue
            x0, y0      = pts[0]
            gy0         = H_mm - y0 + y_offset
            travel_dist = math.hypot(x0 - cx, y0 - cy)
            do_travel   = travel_dist > 1e-6

            if not primed:
                # Always G0 to first print position before any extrusion,
                # even if the distance is zero (head hasn't moved since G28).
                out.append(f'G0 F{fmm(cfg["travelV"])} X{f3(x0)} Y{f3(gy0)}')
            elif do_travel:
                # Skip retraction for hops shorter than no_retract_d.
                did_retract = False
                if travel_dist > no_retract_d and retract > 0:
                    out.append(f'G1 E-{f3(retract)} F{fmm(retract_v)}')
                    did_retract = True

                # Route travel so it stays on already-printed beads.
                travel_pts = route_travel((cx, cy), (x0, y0),
                                          graph_nodes, graph_adj, printed_zone,
                                          cfg['lineW'])
                if len(travel_pts) > 2:
                    for wx, wy in travel_pts[1:-1]:
                        gwy = H_mm - wy + y_offset
                        out.append(f'G0 F{fmm(cfg["travelV"])} X{f3(wx)} Y{f3(gwy)}')
                out.append(f'G0 F{fmm(cfg["travelV"])} X{f3(x0)} Y{f3(gy0)}')

                # De-retract and optional extra prime.
                if did_retract:
                    out.append(f'G1 E{f3(retract)} F{fmm(retract_v)}')
                    if extra_prime > 0:
                        out.append(f'G1 E{f3(extra_prime)} F{fmm(cfg["printV"])}')

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
