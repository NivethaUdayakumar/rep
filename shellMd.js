// multiDrilldown.js (Rules by level + filetype + event + range, includes shell runner)
// Features kept and extended:
// - Tokenized drilldown (a*/b*/c*/...)
// - Breadcrumbs + Back/Forward
// - HTML or CSV steps and general file previews
// - Promote button on main grid and POST /api/promote with f1,f2,... from eN tokens
// - Right click copy to clipboard on main and popup
// - Default search presets on main and per popup level per triggering main column
// - New defColumn rule format per main column:
//   defColumn = {
//     0: [
//       { level:1, filetype:"csv",  event:"row", fileformat:"filepatternL1", range:"0-22,25,28" },
//       { level:1, filetype:"csv",  event:"col", fileformat:"filepatternL1", range:"0-3" },
//       { level:2, filetype:"csv",  event:"row", fileformat:"filepatternL2", range:"" },
//       { level:3, filetype:"html", event:"row", fileformat:"filepatternL3", range:"22-63" },
//       { level:2, filetype:"shell",event:"row", fileformat:"logs/a0.txt",   range:"10-20",
//         commands: [
//           'pkill -f "ttyd" || true',
//           'ttyd -p 7681 gvim {filename}'
//         ]}
//     ],
//     1: [...],
//     7: [...]
//   }

import { TableBuilder } from './tableBuilder.js';

export class MultiDrilldown {
  constructor({
    container = '#grid',
    name = 'mainGrid',
    csv,
    groupByIdx = [],
    statusIdx = null,
    colorColsIdx = [],
    defColumn = {},          // New structure: { colIdx: [ {level,filetype,event,fileformat,range,commands?}, ... ] }
    promoteIdx = null,
    promoteCheck = [],
    promoteData = [],
    promoteDataFiles = [],
    sep = '_',
    debug = true,
    defaultSearches = {}
  } = {}) {
    if (!csv) throw new Error('csv (main table) is required');
    this.container = container;
    this.name = name;
    this.csv = csv;
    this.groupByIdx = groupByIdx;
    this.statusIdx = Array.isArray(statusIdx) ? statusIdx : (statusIdx == null ? [] : [statusIdx]);
    this.colorColsIdx = colorColsIdx;
    this.defColumn = defColumn || {};
    this.sep = sep;
    this.debug = debug;

    this.promoteIdx       = Number.isInteger(promoteIdx) ? promoteIdx : null;
    this.promoteCheck     = Array.isArray(promoteCheck) ? promoteCheck : [];
    this.promoteData      = Array.isArray(promoteData)  ? promoteData  : [];
    this.promoteDataFiles = Array.isArray(promoteDataFiles) ? promoteDataFiles : [];

    this.defaultSearches = defaultSearches || {};

    this._openOnce = false;
    this._stack = [];   // [{ step, rules, ruleUsed, contexts, title, triggerCol }]
    this._idx = -1;
    this._level0Fields = [];
  }

