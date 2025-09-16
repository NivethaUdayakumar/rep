// multiDrilldown.js
// New API (drop-in): see example usage in your prompt.
// - Double LEFT click = drilldown
// - Double RIGHT click = copy cell text to clipboard
// - defColumn: { colIdx: [ level1Pattern, level2Pattern, ... ] }
//   Tokens in patterns: a0,a1,...  (main row cols), b0,b1,... (level-1 row), c0,c1,... etc.
//   Example: './data/files/a0_a1_a2_a3_a4_a5_summary.csv'
// - If a pattern ends with '.html' it is fetched and injected into the popup.
// - Reuses a single popup with breadcrumbs.

import { TableBuilder } from './tableBuilder.js';

export class MultiDrilldown {
  /**
   * @param {Object} opts
   * @param {string} opts.container  - CSS selector where main grid is rendered
   * @param {string} opts.name       - Display name for main grid
   * @param {string} opts.csv        - Path to main CSV
   * @param {number[]} [opts.groupByIdx=[]] - 0-based indices for grouping (passed to TableBuilder)
   * @param {number[]} [opts.statusIdx=[]]  - 0-based indices to color by status
   * @param {number[]|null} [opts.promoteIdx=null] - 0-based indices where a 'promote' button can appear (handled in TableBuilder)
   * @param {number[]|null} [opts.promoteCheck=null] - 0-based indices to join for key (TableBuilder uses it)
   * @param {number[]|null} [opts.promoteData=null]  - 0-based indices to save (TableBuilder uses it)
   * @param {Object} [opts.defColumn={}] - map colIdx -> [patternLevel1, patternLevel2, ...]
   * @param {string} [opts.sep='_']      - not used by formatter (kept for compat)
   * @param {boolean} [opts.debug=false]
   */
  constructor({
    container,
    name,
    csv,
    groupByIdx = [],
    statusIdx = [],
    promoteIdx = null,
    promoteCheck = null,
    promoteData = null,
    defColumn = {},
    sep = '_',
    debug = false,
  }) {
    Object.assign(this, {
      container, name, csv, groupByIdx, statusIdx,
      promoteIdx, promoteCheck, promoteData, defColumn, sep, debug
    });

    this._popup = null;
    this._crumbs = [];     // [{label, action}] stack to render
    this._trailRows = [];  // per-level selected row arrays: [mainRow, bRow, cRow, ...]
    this._patterns = null; // active patterns array for the column that initiated the drilldown
  }

  async init() {
    // Render the main table
    const tb = new TableBuilder({
      dataCsv: this.csv,
      box: this.container,
      name: this.name,
      groupByIdx: this.groupByIdx,
      statusIdx: this.statusIdx,
      promoteIdx: this.promoteIdx,
      promoteCheck: this.promoteCheck,
      promoteData: this.promoteData,
      debug: this.debug,
      onCellDblClick: (ev, payload) => this.#onCellDblClickMain(payload),
      onCellRightDblClick: (ev, payload) => this.#copyToClipboard(payload.value),
    });
    await tb.build();
  }

  // ========== Drilldown handlers ==========

  #onCellDblClickMain({ col, rowArr, headers }) {
    if (!(col in this.defColumn)) return;
    this._patterns = this.defColumn[col]; // array for this column
    if (!Array.isArray(this._patterns) || this._patterns.length === 0) return;

    // Reset stacks
    this._trailRows = [rowArr];
    this._openPopup();

