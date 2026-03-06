/**
 * main.js – Application entry point
 *
 * Wires together: state ↔ renderer ↔ UI
 */

import {
  getState, subscribe,
  setCanvas, setZoom, setShowGrid,
  addLayer, toJSON, fromJSON,
} from './state.js';

import {
  initRenderer, resizeCanvas, applyZoom,
  redraw, redrawLayer, updateLayerVisibility,
  exportSVG,
} from './renderer.js';

import { buildGeneratorPicker, renderLayerList } from './ui.js';

// ── DOM refs ──────────────────────────────────────────────────────────────
const canvasEl      = document.getElementById('main-canvas');
const canvasInner   = document.getElementById('canvas-inner');
const layersList    = document.getElementById('layers-list');
const pickerEl      = document.getElementById('generator-picker');
const addBtn        = document.getElementById('add-layer-btn');
const canvasWInput  = document.getElementById('canvas-w');
const canvasHInput  = document.getElementById('canvas-h');
const zoomSlider    = document.getElementById('zoom-slider');
const zoomLabel     = document.getElementById('zoom-label');
const showGridCb    = document.getElementById('show-grid');
const btnExportSVG  = document.getElementById('btn-export-svg');
const btnSaveJSON   = document.getElementById('btn-save-json');
const fileLoadJSON  = document.getElementById('file-load-json');

// ── Init ──────────────────────────────────────────────────────────────────
initRenderer(canvasEl);
buildGeneratorPicker(pickerEl, type => {
  addLayer(type);
  pickerEl.classList.add('hidden');
});

// Apply initial canvas size
const s = getState();
resizeCanvas(s.canvasW, s.canvasH);
applyZoom(s.zoom, canvasInner);
canvasWInput.value = s.canvasW;
canvasHInput.value = s.canvasH;

// ── State subscriber ──────────────────────────────────────────────────────
// changedKey tells us what changed so we can do targeted redraws
subscribe((appState, changedKey) => {
  if (changedKey === 'zoom') {
    applyZoom(appState.zoom, canvasInner);
    return;
  }
  if (changedKey === 'canvas') {
    resizeCanvas(appState.canvasW, appState.canvasH);
    redraw(appState);
    renderLayerList(layersList, appState, id => scheduleRedrawLayer(appState, id));
    return;
  }
  if (changedKey === 'layers' || changedKey === 'full' || changedKey === 'grid') {
    redraw(appState);
    renderLayerList(layersList, appState, id => scheduleRedrawLayer(appState, id));
    return;
  }
  // 'param' – individual param changed; do targeted layer redraw
  // (handled by scheduleRedrawLayer directly)
});

// ── Debounced layer redraw ────────────────────────────────────────────────
const _timers = new Map();
function scheduleRedrawLayer(appState, layerId) {
  if (_timers.has(layerId)) clearTimeout(_timers.get(layerId));
  _timers.set(layerId, setTimeout(() => {
    _timers.delete(layerId);
    redrawLayer(getState(), layerId);
  }, 16));  // ≈60 fps cap
}

// ── Add layer button / picker ─────────────────────────────────────────────
addBtn.addEventListener('click', e => {
  e.stopPropagation();
  pickerEl.classList.toggle('hidden');
});

document.addEventListener('click', () => {
  pickerEl.classList.add('hidden');
});

pickerEl.addEventListener('click', e => e.stopPropagation());

// ── Canvas size ───────────────────────────────────────────────────────────
function onCanvasResize() {
  const w = Math.max(100, parseInt(canvasWInput.value) || 600);
  const h = Math.max(100, parseInt(canvasHInput.value) || 900);
  setCanvas(w, h);
}
canvasWInput.addEventListener('change', onCanvasResize);
canvasHInput.addEventListener('change', onCanvasResize);

// ── Zoom ──────────────────────────────────────────────────────────────────
zoomSlider.addEventListener('input', () => {
  const z = parseInt(zoomSlider.value);
  zoomLabel.textContent = `${z}%`;
  setZoom(z);
});

// ── Grid ──────────────────────────────────────────────────────────────────
showGridCb.addEventListener('change', () => {
  setShowGrid(showGridCb.checked);
});

// ── Export SVG ────────────────────────────────────────────────────────────
btnExportSVG.addEventListener('click', () => {
  const st  = getState();
  const svg = exportSVG(st.canvasW, st.canvasH);
  downloadText('partition-screen.svg', svg, 'image/svg+xml');
});

// ── Save JSON ─────────────────────────────────────────────────────────────
btnSaveJSON.addEventListener('click', () => {
  downloadText('partition-screen.json', toJSON(), 'application/json');
});

// ── Load JSON ─────────────────────────────────────────────────────────────
fileLoadJSON.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      fromJSON(ev.target.result);
      canvasWInput.value = getState().canvasW;
      canvasHInput.value = getState().canvasH;
    } catch (err) {
      alert(`Could not load file: ${err.message}`);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // allow reloading same file
});

// ── Utility ───────────────────────────────────────────────────────────────
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Ctrl/Cmd + S → save JSON
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    btnSaveJSON.click();
  }
  // Ctrl/Cmd + E → export SVG
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    btnExportSVG.click();
  }
});