  /* ======================= PUBLIC ======================= */
  async init() {
    if (!window.w2ui || !window.w2popup) {
      this.warn('w2ui/w2popup not found; include w2ui before this module.');
      return;
    }

    // Build main grid
    const tb = new TableBuilder({
      dataCsv: this.csv,
      box: this.container,
      name: this.name,
      groupByIdx: this.groupByIdx,
      statusIdx: this.statusIdx.length ? this.statusIdx[0] : null,
      colorColsIdx: this.colorColsIdx
    });
    await tb.build();

    const grid = w2ui[this.name];
    if (!grid) { this.warn(`Grid "${this.name}" not found.`); return; }

    this._level0Fields = grid.columns.map(c => c.field);

    // Right click copy on MAIN grid
    this._enableRightClickCopy(this.name);

    // Promote on MAIN only for parent rows
    if (Number.isInteger(this.promoteIdx) &&
        this.promoteIdx >= 0 && this.promoteIdx < grid.columns.length) {
      this._setupPromoteOnMainGrid(grid);
    }

    // Presets on MAIN toolbar
    this._ensureToolbar(grid);
    this._installToolbarPreset(grid, this.defaultSearches?.main || [], `${grid.name}-preset`);
    this._applyPresetList(grid, this.defaultSearches?.main || [], true);

    // Drilldown from MAIN using rule table
    grid.on('click', async (ev) => {
      const col = ev.detail?.column ?? ev.column;
      const recid = ev.detail?.recid ?? ev.recid;
      if (col == null || recid == null) return;

      if (Number.isInteger(this.promoteIdx) && col === this.promoteIdx) {
        const oe = ev.detail?.originalEvent || ev.originalEvent;
        const target = oe?.target || window.event?.target;
        if (target && target.closest && target.closest('.btn-promote')) {
          await this._handlePromoteClick(grid, recid);
          return;
        }
      }

      const rules = Array.isArray(this.defColumn[col]) ? this.defColumn[col] : null;
      if (!rules || !rules.length) return;

      const rec = grid.get(recid);
      if (!rec) return;

      const rowIndex = this._rowIndexOf(grid, recid);
      const rule = this._pickRule({
        rules,
        level: 1,
        event: 'row',
        rowIndex,
        colIndex: col
      });
      if (!rule) return;

      const mainCtx = this._valuesFromRecord(rec, this._level0Fields);
      const title = grid.columns[col]?.text || grid.columns[col]?.caption || `Col ${col}`;

      await this._openSequence({
        rules,
        startRule: rule,
        contexts: [mainCtx],
        title,
        triggerCol: col
      });
    });
  }

  /* ======================= PROMOTE (main table only) ======================= */
  _setupPromoteOnMainGrid(grid) {
    const col = grid.columns[this.promoteIdx];

    const yesMatcher = (v) => {
      const s = String(v ?? '').trim().toLowerCase();
      return s === 'yes' || s === 'y' || s === 'true' || s === '1';
    };

    const originalRender = col.render;
    col.render = (rec) => {
      const isChild   = !!(rec?.w2ui?.parent_recid);
      const isSummary = !!(rec?.w2ui?.summary);
      if (isChild || isSummary) return '';

      const field = col.field;
      const val = field ? rec[field] : '';
      if (!yesMatcher(val)) return '';
      void originalRender;
      return `<button class="w2ui-btn btn-promote" data-recid="${rec.recid}" title="Promote this row">promote</button>`;
    };

    try { grid.refresh(); } catch {}
  }