    // Level 1 from 'a*' tokens
    const level = 0; // 'a'
    const resolved = this.#resolvePattern(this._patterns[level], this._trailRows);
    this.#pushCrumb(this.name, () => {
      // back to level 0 -> show resolved again
      this._trailRows = [rowArr];
      this.#renderResolved(resolved, level);
    });
    this.#renderResolved(resolved, level);
  }

  // When inside popup, any cell double-click should try to go deeper if a next pattern exists
  #onCellDblClickPopup(level, headers, rowArr) {
    const nextLevel = level + 1;
    if (!this._patterns || nextLevel >= this._patterns.length) return;

    // Track the row for token substitution (b*, c*, ...)
    this._trailRows[nextLevel] = rowArr;

    const resolved = this.#resolvePattern(this._patterns[nextLevel], this._trailRows);
    this.#pushCrumb(`Level ${nextLevel}`, () => {
      // Re-render that specific level
      this.#renderResolved(resolved, nextLevel);
    });
    this.#renderResolved(resolved, nextLevel);
  }

  // ========== Popup & breadcrumbs ==========

  _openPopup() {
    if (this._popup) {
      this._popup.style.display = 'block';
      this.#renderCrumbs();
      return;
    }
    const wrap = document.createElement('div');
    wrap.id = 'mdd-popup';
    Object.assign(wrap.style, {
      position: 'fixed', inset: '4%', background: '#fff', border: '1px solid #ccc',
      borderRadius: '12px', zIndex: 99999, display: 'flex', flexDirection: 'column',
      boxShadow: '0 10px 30px rgba(0,0,0,0.25)', overflow: 'hidden'
    });

    const header = document.createElement('div');
    header.id = 'mdd-popup-header';
    Object.assign(header.style, {
      padding: '10px 14px', borderBottom: '1px solid #eee',
      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      marginLeft: 'auto', fontSize: '18px', lineHeight: '18px',
      padding: '4px 8px', cursor: 'pointer'
    });
    closeBtn.addEventListener('click', () => {
      wrap.style.display = 'none';
      this._crumbs = [];
    });

    const crumbBar = document.createElement('div');
    crumbBar.id = 'mdd-crumbs';
    crumbBar.style.display = 'flex';
    crumbBar.style.flexWrap = 'wrap';
    crumbBar.style.gap = '6px';

    header.appendChild(crumbBar);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.id = 'mdd-popup-content';
    Object.assign(body.style, { flex: '1 1 auto', overflow: 'auto' });

    wrap.appendChild(header);
    wrap.appendChild(body);
    document.body.appendChild(wrap);

    this._popup = wrap;
    this.#renderCrumbs();
  }

  #renderCrumbs() {
    const bar = this._popup.querySelector('#mdd-crumbs');
    bar.innerHTML = '';
    if (this._crumbs.length === 0) {
      const base = document.createElement('span');
      base.textContent = this.name;
      bar.appendChild(base);
      return;
    }
    this._crumbs.forEach((c, i) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = c.label;
      a.style.textDecoration = 'none';
      a.style.padding = '2px 6px';
      a.style.borderRadius = '6px';
      a.style.background = i === this._crumbs.length - 1 ? '#eef' : '#f5f5f5';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        // Trim crumbs to clicked
        this._crumbs = this._crumbs.slice(0, i + 1);
        c.action?.();
        this.#renderCrumbs();
      });
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.opacity = '0.6';
        sep.style.padding = '0 2px';
        bar.appendChild(sep);
      }
      bar.appendChild(a);
    });
  }

  #pushCrumb(label, action) {
    // Avoid adding duplicates back-to-back
    if (this._crumbs.length === 0 || this._crumbs[this._crumbs.length - 1].label !== label) {
      this._crumbs.push({ label, action });
    }
    this.#renderCrumbs();
  }

  // ========== Loading & rendering resolved resource ==========

  async #renderResolved(resolvedPath, level) {
    const host = this._popup.querySelector('#mdd-popup-content');
    host.innerHTML = '';

    const isHtml = /\.html?(\?|#|$)/i.test(resolvedPath);
    const isCsv  = /\.csv(\?|#|$)/i.test(resolvedPath);

    if (this.debug) console.log('[MultiDrilldown] resolved:', resolvedPath, { level });

    if (isHtml) {
      try {
        const resp = await fetch(resolvedPath, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        host.innerHTML = html;
      } catch (e) {
        host.innerHTML = `<div style="padding:12px;color:#b00;">Failed to load HTML: ${resolvedPath}<br>${e}</div>`;
      }
      return;
    }

    if (isCsv) {
      const innerBox = document.createElement('div');
      const innerId = `mdd-grid-l${level}-${Date.now()}`;
      innerBox.id = innerId;
      host.appendChild(innerBox);

      const tb = new TableBuilder({
        dataCsv: resolvedPath,
        box: `#${innerId}`,
        name: `Level ${level}`,
        groupByIdx: [],           // popup tables: no grouping by default
        statusIdx: this.statusIdx,
        debug: this.debug,
        onCellDblClick: (ev, payload) => {
          // record clicked row for token substitutions at this level
          this.#onCellDblClickPopup(level, payload.headers, payload.rowArr);
        },
        onCellRightDblClick: (ev, payload) => this.#copyToClipboard(payload.value),
      });
      await tb.build();
      return;
    }

    host.innerHTML = `<div style="padding:12px;color:#b00;">Unknown resource type: ${resolvedPath}</div>`;
  }

  // ========== Token formatter ==========

  /**
   * Replace tokens like a0,a1,... b0,b1,... c0,c1,... using rows per level.
   * rowsByLevel[0] -> 'a*', rowsByLevel[1] -> 'b*', etc.
   */
  #resolvePattern(pattern, rowsByLevel) {
    return pattern.replace(/([a-z])(\d+)/ig, (_m, letter, idxStr) => {
      const level = letter.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
      const colIdx = parseInt(idxStr, 10) || 0;
      const row = rowsByLevel[level];
      if (!row || colIdx < 0 || colIdx >= row.length) return '';
      return String(row[colIdx]).replaceAll('/', '_').replaceAll('\\', '_').trim();
    });
  }

  // ========== Utilities ==========

  async #copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      if (this.debug) console.log('[MultiDrilldown] copied:', text);
    } catch (e) {
      if (this.debug) console.warn('Clipboard failed:', e);
    }
  }
}
