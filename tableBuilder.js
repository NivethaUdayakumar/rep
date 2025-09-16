// tableBuilder.js
// Minimal, dependency-free table with:
// - CSV parsing
// - Optional grouping by columns (0-based)
// - Optional status coloring (running/completed/failed) for statusIdx columns
// - Optional 'promote' buttons if promoteIdx columns contain "yes"
// - Double LEFT click handler (onCellDblClick)
// - Double RIGHT click handler (onCellRightDblClick -> copies text) handled here & bubbled up
// - Posts to /api/promote to update data/summary.json (Node endpoint should handle it)

export class TableBuilder {
  constructor({
    dataCsv,
    box = '#grid',
    name = 'grid',
    groupByIdx = [],
    statusIdx = [],
    promoteIdx = null,      // number[] | null (columns that can show "promote" button if value is "yes")
    promoteCheck = null,    // number[] | null
    promoteData = null,     // number[] | null
    promoteEndpoint = '/api/promote',
    debug = false,
    onCellDblClick = null,
    onCellRightDblClick = null,
  } = {}) {
    Object.assign(this, {
      dataCsv, box, name, groupByIdx, statusIdx,
      promoteIdx, promoteCheck, promoteData, promoteEndpoint,
      debug, onCellDblClick, onCellRightDblClick
    });
  }

