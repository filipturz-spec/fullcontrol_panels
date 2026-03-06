/**
 * Renderer
 *
 * Owns the Paper.js project. Re-draws the canvas whenever state changes.
 * Each layer maps to a Paper.js Layer so visibility is trivially toggled.
 */

import { generateDiamond    } from './generators/diamond.js';
import { generateZigzag     } from './generators/zigzag.js';
import { generateLadder     } from './generators/ladder.js';
import { generateRoundedRect} from './generators/roundedRect.js';

const GENERATE_FN = {
  diamond:     generateDiamond,
  zigzag:      generateZigzag,
  ladder:      generateLadder,
  roundedRect: generateRoundedRect,
};

// Map: layerId → Paper.js Layer
const _paperLayers = new Map();
let   _gridLayer   = null;
let   _W = 600, _H = 900;

export function initRenderer(canvasEl) {
  // paper is loaded as a global from the CDN script tag
  paper.setup(canvasEl);
  paper.view.autoUpdate = true;
}

// ── Resize canvas ─────────────────────────────────────────────────────────
export function resizeCanvas(w, h) {
  _W = w; _H = h;
  const canvas = paper.view.element;
  canvas.width  = w;
  canvas.height = h;
  paper.view.viewSize = new paper.Size(w, h);
}

// ── Apply zoom via CSS transform (no Paper.js zoom – keeps coords clean) ──
export function applyZoom(zoom, canvasInnerEl) {
  const scale = zoom / 100;
  canvasInnerEl.style.transform       = `scale(${scale})`;
  canvasInnerEl.style.transformOrigin = 'top left';
  canvasInnerEl.style.width  = `${_W}px`;
  canvasInnerEl.style.height = `${_H}px`;

  // Make the scroll container see the scaled size
  const wrap = canvasInnerEl.parentElement;
  wrap.style.setProperty('--scaled-w', `${_W * scale}px`);
  wrap.style.setProperty('--scaled-h', `${_H * scale}px`);
}

// ── Draw a single layer ───────────────────────────────────────────────────
function drawLayer(layerState) {
  const fn = GENERATE_FN[layerState.type];
  if (!fn) return null;

  const group = fn(layerState.params, _W, _H, paper);
  return group;
}

// ── Full redraw ───────────────────────────────────────────────────────────
export function redraw(appState) {
  paper.project.clear();
  _paperLayers.clear();
  _gridLayer = null;

  // Grid layer (background)
  if (appState.showGrid) {
    _gridLayer = new paper.Layer();
    _gridLayer.activate();
    drawGrid(_W, _H);
  }

  // One Paper.js Layer per app layer (bottom → top order)
  for (const layerState of appState.layers) {
    const pl = new paper.Layer();
    pl.activate();
    pl.visible = layerState.visible;
    const group = drawLayer(layerState);
    if (group) pl.addChild(group);
    _paperLayers.set(layerState.id, pl);
  }

  paper.view.update();
}

// ── Incremental updates ───────────────────────────────────────────────────
export function updateLayerVisibility(id, visible) {
  const pl = _paperLayers.get(id);
  if (pl) { pl.visible = visible; paper.view.update(); }
}

export function redrawLayer(appState, id) {
  const layerState = appState.layers.find(l => l.id === id);
  const pl         = _paperLayers.get(id);
  if (!layerState || !pl) { redraw(appState); return; }

  const wasActive = paper.project.activeLayer;
  pl.activate();
  pl.removeChildren();
  const group = drawLayer(layerState);
  if (group) pl.addChild(group);
  wasActive && wasActive.activate();
  paper.view.update();
}

// ── Grid overlay ──────────────────────────────────────────────────────────
function drawGrid(W, H) {
  const step = 50;
  const style = { strokeColor: 'rgba(0,0,0,0.08)', strokeWidth: 1 };

  for (let x = 0; x <= W; x += step) {
    const p = new paper.Path(style);
    p.add(new paper.Point(x, 0), new paper.Point(x, H));
  }
  for (let y = 0; y <= H; y += step) {
    const p = new paper.Path(style);
    p.add(new paper.Point(0, y), new paper.Point(W, y));
  }

  // Origin cross
  const cross = new paper.Path({ strokeColor: 'rgba(0,0,0,0.2)', strokeWidth: 1 });
  cross.add(new paper.Point(0, 0), new paper.Point(W, H));
}

// ── SVG Export ────────────────────────────────────────────────────────────
export function exportSVG(W, H) {
  const svg = paper.project.exportSVG({
    asString: true,
    bounds:   'view',
  });

  // Ensure explicit width/height in the SVG header
  const sized = svg.replace(
    /(<svg[^>]*?)>/,
    `$1 width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`
  );
  return sized;
}
