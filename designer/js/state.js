/**
 * Application State
 *
 * A single reactive store. Subscribers are called whenever state changes.
 * We keep it intentionally simple – no framework needed.
 */

import { GENERATORS } from './generators/registry.js';

let _uid = 1;
function uid() { return _uid++; }

function defaultLayer(type) {
  const gen  = GENERATORS[type];
  const defs = gen.defaults;
  return {
    id:      uid(),
    type,
    name:    `${gen.label} ${_uid - 1}`,
    visible: true,
    params:  structuredClone(defs),
  };
}

// ── State object ──────────────────────────────────────────────────────────
const state = {
  canvasW:  600,
  canvasH:  900,
  zoom:     80,
  showGrid: false,
  layers:   [],   // ordered list of layer objects
};

// ── Subscribers ───────────────────────────────────────────────────────────
const _subs = new Set();

export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function notify(changedKey) {
  _subs.forEach(fn => fn(state, changedKey));
}

// ── Getters ───────────────────────────────────────────────────────────────
export function getState() { return state; }

export function getLayer(id) {
  return state.layers.find(l => l.id === id) ?? null;
}

// ── Mutations ─────────────────────────────────────────────────────────────
export function setCanvas(w, h) {
  state.canvasW = w;
  state.canvasH = h;
  notify('canvas');
}

export function setZoom(z) {
  state.zoom = z;
  notify('zoom');
}

export function setShowGrid(v) {
  state.showGrid = v;
  notify('grid');
}

export function addLayer(type) {
  const layer = defaultLayer(type);
  state.layers.push(layer);
  notify('layers');
  return layer;
}

export function removeLayer(id) {
  const idx = state.layers.findIndex(l => l.id === id);
  if (idx !== -1) { state.layers.splice(idx, 1); notify('layers'); }
}

export function toggleVisible(id) {
  const l = getLayer(id);
  if (l) { l.visible = !l.visible; notify('layers'); }
}

export function setParam(id, key, value) {
  const l = getLayer(id);
  if (!l) return;
  l.params[key] = value;
  notify('param');
}

export function setZoneParam(id, zoneIndex, key, value) {
  const l = getLayer(id);
  if (!l || !l.params.zones) return;
  l.params.zones[zoneIndex][key] = value;
  notify('param');
}

export function addZone(id) {
  const l = getLayer(id);
  if (!l || !l.params.zones) return;
  l.params.zones.push({ heightFrac: 0.1, rungs: 3 });
  notify('param');
}

export function removeZone(id, idx) {
  const l = getLayer(id);
  if (!l || !l.params.zones || l.params.zones.length <= 1) return;
  l.params.zones.splice(idx, 1);
  notify('param');
}

// ── Serialisation ─────────────────────────────────────────────────────────
export function toJSON() {
  return JSON.stringify({
    canvasW: state.canvasW,
    canvasH: state.canvasH,
    layers:  state.layers,
  }, null, 2);
}

export function fromJSON(json) {
  const data = JSON.parse(json);
  state.canvasW = data.canvasW ?? state.canvasW;
  state.canvasH = data.canvasH ?? state.canvasH;
  state.layers  = data.layers  ?? [];
  // Restore uid counter above any existing ids
  const maxId = state.layers.reduce((m, l) => Math.max(m, l.id), 0);
  _uid = maxId + 1;
  notify('full');
}
