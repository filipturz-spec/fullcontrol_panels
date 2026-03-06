/**
 * UI Module
 *
 * Renders the sidebar layer list and per-generator control panels.
 * All mutations go through state.js; re-rendering is triggered by
 * the central subscriber in main.js.
 */

import { GENERATORS, GENERATOR_ORDER } from './generators/registry.js';
import {
  addLayer, removeLayer, toggleVisible,
  setParam, setZoneParam, addZone, removeZone,
  getState,
} from './state.js';

// ── Generator picker ──────────────────────────────────────────────────────
export function buildGeneratorPicker(pickerEl, onPick) {
  GENERATOR_ORDER.forEach(type => {
    const g    = GENERATORS[type];
    const item = document.createElement('div');
    item.className = 'picker-item';
    item.innerHTML = `
      <span class="pi-icon">${g.icon}</span>
      <span>
        <div class="pi-name">${g.label}</div>
        <div class="pi-desc">${g.description}</div>
      </span>`;
    item.addEventListener('click', () => onPick(type));
    pickerEl.appendChild(item);
  });
}

// ── Full layer list render ────────────────────────────────────────────────
export function renderLayerList(listEl, appState, onParamChange) {
  // Save open-state before clearing
  const openIds = new Set(
    [...listEl.querySelectorAll('.layer-card.open')].map(el => +el.dataset.id)
  );

  listEl.innerHTML = '';

  if (appState.layers.length === 0) {
    listEl.innerHTML = `
      <div id="layers-empty">
        <div class="empty-icon">◈</div>
        No layers yet.<br>Click <strong>+ Layer</strong> to begin.
      </div>`;
    return;
  }

  // Render layers in reverse order (top layer shown first in sidebar)
  [...appState.layers].reverse().forEach(layer => {
    const card = buildLayerCard(layer, openIds.has(layer.id), onParamChange);
    listEl.appendChild(card);
  });
}

// ── Layer card ────────────────────────────────────────────────────────────
function buildLayerCard(layer, isOpen, onParamChange) {
  const g    = GENERATORS[layer.type];
  const card = document.createElement('div');
  card.className = `layer-card${isOpen ? ' open' : ''}`;
  card.dataset.id = layer.id;

  card.innerHTML = `
    <div class="layer-header">
      <div class="layer-vis ${layer.visible ? 'on' : 'off'}" data-action="vis">${layer.visible ? '●' : '○'}</div>
      <span class="layer-type-badge">${g.icon} ${g.type}</span>
      <span class="layer-name">${layer.name}</span>
      <span class="layer-chevron">›</span>
      <button class="layer-del" data-action="del" title="Delete layer">✕</button>
    </div>
    <div class="layer-controls">
      ${buildControls(layer)}
    </div>`;

  // ── Events ──
  const header = card.querySelector('.layer-header');
  header.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'del') {
      e.stopPropagation();
      removeLayer(layer.id);
      return;
    }
    if (action === 'vis') {
      e.stopPropagation();
      toggleVisible(layer.id);
      return;
    }
    card.classList.toggle('open');
  });

  wireControls(card, layer, onParamChange);
  return card;
}

// ── Control panel HTML ────────────────────────────────────────────────────
function buildControls(layer) {
  const p = layer.params;
  switch (layer.type) {
    case 'diamond':     return diamondControls(p);
    case 'zigzag':      return zigzagControls(p);
    case 'ladder':      return ladderControls(p);
    case 'roundedRect': return roundedRectControls(p);
    default:            return '';
  }
}

// ─── Slider helper ────────────────────────────────────────────────────────
function sliderRow(label, key, min, max, step, value) {
  return `
    <div class="ctrl-row">
      <span class="ctrl-label">${label}</span>
      <input class="ctrl-slider" type="range"
        data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
      <input class="ctrl-number" type="number"
        data-key="${key}-num" min="${min}" max="${max}" step="${step}" value="${value}">
    </div>`;
}

function colorRow(label, key, value) {
  return `
    <div class="ctrl-row">
      <span class="ctrl-label">${label}</span>
      <input type="color" data-key="${key}" value="${rgbToHex(value)}"
        style="flex:1;height:26px;border:none;background:none;cursor:pointer;">
    </div>`;
}

function checkRow(label, key, checked) {
  return `
    <label class="ctrl-checkbox-row">
      <input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''}>
      ${label}
    </label>`;
}

// ─── Diamond controls ─────────────────────────────────────────────────────
function diamondControls(p) {
  return `
    <div class="ctrl-section">
      <div class="ctrl-section-title">Pattern</div>
      ${sliderRow('Columns',      'cols',        3,  24, 1, p.cols)}
      ${sliderRow('Amplitude',    'amplitude',   5, 120, 1, p.amplitude)}
      ${sliderRow('Freq Top',     'freqTop',   0.5,  8, 0.1, p.freqTop)}
      ${sliderRow('Freq Bottom',  'freqBottom',0.5,  8, 0.1, p.freqBottom)}
      ${sliderRow('Phase Step',   'phaseStep', 0,    3, 0.05, p.phaseStep)}
      ${sliderRow('Lean Angle',   'angle',    -30,  30, 1, p.angle)}
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Style</div>
      ${sliderRow('Stroke',       'strokeWeight', 0.5, 8, 0.5, p.strokeWeight)}
      ${colorRow( 'Color',        'color', p.color)}
    </div>`;
}