  async _handlePromoteClick(grid, recid) {
    const rec = grid.get(recid);
    if (!rec) return;

    const fields = grid.columns.map(c => c.field);

    const getVal = (idx) => rec[fields[idx]];
    const keyParts = this.promoteCheck.map(getVal).map(v => String(v ?? '').trim());
    const key = (keyParts.length <= 1) ? (keyParts[0] ?? '') : keyParts.join('_');

    const bodyObj = {};
    for (const idx of this.promoteData) {
      const header = grid.columns[idx]?.text || grid.columns[idx]?.caption || fields[idx] || `c${idx}`;
      bodyObj[header] = rec[fields[idx]];
    }

    this.promoteDataFiles.forEach((pattern, i) => {
      const resolved = this._resolvePromotePattern(String(pattern ?? ''), rec, fields);
      bodyObj[`f${i + 1}`] = resolved;
    });

    bodyObj.updatedAt = new Date().toISOString();

    const payload = { [key]: bodyObj };

    try {
      const rsp = await fetch('/api/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
      this._toast(grid.box, 'Promoted');
    } catch (e) {
      console.error('Promote failed:', e);
      this._toast(grid.box, 'Promote failed');
    }
  }

  _resolvePromotePattern(pattern, rec, fields) {
    const safePart = (s) =>
      String(s ?? '').replace(/[^\w\-./]+/g, '_').replace(/^_+|_+$/g, '');
    return pattern.replace(/e(\d+)/gi, (_, idxStr) => {
      const i = Number(idxStr);
      const v = rec[fields[i]];
      return safePart(v);
    });
  }

  /* ======================= RULED SEQUENCE NAV ======================= */
  async _openSequence({ rules, startRule, contexts, title, triggerCol }) {
    await this._ensurePopup(title, this._crumbsFor({ step: 0, rules, ruleUsed: startRule, contexts }));
    await this._renderStep({ step: 0, rules, ruleUsed: startRule, contexts, title, triggerCol }, false);
    this._stack = [{ step: 0, rules, ruleUsed: startRule, contexts, title, triggerCol }];
    this._idx = 0;
    this._updateNavButtons();
  }

  async _advance({ current, rowCtx, clickColIndex, clickRowIndex }) {
    const nextStep = current.step + 1;
    const nextLevel = nextStep + 1; // level 1 is step 0
    const nextRules = current.rules;

    const rule = this._pickRule({
      rules: nextRules,
      level: nextLevel,
      event: 'row',    // default to row, adjusted below in selection
      rowIndex: clickRowIndex,
      colIndex: clickColIndex
    }, true); // allow both row and col match
    if (!rule) return;

    const nextContexts = [...current.contexts, rowCtx];
    const nextState = {
      step: nextStep,
      rules: nextRules,
      ruleUsed: rule,
      contexts: nextContexts,
      title: current.title,
      triggerCol: current.triggerCol
    };

    await this._renderStep(nextState, true);
    this._stack = this._stack.slice(0, this._idx + 1);
    this._stack.push(nextState);
    this._idx = this._stack.length - 1;
    this._updateNavButtons();
  }

  async _go(delta) {
    const ni = this._idx + delta;
    if (ni < 0 || ni >= this._stack.length) return;
    this._idx = ni;
    const st = this._stack[this._idx];
    await this._ensurePopup(st.title, this._crumbsFor(st));
    await this._renderStep(st, false, false);
    this._updateNavButtons();
  }

  /* ======================= RENDER ONE STEP FROM A RULE ======================= */
  async _renderStep(state, replaceForward = false, noWire = false) {
    const { step, ruleUsed, contexts } = state;
    if (!ruleUsed) return;
    const url = this._resolvePattern(ruleUsed.fileformat, contexts);

    this._replaceBody(`<div id="dd-body-inner" style="height:100%;"></div>`);

    if (String(ruleUsed.filetype).toLowerCase() === 'shell') {
      await this._runShellWithFile(url, ruleUsed.commands);
      this._setCrumbs(this._crumbsFor(state, url));
      document.getElementById('dd-body-inner').innerHTML =
        `<div style="padding:12px;">Shell command sent for <code>${this._esc(url)}</code></div>`;
      return;
    }

    const ext = this._extFromUrl(url);

    if (['csv','tsv'].includes(ext)) {
      if (!(await this._exists(url))) return this._missing(url);
      const innerId = 'dd-grid';
      document.getElementById('dd-body-inner').innerHTML = `<div id="${innerId}" style="height:520px;"></div>`;
      await this._raf2();

      if (w2ui.ddGrid) try { w2ui.ddGrid.destroy(); } catch {}
      const tb = new TableBuilder({ dataCsv: url, box: `#${innerId}`, name: 'ddGrid' });
      await tb.build();
      try { w2ui.ddGrid?.resize(); } catch {}

      this._enableRightClickCopy('ddGrid');

      const dd = w2ui.ddGrid;
      this._ensureToolbar(dd);
      const presets = this._searchPresetsFor(state);
      this._installToolbarPreset(dd, presets, `ddGrid-preset`);
      this._applyPresetList(dd, presets, true);

      if (!noWire) {
        const grid = w2ui.ddGrid;
        grid.on('click', async (ev) => {
          const recid = ev.detail?.recid ?? ev.recid;
          const colIndex = ev.detail?.column ?? ev.column;
          const rec = grid.get(recid);
          if (!rec) return;
          const fields = grid.columns.map(c => c.field);
          const rowCtx = this._valuesFromRecord(rec, fields);
          const rowIndex = this._rowIndexOf(grid, recid);
          await this._advance({
            current: state,
            rowCtx,
            clickColIndex: colIndex,
            clickRowIndex: rowIndex
          });
        });
      }

      this._setCrumbs(this._crumbsFor(state, url));
      return;
    }

    // HTML or general file preview
    if (!(await this._exists(url))) return this._missing(url);

    const body = document.getElementById('dd-body-inner');
    const lower = ext;

    if (['html','htm','pdf'].includes(lower)) {
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;">
          <div style="flex:1 1 auto;min-height:420px;">
            <iframe src="${this._esc(url)}" title="preview" style="border:0;width:100%;height:100%;"></iframe>
          </div>
        </div>`;
      this._setCrumbs(this._crumbsFor(state, url));
      return;
    }

    if (['png','jpg','jpeg','gif','bmp','webp','svg'].includes(lower)) {
      body.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;overflow:auto;">
          <img src="${this._esc(url)}" alt="image" style="max-width:100%;max-height:100%;object-fit:contain;">
        </div>`;
      this._setCrumbs(this._crumbsFor(state, url));
      return;
    }

    if (['mp4','webm','ogg'].includes(lower)) {
      body.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;">
          <video src="${this._esc(url)}" controls style="max-width:100%;max-height:100%;"></video>
        </div>`;
      this._setCrumbs(this._crumbsFor(state, url));
      return;
    }

    if (['mp3','wav','flac','m4a','aac','oga'].includes(lower)) {
      body.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;padding:8px;">
          <audio src="${this._esc(url)}" controls></audio>
        </div>`;
      this._setCrumbs(this._crumbsFor(state, url));
      return;
    }

    // Fallback
    body.innerHTML = `
      <div style="padding:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <a href="${this._esc(url)}" target="_blank" class="w2ui-btn">Open file</a>
        <div style="flex:1 1 100%;">
          <iframe src="${this._esc(url)}" title="preview" style="border:0;width:100%;height:60vh;"></iframe>
        </div>
      </div>`;
    this._setCrumbs(this._crumbsFor(state, url));
  }

  /* ======================= RULE PICKING AND RANGES ======================= */
  _pickRule({ rules, level, event, rowIndex, colIndex }, allowEitherEvent = false) {
    if (!Array.isArray(rules)) return null;
    const cand = rules.filter(r => Number(r?.level) === Number(level));
    if (!cand.length) return null;

    const check = (r) => {
      const ev = String(r.event || '').toLowerCase();
      if (!allowEitherEvent && ev !== String(event).toLowerCase()) return false;

      const rtype = String(r.range || '').trim();
      const parsed = this._parseRange(rtype);
      if (ev === 'row') {
        return parsed.all || parsed.set.has(Number(rowIndex));
      } else if (ev === 'col') {
        return parsed.all || parsed.set.has(Number(colIndex));
      } else {
        return false;
      }
    };

    // If allowEitherEvent, try match with row then col
    if (allowEitherEvent) {
      let byRow = cand.find(r => String(r.event).toLowerCase() === 'row' && check(r));
      if (byRow) return byRow;
      let byCol = cand.find(r => String(r.event).toLowerCase() === 'col' && check(r));
      if (byCol) return byCol;
      // if ranges are empty and no index provided, fall back to any with empty range
      let anyAll = cand.find(r => String(r.range || '') === '');
      if (anyAll) return anyAll;
      return null;
    }

    // Normal strict event match
    for (const r of cand) {
      if (check(r)) return r;
    }
    // fallback if any rule has empty range for this event
    return cand.find(r => String(r.event || '').toLowerCase() === String(event).toLowerCase()
                       && String(r.range || '') === '') || null;
  }

  _parseRange(spec) {
    const out = { all: false, set: new Set() };
    const s = String(spec || '').trim();
    if (!s) { out.all = true; return out; }
    for (const part of s.split(',').map(x => x.trim()).filter(Boolean)) {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) out.set.add(i);
        continue;
      }
      const n = Number(part);
      if (!Number.isNaN(n)) out.set.add(n);
    }
    return out;
  }

  /* ======================= TOKEN RESOLUTION ======================= */
  _resolvePattern(pattern, contexts) {
    const mapLetterToIndex = (ch) => ch.toLowerCase().charCodeAt(0) - 97;
    const safePart = (s) =>
      String(s ?? '').replace(/[^\w\-./]+/g, '_').replace(/^_+|_+$/g, '');
    return String(pattern ?? '').replace(/([a-zA-Z])(\d+)/g, (_, letter, idxStr) => {
      const ctxIndex = mapLetterToIndex(letter);
      const row = contexts[ctxIndex] || [];
      return safePart(row[Number(idxStr)]);
    });
  }

  /* ======================= POPUP SHELL + CRUMBS ======================= */
  async _ensurePopup(title, crumbs) {
    const shell = `
      <div id="dd-wrap" style="padding:8px; display:flex; flex-direction:column; gap:8px; height:100%; box-sizing:border-box;">
        <div id="dd-bar" style="display:flex; align-items:center; gap:8px; flex:0 0 auto;">
          <button id="dd-back" class="w2ui-btn">◀ Back</button>
          <button id="dd-fwd"  class="w2ui-btn">Forward ▶</button>
          <div id="dd-crumbs" style="margin-left:8px; flex:1;"></div>
        </div>
        <div id="dd-body" style="flex:1 1 auto; min-height:400px; overflow:hidden;"></div>
      </div>`;
    if (!this._openOnce) {
      await new Promise(resolve => {
        w2popup.open({
          title, body: shell, modal: true, showMax: true, width: 980, height: 640,
          onOpen(evt){ evt.onComplete = resolve; }
        });
      });
      document.getElementById('dd-back')?.addEventListener('click', () => this._go(-1));
      document.getElementById('dd-fwd') ?.addEventListener('click', () => this._go(+1));
      this._openOnce = true;
      w2popup.on?.('resize', () => {
        const g = w2ui.ddGrid;
        if (g && g.box && w2popup.body && w2popup.body.contains(g.box)) { try { g.resize(); } catch {} }
      });
    } else {
      w2popup.title?.(title);
    }
    this._setCrumbs(crumbs);
  }

  _crumbsFor(state, url = '') {
    const parts = [];
    parts.push({ label: 'Main', go: () => this._closePopup() });
    if (state?.step >= 0) {
      const ctx0 = state.contexts?.[0] ?? [];
      const compact = this._safeJoin([ctx0[0], ctx0[1], ctx0[2]].filter(Boolean)).slice(0, 48);
      if (compact) parts.push({ label: compact, go: () => this._popBackToStep(0) });
      if (url) parts.push({ label: this._basename(url) });
    }
    return parts;
  }

  async _popBackToStep(step) {
    for (let i = this._idx; i >= 0; i--) {
      if (this._stack[i].step === step) {
        this._idx = i;
        const st = this._stack[i];
        await this._ensurePopup(st.title, this._crumbsFor(st));
        await this._renderStep(st, false, false);
        this._updateNavButtons();
        return;
      }
    }
  }

  setCrumbs(...args) { return this._setCrumbs(...args); }
  _setCrumbs(items = []) {
    const host = document.getElementById('dd-crumbs');
    if (!host) return;
    host.innerHTML = '';

    items.forEach((it, idx) => {
      const isLink = typeof it.go === 'function';
      const node = document.createElement(isLink ? 'a' : 'span');
      node.textContent = String(it.label ?? '');
      node.style.marginRight = '6px';
      if (isLink) {
        node.href = 'javascript:void(0)';
        node.style.textDecoration = 'underline';
        node.addEventListener('click', (e) => { e.preventDefault(); it.go(); });
      } else {
        node.style.opacity = 0.85;
      }
      host.appendChild(node);

      if (idx < items.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.margin = '0 6px';
        sep.style.opacity = 0.6;
        host.appendChild(sep);
      }
    });
  }

  /* ======================= Toolbar Presets ======================= */
  _ensureToolbar(grid) {
    if (!grid) return;
    grid.show = grid.show || {};
    grid.show.toolbar = true;
    try { grid.refresh?.(); } catch {}
  }

  _installToolbarPreset(grid, presets, selectId) {
    if (!grid || !grid.toolbar) return;
    if (grid._mdPresetToolbarAdded) return;

    try {
      grid.toolbar.add([
        { type: 'break', id: 'mdspacer' },
        {
          type: 'html',
          id: 'mdpreset',
          html: () => {
            const opts = Array.isArray(presets) ? presets : [];
            const options = opts.map((p, i) =>
              `<option value="${i}">${this._esc(p.text ?? `Preset ${i + 1}`)}</option>`
            ).join('');
            return `
              <div style="padding:4px 8px;">
                <label style="font-size:12px;margin-right:6px;">Preset:</label>
                <select id="${selectId}" class="w2ui-input" style="max-width:260px;">${options || '<option>No presets</option>'}</select>
              </div>
            `;
          }
        }
      ]);

      const bind = () => {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        sel.onchange = () => {
          const idx = Number(sel.value);
          const preset = (Array.isArray(presets) && presets[idx]) || null;
          this._applyPreset(grid, preset);
        };
      };

      requestAnimationFrame(() => bind());
      grid.on('refresh', () => { requestAnimationFrame(() => bind()); });

      grid._mdPresetToolbarAdded = true;
    } catch (e) {
      console.warn('Failed to add preset control to toolbar:', e);
    }
  }

  _searchPresetsFor(state) {
    const colIdx = state?.triggerCol;
    const step   = state?.step ?? 0;
    const arr = this.defaultSearches?.byCol?.[colIdx]?.[step];
    return Array.isArray(arr) ? arr : [];
  }

  _applyPresetList(grid, presets, autoApplyFirst = true) {
    if (!grid) return;
    if (Array.isArray(presets) && presets.length && autoApplyFirst) {
      this._applyPreset(grid, presets[0]);
      const sel = document.getElementById(`${grid.name}-preset`) || document.getElementById('ddGrid-preset');
      if (sel) sel.selectedIndex = 0;
    }
  }

  _applyPreset(grid, preset) {
    if (!grid || !preset || !Array.isArray(preset.data)) return;
    const norm = [];
    for (const d of preset.data) {
      const field = d.field;
      if (!field) continue;
      const operator = d.operator || 'contains';

      if (operator === 'between' && (Array.isArray(d.value) || d.value2 !== undefined)) {
        const v1 = Array.isArray(d.value) ? d.value[0] : d.value;
        const v2 = Array.isArray(d.value) ? d.value[1] : d.value2;
        norm.push({ field, operator: 'between', value: v1, value2: v2 });
      } else if ((operator === 'in' || operator === 'not in') && Array.isArray(d.value)) {
        norm.push({ field, operator, value: d.value });
      } else {
        norm.push({ field, operator, value: d.value });
      }
    }
    const logic = (preset.logic || 'AND').toUpperCase();

    try {
      if (typeof grid.search === 'function' && grid.search.length >= 2) {
        grid.search(norm, logic);
      } else if (typeof grid.search === 'function') {
        grid.search(norm);
        if (grid.last) grid.last.logic = logic;
        grid.refresh?.();
      } else {
        grid.searchData = norm;
        if (grid.last) grid.last.logic = logic;
        grid.refresh?.();
      }
    } catch (e) {
      console.warn('Apply preset failed:', e);
    }
  }

  /* ======================= Right click copy ======================= */
  _enableRightClickCopy(gridName) {
    const grid = w2ui[gridName];
    if (!grid || !grid.box) return;
    if (grid._rc_copy_bound) return;
    grid._rc_copy_bound = true;

    grid.box.addEventListener('contextmenu', async (e) => {
      const td = e.target.closest('td.w2ui-grid-data');
      if (!td) return;
      e.preventDefault();

      const col = Number(td.getAttribute('col'));
      if (Number.isNaN(col)) return;

      const tr = td.parentElement;
      let recid = tr?.getAttribute('recid');
      if (!recid && tr?.id) {
        const m = tr.id.match(/_rec_(.*)$/);
        if (m) recid = m[1];
      }
      if (recid == null) return;

      const grid2 = w2ui[gridName];
      const rec = grid2.get(recid);
      if (!rec) return;

      const field = grid2.columns[col]?.field;
      const value = (field != null) ? rec[field] : '';
      const text = String(value ?? '');

      try {
        await navigator.clipboard.writeText(text);
        this._toast(grid2.box, 'Copied');
      } catch {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(td);
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand('copy'); this._toast(grid2.box, 'Copied'); }
        catch { this._toast(grid2.box, 'Copy failed'); }
        sel.removeAllRanges();
      }
    }, { passive: false });
  }

  _toast(containerEl, msg = 'Copied') {
    const host = document.createElement('div');
    host.textContent = msg;
    Object.assign(host.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.7)',
      color: '#fff',
      borderRadius: '6px',
      fontSize: '12px',
      zIndex: 99999,
      pointerEvents: 'none',
      transition: 'opacity .2s',
      opacity: '0'
    });
    const parent = containerEl.closest('.w2ui-grid') || containerEl;
    const prevPos = parent.style.position;
    if (!prevPos) parent.style.position = 'relative';
    parent.appendChild(host);
    requestAnimationFrame(() => { host.style.opacity = '1'; });
    setTimeout(() => {
      host.style.opacity = '0';
      setTimeout(() => {
        try { parent.removeChild(host); } catch {}
        if (!prevPos) parent.style.position = '';
      }, 200);
    }, 900);
  }

  /* ======================= Utils ======================= */
  _replaceBody(html) {
    const body = document.getElementById('dd-body');
    if (!body) return;
    body.innerHTML = html;
  }

  _closePopup() {
    try { w2popup.close(); } catch {}
    this._openOnce = false;
    this._stack = [];
    this._idx = -1;
    if (w2ui.ddGrid) try { w2ui.ddGrid.destroy(); } catch {}
  }

  _updateNavButtons() {
    const back = document.getElementById('dd-back');
    const fwd  = document.getElementById('dd-fwd');
    if (back) back.disabled = !(this._idx > 0);
    if (fwd)  fwd.disabled  = !(this._idx >= 0 && this._idx < this._stack.length - 1);
  }

  _valuesFromRecord(rec, fields) { return fields.map(f => rec[f]); }
  async _raf2(){ await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

  async _exists(url) {
    try {
      const g = await fetch(url, { method:'GET' });
      return g.ok;
    } catch { return false; }
  }

  _missing(url) { w2alert(`File not found:\n${url}`); }
  _basename(p){ return (p.split('/').pop() || p); }
  _esc(s){ return String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'gt;','"':'&quot;',"'":'&#39;'}[c])); }
  _safeJoin(arr){ return arr.map(v => String(v ?? '').replace(/[^\w\-]+/g,'_')).join(this.sep); }
  _extFromUrl(u){ const m = String(u||'').toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/); return m ? m[1] : ''; }

  _rowIndexOf(grid, recid) {
    const recs = grid.records || [];
    for (let i = 0; i < recs.length; i++) {
      if (String(recs[i].recid) === String(recid)) return i;
    }
    return -1;
  }

  /* ======================= Shell runner ======================= */
  async _runShellWithFile(filename, commands) {
    const cmds = Array.isArray(commands) && commands.length
      ? commands.slice()
      : [
          'pkill -f "ttyd" || true',
          'ttyd -p 7681 gvim {filename}'
        ];
    const filled = cmds.map(c => String(c).replaceAll('{filename}', filename));
    try {
      const rsp = await fetch('/api/shell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: filled })
      });
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
    } catch (e) {
      console.error('Shell run failed:', e);
      w2alert('Shell command failed. See console for details.');
    }
  }

  log(...a){ if(this.debug) console.log('[MultiDrilldown]', ...a); }
  warn(...a){ console.warn('[MultiDrilldown]', ...a); }
}
