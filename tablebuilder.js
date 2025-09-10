// TableBuilder (no popups)
// - Grouping: parent = last row per group; children inherit parent's shade
// - Row shading: odd parents = light grey, even parents = light blue
// - Auto-size columns to fit content (header + all rows), still resizable
// - Status coloring on cells (completed / running / failed) + spinner for "running"
// - Sortable, searchable, columns show/hide, footer
// - Icon buttons: show per configured columns when predicate is true; callback on click
export class TableBuilder {
  constructor({
    dataCsv,
    box = '#grid',
    name = 'grid',
    groupByIdx = [],
    statusIdx = null,
    colorColsIdx = [],
    // Icon button config (0-based column indexes)
    iconColsIdx = [],
    iconShowIf = (v) => /^(yes|y|true|1)$/i.test(String(v ?? '')),
    onIconClick = () => {}
  } = {}) {
    Object.assign(this, {
      dataCsv, box, name, groupByIdx, statusIdx, colorColsIdx,
      iconColsIdx, iconShowIf, onIconClick
    });
  }

  async build() {
    const dataTxt = await this.#fetchText(this.dataCsv);
    const { h: hdr, rows: data } = this.#parseCSV(dataTxt);
    const fields = hdr.map(this.#fkey);

    // --- auto-size widths from content ---
    const colPx = this.#computeAutoWidths(hdr, data);

    // columns (sortable + searchable) with icon + status coloring
    const columns = hdr.map((lab, i) => ({
      field: fields[i],
      text: lab,
      size: `${colPx[i]}px`,
      resizable: true,
      sortable: true,
      searchable: 'text',
      render: (rec) => {
        const raw = rec[fields[i]] ?? '';

        // 1) ICON BUTTON FIRST (so colorize can't short-circuit it)
        if (this.iconColsIdx?.includes(i)) {
          const show = this.iconShowIf(raw, rec, i, fields[i]);
          if (show) {
            return `<button
                      class="tb-icon-btn"
                      type="button"
                      data-recid="${rec.recid}"
                      data-col="${i}"
                      title="Action">
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path d="M12 17.3l-5.4 3 1-5.9L3 9.8l6-.9L12 3l3 5.9 6 .9-4.6 4.6 1 5.9z"></path>
                      </svg>
                    </button>`;
          }
          return '';
        }

        // 2) STATUS COLORING (only for targeted columns; else null)
        const colored = this.#colorize(rec, fields[i], i);
        if (colored != null) return colored;

        // 3) DEFAULT
        return this.#esc(raw);
      }
    }));

    // flatten CSV
    const flat = data.map((r, i) => {
      const o = { recid: i + 1, __row: i };
      hdr.forEach((_, j) => (o[fields[j]] = r[j] ?? ''));
      return o;
    });

    // optional grouping (parent = LAST row per group)
    let parents = flat;
    if (this.#validGroup(hdr)) {
      const key = rc => this.groupByIdx.map(i => rc[fields[i]]).join(' | ');
      const mp = new Map();
      flat.forEach(rc => {
        const k = key(rc);
        (mp.get(k) || mp.set(k, []).get(k)).push(rc);
      });

      parents = [];
      for (const [, arr] of mp) {
        const p = arr[arr.length - 1];
        const kids = arr.slice(0, -1).map((r, j) => ({ ...r, recid: p.recid + '-c' + (j + 1) }));
        if (kids.length) p.w2ui = { children: kids };
        parents.push(p);
      }
    }

    // row shading: alternate over PARENT rows; children copy parent bg
    const ODD = '#f2f4f7';   // light grey
    const EVEN = '#e6f0ff';  // light blue
    if (this.#validGroup(hdr)) {
      parents.forEach((p, idx) => {
        const bg = (idx % 2 === 0) ? ODD : EVEN;
        p.w2ui = { ...(p.w2ui || {}), style: `background-color:${bg}` };
        const kids = p.w2ui.children || [];
        kids.forEach(k => { k.w2ui = { ...(k.w2ui || {}), style: `background-color:${bg}` }; });
      });
    } else {
      parents.forEach((r, idx) => {
        const bg = (idx % 2 === 0) ? ODD : EVEN;
        r.w2ui = { ...(r.w2ui || {}), style: `background-color:${bg}` };
      });
    }

    // build grid
    if (w2ui[this.name]) w2ui[this.name].destroy();
    new w2grid({
      name: this.name,
      box: this.box,
      columns,
      searches: columns.map(c => ({ field: c.field, label: c.text, type: 'text' })),
      records: parents,
      show: {
        toolbar: true,
        toolbarSearch: true,
        toolbarColumns: true,
        footer: true,
        expandColumn: false
      },
      multiSearch: true,
      sortData: columns[0] ? [{ field: columns[0].field, direction: 'asc' }] : []
    });

    // wire delegated click handler for icon buttons
    const grid = w2ui[this.name];
    if (grid?.box) {
      grid.box.addEventListener('click', (evt) => {
        const btn = evt.target.closest('button.tb-icon-btn');
        if (!btn) return;

        const recid = btn.getAttribute('data-recid');
        const colIdx = Number(btn.getAttribute('data-col'));
        const rec = grid.get(recid);

        const keys = Object.keys(rec).filter(k => k !== 'recid' && k !== '__row');
        const field = keys[colIdx];
        const value = rec[field];

        try {
          this.onIconClick({
            event: evt,
            grid,
            rec,
            recid,
            colIdx,
            field,
            value,
            rowIndex: rec.__row
          });
        } catch (e) {
          console.error('onIconClick error:', e);
        }
      }, { passive: true });
    }
  }

  /* ============================== Helpers ============================== */

  // Compute pixel width per column using canvas text metrics
  #computeAutoWidths(headers, rows) {
    const FONT = '13px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    const PAD  = 32;
    const MIN  = 80;
    const MAX  = 480;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = FONT;

    const measure = (s) => Math.ceil(ctx.measureText(String(s ?? '')).width);
    const maxes = headers.map(h => measure(h));

    rows.forEach(r => {
      for (let c = 0; c < headers.length; c++) {
        const w = measure(r[c] ?? '');
        if (w > maxes[c]) maxes[c] = w;
      }
    });

    return maxes.map(w => Math.max(MIN, Math.min(MAX, w + PAD)));
  }