// ─── Zigzag controls ──────────────────────────────────────────────────────
function zigzagControls(p) {
  return `
    <div class="ctrl-section">
      <div class="ctrl-section-title">Pattern</div>
      ${sliderRow('Columns',   'cols',      3,  28,  1, p.cols)}
      ${sliderRow('Rows',      'rows',      2,  30,  1, p.rows)}
      ${sliderRow('Compress',  'compress', -1,   1, 0.05, p.compress)}
      ${sliderRow('Curvature', 'curvature',-2,   2, 0.05, p.curvature)}
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Style</div>
      ${sliderRow('Stroke',    'strokeWeight', 0.5, 8, 0.5, p.strokeWeight)}
      ${colorRow( 'Color',     'color', p.color)}
    </div>`;
}

// ─── Ladder controls ──────────────────────────────────────────────────────
function ladderControls(p) {
  const zonesHTML = p.zones.map((z, i) => `
    <div class="zone-row" data-zone="${i}">
      <input type="number" data-zone-key="heightFrac" data-zone-i="${i}"
        value="${z.heightFrac}" min="0.01" max="1" step="0.01"
        placeholder="height %">
      <input type="number" data-zone-key="rungs" data-zone-i="${i}"
        value="${z.rungs}" min="0" max="40" step="1"
        placeholder="rungs">
      <button class="zone-del" data-zone-del="${i}" title="Remove zone">✕</button>
    </div>`).join('');

  return `
    <div class="ctrl-section">
      <div class="ctrl-section-title">Columns</div>
      ${sliderRow('Columns', 'cols', 2, 30, 1, p.cols)}
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Zones (height %, rungs)</div>
      <div class="zones-editor">${zonesHTML}</div>
      <button class="btn-add-zone">+ Add Zone</button>
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Style</div>
      ${sliderRow('Stroke', 'strokeWeight', 0.5, 8, 0.5, p.strokeWeight)}
      ${colorRow( 'Color',  'color', p.color)}
    </div>`;
}

// ─── Rounded Rect controls ────────────────────────────────────────────────
function roundedRectControls(p) {
  return `
    <div class="ctrl-section">
      <div class="ctrl-section-title">Grid</div>
      ${sliderRow('Columns',       'cols',         2, 12, 1, p.cols)}
      ${sliderRow('Rows',          'rows',         2, 20, 1, p.rows)}
      ${sliderRow('Gap X',         'gapX',         0, 40, 1, p.gapX)}
      ${sliderRow('Gap Y',         'gapY',         0, 40, 1, p.gapY)}
      ${sliderRow('Corner Radius', 'cornerRadius', 0, 60, 1, p.cornerRadius)}
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Links</div>
      ${checkRow('Horizontal links', 'linkH', p.linkH)}
      ${checkRow('Vertical links',   'linkV', p.linkV)}
    </div>
    <div class="ctrl-section">
      <div class="ctrl-section-title">Style</div>
      ${sliderRow('Stroke', 'strokeWeight', 0.5, 8, 0.5, p.strokeWeight)}
      ${colorRow( 'Color',  'color', p.color)}
    </div>`;
}

// ── Wire up interactive controls ──────────────────────────────────────────
function wireControls(card, layer, onParamChange) {
  const ctrl = card.querySelector('.layer-controls');
  if (!ctrl) return;

  // Sliders ↔ number inputs (synced pair)
  ctrl.querySelectorAll('.ctrl-slider').forEach(slider => {
    const key    = slider.dataset.key;
    const numEl  = ctrl.querySelector(`.ctrl-number[data-key="${key}-num"]`);

    const update = val => {
      const parsed = parseFloat(val);
      setParam(layer.id, key, parsed);
      if (numEl) numEl.value = parsed;
      onParamChange(layer.id);
    };

    slider.addEventListener('input', e => {
      if (numEl) numEl.value = e.target.value;
      update(e.target.value);
    });
    numEl?.addEventListener('change', e => {
      slider.value = e.target.value;
      update(e.target.value);
    });
  });

  // Color pickers
  ctrl.querySelectorAll('input[type="color"]').forEach(el => {
    el.addEventListener('input', e => {
      setParam(layer.id, el.dataset.key, e.target.value);
      onParamChange(layer.id);
    });
  });

  // Checkboxes
  ctrl.querySelectorAll('input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', e => {
      setParam(layer.id, el.dataset.key, e.target.checked);
      onParamChange(layer.id);
    });
  });

  // Zone inputs
  ctrl.querySelectorAll('[data-zone-key]').forEach(el => {
    el.addEventListener('change', e => {
      const i   = +e.target.dataset.zoneI;
      const key = e.target.dataset.zoneKey;
      const val = key === 'rungs' ? parseInt(e.target.value) : parseFloat(e.target.value);
      setZoneParam(layer.id, i, key, val);
      onParamChange(layer.id);
    });
  });

  // Zone delete buttons
  ctrl.querySelectorAll('[data-zone-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      removeZone(layer.id, +btn.dataset.zoneDel);
      onParamChange(layer.id);
    });
  });

  // Add zone
  ctrl.querySelector('.btn-add-zone')?.addEventListener('click', () => {
    addZone(layer.id);
    onParamChange(layer.id);
  });
}

// ── Utility ───────────────────────────────────────────────────────────────
function rgbToHex(color) {
  if (color && color.startsWith('#')) return color;
  // Fallback
  return '#8B6914';
}