  async build() {
    const dataTxt = await this.#fetchText(this.dataCsv);
    const { headers, rows } = this.#parseCSV(dataTxt);

    const host = this.#q(this.box);
    if (!host) throw new Error(`Container not found: ${this.box}`);
    host.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'tb-grid';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Apple Color Emoji","Segoe UI Emoji"';

    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    headers.forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      Object.assign(th.style, {
        position: 'sticky', top: '0', background: '#fafafa',
        borderBottom: '1px solid #ddd', padding: '8px', textAlign: 'left'
      });
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    // Optional grouping: parent row = last row per group; children inherit color of parent
    const groups = this.#groupRows(rows, this.groupByIdx);

    groups.forEach((g, groupIdx) => {
      const parentColor = groupIdx % 2 === 0 ? '#eef6ff' : '#f3f4f6'; // even=light blue, odd=light grey
      g.forEach((rowArr, rowIdxInGroup) => {
        const tr = document.createElement('tr');
        tr.dataset.group = String(groupIdx);
        tr.style.background = parentColor;

        rowArr.forEach((val, colIdx) => {
          const td = document.createElement('td');
          td.style.borderBottom = '1px solid #eee';
          td.style.padding = '6px 8px';
          td.style.whiteSpace = 'nowrap';

          // Status coloring (by content)
          if (this.statusIdx?.includes(colIdx)) {
            const v = String(val).toLowerCase();
            if (v.includes('running')) {
              td.style.color = '#0b5';
              td.title = 'running';
              td.appendChild(this.#spinner());
              td.append(' ' + val);
            } else if (v.includes('completed')) {
              td.style.color = '#0a0';
              td.title = 'completed';
              td.textContent = val;
            } else if (v.includes('failed') || v.includes('error')) {
              td.style.color = '#c00';
              td.title = 'failed';
              td.textContent = val;
            } else {
              td.textContent = val;
            }
          } else if (this.promoteIdx?.includes(colIdx)) {
            // Promote button if cell says "yes"
            if (String(val).trim().toLowerCase() === 'yes') {
              const btn = document.createElement('button');
              btn.textContent = 'promote';
              Object.assign(btn.style, {
                padding: '4px 8px', borderRadius: '8px', cursor: 'pointer', border: '1px solid #bbb'
              });
              btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.#doPromote(headers, rowArr);
              });
              td.appendChild(btn);
            } else {
              td.textContent = '';
            }
          } else {
            td.textContent = val;
          }

          // Double LEFT click -> callback
          td.addEventListener('dblclick', (ev) => {
            if (typeof this.onCellDblClick === 'function') {
              this.onCellDblClick(ev, {
                headers, rowArr, col: colIdx, value: val
              });
            }
          });

          // Double RIGHT click -> copy cell content
          this.#attachRightDoubleClick(td, String(val), (ev) => {
            if (typeof this.onCellRightDblClick === 'function') {
              this.onCellRightDblClick(ev, {
                headers, rowArr, col: colIdx, value: val
              });
            }
          });

          tr.appendChild(td);
        });

        tbody.appendChild(tr);
      });
    });

    table.appendChild(tbody);
    host.appendChild(table);

    // Auto-size columns after paint
    requestAnimationFrame(() => {
      this.#autosize(table);
    });
  }

  // ========== Promote ==========

  async #doPromote(headers, rowArr) {
    try {
      const keyParts = (this.promoteCheck ?? []).map(i => rowArr[i]);
      const key = keyParts.length <= 1 ? String(keyParts[0] ?? '') : keyParts.join('_');

      const data = Object.fromEntries(
        (this.promoteData ?? []).map(i => [headers[i] ?? `col${i}`, rowArr[i]])
      );

      const body = { key, data, headers, row: rowArr };
      const resp = await fetch(this.promoteEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const out = await resp.json().catch(() => ({}));
      if (this.debug) console.log('[promote] success', out);
      this.#toast('Promoted.');
    } catch (e) {
      console.error('[promote] failed', e);
      this.#toast('Promote failed', true);
    }
  }

  // ========== Helpers ==========

  #q(sel) { return document.querySelector(sel); }

  async #fetchText(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    return await r.text();
  }

  #parseCSV(text) {
    // Robust-enough CSV parser for quotes/commas/newlines
    const rows = [];
    let i = 0, field = '', row = [], inQ = false;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };

    while (i < text.length) {
      const ch = text[i];

      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        } else { field += ch; i++; continue; }
      } else {
        if (ch === '"') { inQ = true; i++; continue; }
        if (ch === ',') { pushField(); i++; continue; }
        if (ch === '\r') { i++; continue; }
        if (ch === '\n') { pushField(); pushRow(); i++; continue; }
        field += ch; i++; continue;
      }
    }
    // flush last
    pushField(); if (row.length > 1 || (row.length === 1 && row[0] !== '')) pushRow();

    if (rows.length === 0) return { headers: [], rows: [] };
    const headers = rows.shift();
    return { headers, rows };
  }

  #groupRows(rows, byIdx) {
    if (!byIdx || byIdx.length === 0) return rows.map(r => [r]); // no grouping, each row is its own group
    const key = (r) => byIdx.map(i => r[i]).join('||');
    const map = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    // parent = last row per group (you can change if desired)
    return Array.from(map.values());
  }

  #spinner() {
    const s = document.createElement('span');
    Object.assign(s.style, {
      display: 'inline-block', width: '10px', height: '10px',
      border: '2px solid #0b5', borderTopColor: 'transparent',
      borderRadius: '50%', marginRight: '4px',
      animation: 'tb-spin 0.8s linear infinite'
    });
    // add spin keyframes once
    if (!document.getElementById('tb-spin-style')) {
      const st = document.createElement('style');
      st.id = 'tb-spin-style';
      st.textContent = '@keyframes tb-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    return s;
  }

  #attachRightDoubleClick(td, text, bubbleCb) {
    // "Double right click" isn't native; emulate with two contextmenu events close in time.
    let lastTime = 0;
    td.addEventListener('contextmenu', async (ev) => {
      ev.preventDefault();
      const now = performance.now();
      if (now - lastTime < 400) {
        try {
          await navigator.clipboard.writeText(text ?? '');
          this.#toast('Copied.');
          if (typeof bubbleCb === 'function') bubbleCb(ev);
        } catch (e) {
          console.warn('Copy failed', e);
        }
      }
      lastTime = now;
    });
  }

  #autosize(table) {
    const cols = table.querySelectorAll('tr:first-child th');
    const rows = table.querySelectorAll('tbody tr');
    cols.forEach((th, colIdx) => {
      let max = th.textContent.length;
      rows.forEach(tr => {
        const td = tr.children[colIdx];
        if (!td) return;
        const len = (td.textContent || '').length;
        if (len > max) max = len;
      });
      // Approx width: chars * 8 + padding
      const px = Math.min(480, Math.max(80, max * 8 + 24));
      th.style.minWidth = px + 'px';
      th.style.maxWidth = px + 'px';
    });
  }

  #toast(msg, isErr = false) {
    const d = document.createElement('div');
    d.textContent = msg;
    Object.assign(d.style, {
      position: 'fixed', right: '16px', bottom: '16px',
      background: isErr ? '#fee2e2' : '#ecfeff',
      color: isErr ? '#991b1b' : '#075985',
      border: '1px solid ' + (isErr ? '#fecaca' : '#bae6fd'),
      borderRadius: '10px', padding: '8px 12px', zIndex: 100000,
      boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial'
    });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1400);
  }
}
