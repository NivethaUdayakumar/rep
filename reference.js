_applyColumnTypes(grid, step) {
  if (!grid || !Array.isArray(grid.columns)) return;

  const isMain = step == null;
  const cfgBase = isMain ? this.columnTypesMain : (this.columnTypesByStep?.[step] || {});
  if (!cfgBase || typeof cfgBase !== 'object') return;

  grid.searches = Array.isArray(grid.searches) ? grid.searches : [];
  grid.multiSearch = true;

  const cols = grid.columns;
  const recs = grid.records || [];

  const findCol = (keyRaw) => {
    if (typeof keyRaw === 'number' || /^[0-9]+$/.test(String(keyRaw))) {
      const idx = Number(keyRaw);
      return cols[idx];
    }
    const key = String(keyRaw).toLowerCase();
    return cols.find(c =>
      String(c.field || '').toLowerCase() === key ||
      String(c.text || c.caption || '').toLowerCase() === key
    );
  };

  Object.entries(cfgBase).forEach(([key, typeSpec]) => {
    const col = findCol(key);
    if (!col || !col.field) return;
    const field = col.field;

    const rawType = String(typeSpec || '').toLowerCase();
    const w2type = this._normalizeSearchType(typeSpec);
    if (!w2type) return;

    col.searchable = true;

    let s = grid.searches.find(x => x.field === field);
    const caption = col.text || col.caption || field;
    if (!s) {
      s = { field, caption, type: w2type };
      grid.searches.push(s);
    } else {
      s.type = w2type;
      if (!s.caption) s.caption = caption;
    }

    // numeric operators
    if (w2type === 'float' || w2type === 'int') {
      s.operators = [
        'is',
        'between',
        'more',
        'less',
        'more equal',
        'less equal',
        'null',
        'not null'
      ];
    }

    // datetime / EU datetime operators
    if (w2type === 'date' || w2type === 'datetime') {
      s.operators = ['is', 'between'];

      // tell w2ui how to parse your Python strftime
      // e.g. 2025-11-27 13:45:00  => '%Y-%m-%d %H:%M:%S'
      s.options = s.options || {};
      if (rawType === 'eu-datetime' || rawType === 'eu_datetime') {
        // full datetime format
        s.options.format = 'yyyy-mm-dd|hh24:mm:ss';
      } else {
        // plain date if you ever need it
        s.options.format = s.options.format || 'yyyy-mm-dd';
      }
    }

    // string => enum multi select
    if (w2type === 'enum') {
      const set = new Set();
      for (const r of recs) {
        const v = r[field];
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          set.add(String(v));
        }
      }
      const items = Array.from(set).sort();
      s.options = s.options || {};
      s.options.items = items;
      s.options.openOnFocus = true;
      s.options.style = 'width: 260px; max-width: 100%; box-sizing: border-box;';

      s.operators = [
        'in',
        'not in',
        'contains',
        'not contains'
      ];
    }
  });
}

// normalize
_normalizeSearchType(spec) {
  const s = String(spec || '').toLowerCase();
  if (['float', 'number', 'numeric', 'double'].includes(s)) return 'float';
  if (['int', 'integer'].includes(s)) return 'int';
  if (['date'].includes(s)) return 'date';
  if (['datetime', 'eu-datetime', 'eu_datetime'].includes(s)) return 'datetime';
  if (['string', 'text'].includes(s)) return 'enum'; // for string multi-select
  if (['enum'].includes(s)) return 'enum';
  return null;
}

// css fix
/* Make enum dropdown follow its parent scroll container */
.w2ui-field-helper.w2ui-list {
  position: absolute !important;
}

/* Ensure helper is clipped inside popup/grid */
.w2ui-popup .w2ui-field-helper.w2ui-list {
  position: absolute !important;
  z-index: 9999; /* stay above cells but still inside popup */
}