  async #fetchText(path) {
    try {
      const res = await fetch(path);
      if (!res?.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  #validGroup(hdr) {
    return Array.isArray(this.groupByIdx)
        && this.groupByIdx.length
        && this.groupByIdx.every(i => i >= 0 && i < hdr.length);
  }

  #colorize(rec, fieldName, colIdx) {
    if (this.statusIdx == null) return null;
    const v = rec[fieldName] ?? '';
    const st = (rec[this.#fkeyIndex(this.statusIdx, rec)]
             ?? (rec[Object.keys(rec)[this.statusIdx + 1]]))?.toString().toLowerCase();

    // Only color targeted columns; otherwise let caller continue (return null)
    if (!this.colorColsIdx?.includes(colIdx) && colIdx !== this.statusIdx) return null;

    const cls = st === 'failed' ? 'tb-failed'
              : st === 'running' ? 'tb-running'
              : st === 'completed' ? 'tb-completed' : '';
    const spin = (colIdx === this.statusIdx && st === 'running') ? '<span class="tb-loader"></span>' : '';
    return `<span class="tb-cell ${cls}">${this.#esc(v)}${spin}</span>`;
  }

  #fkeyIndex(i, rec) {
    const keys = Object.keys(rec).filter(k => k !== 'recid' && k !== '__row');
    return keys[i];
  }

  #parseCSV(t) {
    const lines = (t ?? '').trim().split(/\r?\n/);
    const hdr = (lines.shift() || '').split(',').map(s => s.trim());
    const rows = lines.filter(Boolean).map(l => l.split(',').map(s => s.trim()));
    return { h: hdr, rows };
  }

  #fkey(h) { return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
  #esc(s) { return (s + '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
}
