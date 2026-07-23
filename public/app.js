'use strict';

/* ===========================================================================
   Virgo ACP IMS — client SPA.
   Talks to the Express API over fetch; the session lives in an httpOnly cookie
   set by the server, so there is no token to manage in the browser.
   =========================================================================== */

var SESSION = null;

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ------------------------------ fetch helpers --------------------------- */
async function api(path, opts) {
  var res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  }, opts || {}));

  var body = {};
  try { body = await res.json(); } catch (e) { body = {}; }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      if (path !== '/api/login' && path !== '/api/session') {
        toast('error', 'Session expired. Redirecting to login...');
        setTimeout(function () {
          window.location.reload();
        }, 1500);
      }
    }
    var err = new Error(body.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return body;
}
function apiGet(path) { return api(path, { method: 'GET' }); }
function apiPost(path, data) { return api(path, { method: 'POST', body: JSON.stringify(data || {}) }); }

/* Coalesce rapid-fire events (e.g. keystrokes in a search box) into a single
   trailing call, so we re-render a large table once the user pauses instead of
   on every character. Keeps typing snappy on the big cross-branch ledgers. */
function debounce(fn, wait) {
  var t;
  return function () {
    var ctx = this, args = arguments;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(ctx, args); }, wait == null ? 120 : wait);
  };
}

/* ------------------------------ UI helpers ------------------------------ */
// Dynamic-island toast; replaces browser alert() everywhere.
function toast(type, msg) {
  var wrap = document.getElementById('toasts');
  if (!wrap) { alert(msg); return; }
  var icons = { success: 'ph-check-circle', error: 'ph-x-circle', info: 'ph-info' };
  var el = document.createElement('div');
  el.className = 'toast t-' + type;
  el.innerHTML = '<i class="ph ' + (icons[type] || icons.info) + '"></i><div class="toast-msg"></div><span class="toast-x"><i class="ph ph-x"></i></span>';
  el.querySelector('.toast-msg').textContent = msg;
  var gone = false;
  function dismiss() {
    if (gone) return;
    gone = true;
    el.style.animation = 'toastOut 0.25s var(--ease-out) forwards';
    setTimeout(function () { el.remove(); }, 260);
  }
  el.querySelector('.toast-x').addEventListener('click', dismiss);
  wrap.appendChild(el);
  setTimeout(dismiss, 4200);
}

// Material-style ripple on every .btn (CSS .ripple already defined).
function wireRipples() {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn');
    if (!btn || btn.disabled) return;
    var rect = btn.getBoundingClientRect();
    var d = Math.max(rect.width, rect.height);
    var s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = d + 'px';
    s.style.left = (e.clientX - rect.left - d / 2) + 'px';
    s.style.top = (e.clientY - rect.top - d / 2) + 'px';
    btn.appendChild(s);
    setTimeout(function () { s.remove(); }, 600);
  });
}

/* Modal overlays: animated open/close, click-outside and Esc to dismiss. */
function openModal(id) {
  var o = document.getElementById(id);
  o.classList.remove('closing');
  o.style.display = 'flex';
}
var _confirmCallback = null;
function appConfirm(message, callback) {
  _confirmCallback = callback;
  var msgEl = document.getElementById('app-confirm-message');
  if (msgEl) msgEl.textContent = message;
  openModal('app-confirmOverlay');
}

function closeModal(id) {
  var o = document.getElementById(id);
  if (!o || o.style.display === 'none') return;
  o.classList.add('closing');
  setTimeout(function () {
    o.style.display = 'none';
    o.classList.remove('closing');
  }, 200);
}
function wireModals() {
  var confirmCancel = document.getElementById('app-confirm-cancel');
  if (confirmCancel) {
    confirmCancel.addEventListener('click', function () {
      closeModal('app-confirmOverlay');
      _confirmCallback = null;
    });
  }
  var confirmOk = document.getElementById('app-confirm-ok');
  if (confirmOk) {
    confirmOk.addEventListener('click', function () {
      closeModal('app-confirmOverlay');
      if (_confirmCallback) {
        _confirmCallback();
        _confirmCallback = null;
      }
    });
  }

  document.querySelectorAll('.overlay').forEach(function (o) {
    o.addEventListener('click', function (e) {
      if (e.target === o) closeModal(o.id);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.overlay').forEach(function (o) {
      if (o.style.display !== 'none') closeModal(o.id);
    });
  });
}

function skeletonBlock(height) {
  return '<div class="skeleton" style="height:' + (height || 120) + 'px; margin:16px; border-radius:12px;"></div>';
}

function updateDatalist(datalistId, rows, key) {
  var datalist = document.getElementById(datalistId);
  if (!datalist) return;
  datalist.innerHTML = '';
  var uniqueValues = Array.from(new Set(rows.map(function (r) { return r[key]; }))).sort();
  uniqueValues.forEach(function (val) {
    if (val === null || val === undefined || String(val).trim() === '') return;
    var opt = document.createElement('option');
    opt.value = val;
    datalist.appendChild(opt);
  });
}

// Neutralize CSV/spreadsheet formula injection: a cell beginning with = + - @
// (or a leading tab / carriage return) is treated as a formula by Excel/Sheets.
// User-entered fields (notes, item names, batches) flow into exports, so prefix
// such cells with a single quote to force them to render as literal text.
function _csvSafeCell(val) {
  var s = String(val === null || val === undefined ? '' : val);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  return s;
}

function exportToCSV(filename, headers, rows, mappingFn) {
  var csvContent = [headers.join(',')];
  rows.forEach(function (r) {
    var rowValues = mappingFn(r).map(function (val) {
      var clean = _csvSafeCell(val).replace(/"/g, '""');
      return clean.indexOf(',') !== -1 || clean.indexOf('"') !== -1 || clean.indexOf('\n') !== -1
        ? '"' + clean + '"'
        : clean;
    });
    csvContent.push(rowValues.join(','));
  });
  var blob = new Blob([csvContent.join('\n')], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  if (link.download !== undefined) {
    var url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

// Quote-safe CSV parser: returns an array of rows, each an array of cell
// strings. Handles quoted fields, escaped "" quotes, and \n / \r\n / lone \r
// line endings. Replaces the old naive line.split(',') which broke on any
// value containing a comma.
function parseCsvText(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      if (text[i + 1] !== '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) {
    return r.some(function (cell) { return String(cell).trim() !== ''; });
  });
}

// ₹ formatter (Indian grouping, no decimals). Negative keeps the sign.
function formatMoney(n) {
  var num = Number(n || 0);
  var sign = num < 0 ? '-' : '';
  return sign + '₹' + Math.abs(num).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Shared renderer for the bulk-reconciliation upload result. Returns true on a
// clean save, false when the server reported per-line validation errors.
function renderBulkReconResult(el, res) {
  if (res.success === false && Array.isArray(res.errors) && res.errors.length) {
    var more = res.totalErrors > res.errors.length
      ? '<div>…and ' + (res.totalErrors - res.errors.length) + ' more.</div>' : '';
    el.innerHTML = '<div style="color:var(--danger)">Nothing was saved — fix these and re-upload the whole file:</div>'
      + '<div style="max-height:160px; overflow-y:auto; margin-top:6px;">'
      + res.errors.map(function (e) { return '<div>• ' + esc(e) + '</div>'; }).join('') + more + '</div>';
    return false;
  }
  el.innerHTML = '<span style="color:var(--green)">Saved ' + res.count + ' reconciliations.</span>';
  return true;
}

/* ------------------------- ITEM-WISE VARIANCE REPORT -------------------------
   Shared across the Admin (prefix 'ad') and Branch (prefix 'br') audit pages.
   Compares the latest physical count per branch+item+batch against the live
   ledger. Elements are keyed `{prefix}-vr-*`. --------------------------------- */
var VarianceReport = {
  data: {},
  filtered: {},

  // Applying adjustments is Admin/Super Admin only. The admin audit page uses
  // prefix 'ad' and is only ever shown to admins, so gate the apply UI on that.
  canAdjust: function (p) {
    return p === 'ad' && SESSION && (SESSION.role === 'SUPER_ADMIN' || SESSION.role === 'ADMIN');
  },

  init: function (p) {
    var search = document.getElementById(p + '-vr-search');
    if (search) search.addEventListener('input', debounce(function () { VarianceReport.applyFilters(p); }));
    var disc = document.getElementById(p + '-vr-discOnly');
    if (disc) disc.addEventListener('change', function () { VarianceReport.applyFilters(p); });
    var bf = document.getElementById(p + '-vr-branchFilter');
    if (bf) bf.addEventListener('change', function () { VarianceReport.applyFilters(p); });
    var refresh = document.getElementById(p + '-vr-refresh');
    if (refresh) refresh.addEventListener('click', function () { VarianceReport.load(p); });
    var exp = document.getElementById(p + '-vr-export');
    if (exp) exp.addEventListener('click', function () { VarianceReport.exportCsv(p); });
    var applyAll = document.getElementById(p + '-vr-applyAll');
    if (applyAll) applyAll.addEventListener('click', function () { VarianceReport.applyAll(p); });

    // Delegated Apply-per-row handler.
    var wrap = document.getElementById(p + '-vr-tableWrap');
    if (wrap) {
      wrap.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.vr-apply-btn') : null;
        if (!btn) return;
        var idx = Number(btn.getAttribute('data-idx'));
        var row = (VarianceReport.filtered[p] || [])[idx];
        if (row) VarianceReport.applyOne(p, row, btn);
      });
    }
  },

  load: function (p) {
    var wrap = document.getElementById(p + '-vr-tableWrap');
    if (!wrap) return;
    wrap.innerHTML = skeletonBlock(80);
    apiGet('/api/variance-report')
      .then(function (res) {
        VarianceReport.data[p] = res.rows || [];
        VarianceReport.renderSummary(p, res.summary || {});
        VarianceReport.populateBranchFilter(p);
        VarianceReport.applyFilters(p);
      })
      .catch(function (err) {
        wrap.innerHTML = '<div style="color:var(--danger); padding:12px;">Failed to load variance report: ' + esc(err.message) + '</div>';
      });
  },

  populateBranchFilter: function (p) {
    var bf = document.getElementById(p + '-vr-branchFilter');
    if (!bf) return;
    var codes = Array.from(new Set((VarianceReport.data[p] || []).map(function (r) { return r.branch_code; }))).sort();
    bf.innerHTML = '<option value="">All branches</option>'
      + codes.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    if (codes.indexOf('AHMEDABAD-FACTORY') !== -1) {
      bf.value = 'AHMEDABAD-FACTORY';
    }
  },

  currentFiltered: function (p) {
    var rows = VarianceReport.data[p] || [];
    var searchEl = document.getElementById(p + '-vr-search');
    var discEl = document.getElementById(p + '-vr-discOnly');
    var bfEl = document.getElementById(p + '-vr-branchFilter');
    var term = searchEl ? searchEl.value.trim().toLowerCase() : '';
    var discOnly = discEl ? discEl.checked : false;
    var branch = bfEl ? bfEl.value : '';
    return rows.filter(function (r) {
      if (discOnly && Math.round(r.variance) === 0) return false;
      if (branch && r.branch_code !== branch) return false;
      if (term) {
        var hay = (r.branch_code + ' ' + r.item_name + ' ' + (r.batch || '')).toLowerCase();
        if (hay.indexOf(term) === -1) return false;
      }
      return true;
    });
  },

  applyFilters: function (p) {
    var wrap = document.getElementById(p + '-vr-tableWrap');
    if (!wrap) return;
    var rows = VarianceReport.currentFiltered(p);
    VarianceReport.filtered[p] = rows;
    VarianceReport.renderTable(rows, p, wrap);
    var applyAll = document.getElementById(p + '-vr-applyAll');
    if (applyAll) {
      var discCount = rows.filter(function (r) { return Math.round(r.variance) !== 0; }).length;
      applyAll.style.display = (VarianceReport.canAdjust(p) && discCount > 0) ? '' : 'none';
      applyAll.innerHTML = '<i class="ph ph-check-circle"></i>Apply all shown (' + discCount + ')';
    }
  },

  renderSummary: function (p, s) {
    var el = document.getElementById(p + '-vr-summary');
    if (!el) return;
    function tile(label, value, color) {
      return '<div class="vr-tile"><div class="vr-tile-val" style="' + (color ? 'color:' + color + ';' : '') + '">' + value + '</div><div class="vr-tile-lbl">' + label + '</div></div>';
    }
    var hasVal = !(s.netValue === null || s.netValue === undefined);
    var netVal = hasVal ? formatMoney(s.netValue) : '—';
    var netColor = hasVal ? (s.netValue < 0 ? 'var(--danger)' : (s.netValue > 0 ? 'var(--accent)' : 'var(--green)')) : '';
    el.innerHTML =
      tile('Items with variance', (s.discrepancyCount || 0) + ' / ' + (s.itemCount || 0), '')
      + tile('Total shortage (units)', '−' + Math.round(s.totalShortage || 0), (s.totalShortage ? 'var(--danger)' : ''))
      + tile('Total surplus (units)', '+' + Math.round(s.totalSurplus || 0), (s.totalSurplus ? 'var(--accent)' : ''))
      + tile('Net value impact', netVal, netColor);
  },

  renderTable: function (rows, p, wrap) {
    if (!wrap) return;
    if (!rows.length) {
      wrap.innerHTML = emptyState('ph-scales', 'No variances to show', 'Nothing counted yet, or every counted item matches the ledger (try turning off “Discrepancies only”).');
      return;
    }
    var canAdjust = VarianceReport.canAdjust(p);
    var head = '<th scope="col">Branch</th><th scope="col">Item Name</th><th scope="col">Batch</th>'
      + '<th scope="col">Ledger</th><th scope="col">Physical</th><th scope="col">Variance</th>'
      + '<th scope="col">Var %</th><th scope="col">Value</th><th scope="col">Counted</th>'
      + (canAdjust ? '<th scope="col"></th>' : '');
    var rowStrings = rows.map(function (r, i) {
      var v = Math.round(r.variance);
      var vColor = v === 0 ? 'var(--green)' : (v < 0 ? 'var(--danger)' : 'var(--accent)');
      var vText = (v > 0 ? '+' : '') + v;
      var pct = (r.variance_pct === null || r.variance_pct === undefined)
        ? '—' : ((r.variance_pct > 0 ? '+' : '') + r.variance_pct.toFixed(1) + '%');
      var val = (r.variance_value === null || r.variance_value === undefined) ? '—' : formatMoney(r.variance_value);
      var when = r.counted_at ? new Date(r.counted_at).toLocaleDateString() : '—';
      var action = '';
      if (canAdjust) {
        action = v === 0
          ? '<td><span style="color:var(--green); font-size:12px;">✓ matched</span></td>'
          : '<td><button class="btn btn-primary btn-small vr-apply-btn" data-idx="' + i + '">Apply</button></td>';
      }
      return '<tr>'
        + '<td class="mono">' + esc(r.branch_code) + '</td>'
        + '<td class="mono">' + esc(displayItemName(r.item_name)) + '</td>'
        + '<td class="mono">' + esc(r.batch || '—') + '</td>'
        + '<td class="mono">' + Math.round(r.ledger_qty) + '</td>'
        + '<td class="mono">' + Math.round(r.physical_qty) + '</td>'
        + '<td class="mono" style="color:' + vColor + '; font-weight:700;">' + vText + '</td>'
        + '<td class="mono">' + pct + '</td>'
        + '<td class="mono">' + val + '</td>'
        + '<td>' + when + '</td>'
        + action
        + '</tr>';
    });
    var emptyHTML = emptyState('ph-scales', 'No variances to show', 'Nothing counted yet, or every counted item matches the ledger (try turning off “Discrepancies only”).');
    paintTable(wrap, '<table role="table" aria-label="Item-wise variance report">', '<tr>' + head + '</tr>', rowStrings, emptyHTML);
  },

  applyOne: function (p, row, btn) {
    appConfirm('Apply this adjustment? The ledger closing balance for ' + displayItemName(row.item_name)
      + (row.batch ? (' (batch ' + row.batch + ')') : '') + ' at ' + row.branch_code
      + ' will be corrected to the counted physical quantity of ' + Math.round(row.physical_qty) + '.', function () {
      if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
      apiPost('/api/variance/apply', { branchCode: row.branch_code, itemName: row.item_name, batch: row.batch })
        .then(function (res) {
          if (res.adjusted === false) toast('info', res.message || 'Already matches the ledger.');
          else toast('success', 'Ledger adjusted to match the physical count.');
          VarianceReport.load(p);
          // The ledger is now stale — refresh it if the admin view exposes it.
          if (typeof AdminView !== 'undefined' && AdminView.loadLedger) AdminView.loadLedger();
        })
        .catch(function (err) {
          toast('error', err.message);
          if (btn) { btn.disabled = false; btn.textContent = 'Apply'; }
        });
    });
  },

  applyAll: function (p) {
    var rows = (VarianceReport.filtered[p] || []).filter(function (r) { return Math.round(r.variance) !== 0; });
    if (!rows.length) { toast('info', 'No discrepancies to apply.'); return; }
    var keys = rows.map(function (r) { return { branchCode: r.branch_code, itemName: r.item_name, batch: r.batch }; });
    appConfirm('Apply adjustments for all ' + rows.length + ' shown discrepancies? Each ledger balance will be corrected to its counted physical quantity. This cannot be auto-undone (post a new count to change it).', function () {
      var btn = document.getElementById(p + '-vr-applyAll');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph ph-spinner spin"></i>Applying…'; }
      apiPost('/api/variance/apply-all', { keys: keys })
        .then(function (res) {
          toast('success', 'Applied ' + res.applied + ' adjustment' + (res.applied === 1 ? '' : 's') + '.');
          VarianceReport.load(p);
          if (typeof AdminView !== 'undefined' && AdminView.loadLedger) AdminView.loadLedger();
        })
        .catch(function (err) { toast('error', err.message); })
        .finally(function () { if (btn) { btn.disabled = false; } });
    });
  },

  exportCsv: function (p) {
    var rows = VarianceReport.currentFiltered(p);
    if (!rows.length) { toast('info', 'Nothing to export.'); return; }
    var headers = ['Branch', 'Item Name', 'Batch', 'Ledger Qty', 'Physical Qty', 'Variance', 'Variance %', 'Rate Per SQM', 'Value (INR)', 'Counted By', 'Counted At'];
    exportToCSV('variance_report.csv', headers, rows, function (r) {
      return [
        r.branch_code,
        displayItemName(r.item_name),
        r.batch,
        r.ledger_qty,
        r.physical_qty,
        r.variance,
        (r.variance_pct === null || r.variance_pct === undefined) ? '' : r.variance_pct.toFixed(1),
        (r.rate_per_sqm === null || r.rate_per_sqm === undefined) ? '' : r.rate_per_sqm,
        (r.variance_value === null || r.variance_value === undefined) ? '' : Math.round(r.variance_value),
        r.counted_by,
        r.counted_at ? new Date(r.counted_at).toLocaleString() : ''
      ];
    });
  }
};

function makeCustomSelect(selectId, options, placeholder) {
  var selectEl = document.getElementById(selectId);
  if (!selectEl) return;

  var wrapperId = selectId + '-custom-container';
  var wrapper = document.getElementById(wrapperId);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = wrapperId;
    wrapper.className = 'custom-select-container';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);
    
    selectEl.style.display = 'none';

    var trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    trigger.innerHTML = '<span class="custom-select-label">' + (placeholder || 'Select option...') + '</span><i class="ph ph-caret-down"></i>';
    wrapper.appendChild(trigger);

    var dropdown = document.createElement('div');
    dropdown.className = 'custom-select-dropdown';
    dropdown.style.display = 'none';
    
    var searchWrap = document.createElement('div');
    searchWrap.className = 'custom-select-search-wrap';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'custom-select-search';
    searchInput.placeholder = 'Search...';
    searchWrap.appendChild(searchInput);
    dropdown.appendChild(searchWrap);

    var optionsWrap = document.createElement('div');
    optionsWrap.className = 'custom-select-options';
    dropdown.appendChild(optionsWrap);
    
    wrapper.appendChild(dropdown);

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.custom-select-dropdown').forEach(function (d) {
        if (d !== dropdown) d.style.display = 'none';
      });
      document.querySelectorAll('.custom-select-container').forEach(function (c) {
        if (c !== wrapper) c.classList.remove('open');
      });
      var isOpen = dropdown.style.display === 'block';
      dropdown.style.display = isOpen ? 'none' : 'block';
      if (isOpen) {
        wrapper.classList.remove('open');
      } else {
        wrapper.classList.add('open');
        searchInput.value = '';
        filterOptions('');
        searchInput.focus();
      }
    });

    document.addEventListener('click', function () {
      dropdown.style.display = 'none';
      wrapper.classList.remove('open');
    });

    searchInput.addEventListener('input', function () {
      filterOptions(searchInput.value);
    });
    searchInput.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  var optionsWrap = wrapper.querySelector('.custom-select-options');
  var searchInput = wrapper.querySelector('.custom-select-search');
  var labelSpan = wrapper.querySelector('.custom-select-label');

  function renderOptions(filteredOpts) {
    optionsWrap.innerHTML = '';
    
    filteredOpts.forEach(function (opt) {
      var item = document.createElement('div');
      item.className = 'custom-select-option';
      if (selectEl.value === opt.value) {
        item.classList.add('selected');
        labelSpan.textContent = opt.text;
      }
      item.textContent = opt.text;
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        selectEl.value = opt.value;
        
        var evt = document.createEvent('HTMLEvents');
        evt.initEvent('change', true, true);
        selectEl.dispatchEvent(evt);
        
        wrapper.querySelectorAll('.custom-select-option').forEach(function (el) {
          el.classList.remove('selected');
        });
        item.classList.add('selected');
        labelSpan.textContent = opt.text;
        dropdown.style.display = 'none';
        wrapper.classList.remove('open');
      });
      optionsWrap.appendChild(item);
    });

    if (filteredOpts.length === 0) {
      var noResult = document.createElement('div');
      noResult.className = 'custom-select-no-results';
      noResult.textContent = 'No matching options';
      optionsWrap.appendChild(noResult);
    }
  }

  function filterOptions(term) {
    var filtered = options.filter(function (opt) {
      return opt.text.toLowerCase().indexOf(term.toLowerCase()) !== -1;
    });
    renderOptions(filtered);
  }

  renderOptions(options);

  var selectedOpt = options.find(function (opt) { return opt.value === selectEl.value; });
  if (selectedOpt) {
    labelSpan.textContent = selectedOpt.text;
  } else {
    labelSpan.textContent = placeholder || 'Select option...';
  }

  return {
    setValue: function (val) {
      selectEl.value = val;
      var opt = options.find(function (o) { return o.value === val; });
      if (opt) {
        labelSpan.textContent = opt.text;
        renderOptions(options);
      } else {
        labelSpan.textContent = placeholder || 'Select option...';
      }
    },
    updateOptions: function (newOpts) {
      options = newOpts;
      renderOptions(options);
      var selectedOpt = options.find(function (opt) { return opt.value === selectEl.value; });
      if (selectedOpt) {
        labelSpan.textContent = selectedOpt.text;
      } else {
        labelSpan.textContent = placeholder || 'Select option...';
      }
    }
  };
}

function emptyState(icon, title, text) {
  return '<div class="empty"><i class="ph ' + icon + '"></i><h3>' + title + '</h3><p>' + text + '</p></div>';
}

/* ------------------------------ view switching -------------------------- */
function showView(id) {
  var views = document.querySelectorAll('.app-view');
  for (var i = 0; i < views.length; i++) views[i].style.display = 'none';
  var el = document.getElementById(id);
  el.style.display = el.classList.contains('shell') ? 'flex' : 'block';
}

async function logout() {
  try { await apiPost('/api/logout'); } catch (e) { /* ignore */ }
  window.location.reload();
}

/* ------------------------------ sidebar chrome --------------------------- */
function wireLogout() {
  var btns = document.querySelectorAll('.logout-btn');
  for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', logout);
}

// Click the brand block to collapse/expand that shell's sidebar.
function wireSidebarToggles() {
  document.querySelectorAll('.sb-brand').forEach(function (brand) {
    brand.addEventListener('click', function () {
      var sb = brand.closest('.sb');
      if (sb) sb.classList.toggle('col');
    });
  });
}

// Nav items switch pages: only content sections whose data-page matches the
// clicked item are shown; everything else in that view's content is hidden.
function wireSidebarNav() {
  document.querySelectorAll('.app-view.shell').forEach(function (view) {
    var items = view.querySelectorAll('.sb-nav .ni[data-page]');
    if (items.length === 0) return;

    function showPage(page) {
      function updateDOM() {
        view.querySelectorAll('.content [data-page]').forEach(function (el) {
          var match = el.getAttribute('data-page') === page;
          el.style.display = match ? '' : 'none';
          el.classList.remove('page-anim');
          if (match) {
            void el.offsetWidth; // restart the entrance animation
            el.classList.add('page-anim');
          }
        });
        var contentEl = view.querySelector('.content');
        if (contentEl) contentEl.scrollTop = 0;
      }

      if (document.startViewTransition) {
        document.startViewTransition(updateDOM);
      } else {
        updateDOM();
      }
    }

    items.forEach(function (item) {
      item.addEventListener('click', function () {
        items.forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        showPage(item.getAttribute('data-page'));
      });
    });

    var active = view.querySelector('.sb-nav .ni.active') || items[0];
    if (active) showPage(active.getAttribute('data-page'));
  });
}

// Clickable stat cards jump to their related page via the sidebar nav.
function wireStatGoto() {
  document.querySelectorAll('.stat-card.goto').forEach(function (card) {
    card.addEventListener('click', function () {
      var view = card.closest('.app-view');
      var ni = view && view.querySelector('.sb-nav .ni[data-page="' + card.getAttribute('data-goto') + '"]');
      if (ni) ni.click();
    });
  });
}

/* ------------------------------- theme ----------------------------------- */
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  document.querySelectorAll('.theme-toggle i').forEach(function (ic) {
    ic.className = theme === 'light' ? 'ph ph-moon' : 'ph ph-sun';
    ic.classList.remove('theme-ic-animate');
    void ic.offsetWidth;
    ic.classList.add('theme-ic-animate');
  });
}

// Light is the default; the user's choice persists in localStorage.
function initTheme() {
  var theme = 'light';
  try { theme = localStorage.getItem('ims_theme') || 'light'; } catch (e) { /* ignore */ }
  applyTheme(theme);
  document.querySelectorAll('.theme-toggle').forEach(function (btn) {
    btn.addEventListener('click', function (event) {
      var next = document.body.classList.contains('light') ? 'dark' : 'light';
      
      var x = window.innerWidth - 40;
      var y = 30;
      if (event && event.clientX !== undefined) {
        x = event.clientX;
        y = event.clientY;
      }
      
      if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyTheme(next);
        try { localStorage.setItem('ims_theme', next); } catch (e) { /* ignore */ }
        return;
      }
      
      document.documentElement.style.setProperty('--x', x + 'px');
      document.documentElement.style.setProperty('--y', y + 'px');
      document.documentElement.classList.add('theme-transition');
      
      var transition = document.startViewTransition(function () {
        applyTheme(next);
        try { localStorage.setItem('ims_theme', next); } catch (e) { /* ignore */ }
      });
      
      transition.finished.finally(function () {
        document.documentElement.classList.remove('theme-transition');
      });
    });
  });
}

// Fills the avatar initials + display name in a shell's sidebar footer.
function fillUserChrome(prefix) {
  if (!SESSION) return;
  var label = SESSION.fullName || SESSION.username || '?';
  var initials = label.trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
  var av = document.getElementById(prefix + '-avatar');
  var nameEl = document.getElementById(prefix + '-userName');
  if (av) av.textContent = initials;
  if (nameEl) nameEl.textContent = label;
}

/* ------------------------------ ledger table ----------------------------- */
// Items display by name without the "VIRGO " prefix everywhere in the UI.
function displayItemName(s) {
  return String(s || '').replace(/^\s*VIRGO\s+/i, '');
}

/* Progressive table paint. Writes the header + first chunk of rows to the DOM
   synchronously (instant first paint), then streams the remaining rows in
   requestAnimationFrame batches so a multi-thousand-row table never blocks the
   main thread while it parses/lays out. A newer paint on the same wrapper
   cancels any in-flight one, so fast filter typing can't leak stale rows.
   `rowStrings` is an array of <tr>… strings; `tableOpen` is the opening
   <table …> tag and `headHTML` the full <thead> inner markup. */
var _paintJobs = new WeakMap();
function paintTable(wrap, tableOpen, headHTML, rowStrings, emptyHTML) {
  var prev = _paintJobs.get(wrap);
  if (prev) { cancelAnimationFrame(prev); _paintJobs.delete(wrap); }

  if (!rowStrings.length) {
    wrap.innerHTML = emptyHTML ||
      emptyState('ph-magnifying-glass', 'No matching rows', 'Try a different search or filter.');
    return;
  }

  wrap.innerHTML = tableOpen + '<thead>' + headHTML + '</thead><tbody></tbody></table>';
  var tbody = wrap.querySelector('tbody');
  if (!tbody) return;

  var FIRST = 120;  // fills a viewport instantly
  var CHUNK = 200;  // per-frame batch thereafter
  tbody.insertAdjacentHTML('beforeend', rowStrings.slice(0, FIRST).join(''));
  var i = FIRST;
  if (i >= rowStrings.length) return;

  function step() {
    // A newer paint replaces the tbody (disconnecting this one) — bail out.
    if (!tbody.isConnected) { _paintJobs.delete(wrap); return; }
    var end = Math.min(i + CHUNK, rowStrings.length);
    tbody.insertAdjacentHTML('beforeend', rowStrings.slice(i, end).join(''));
    i = end;
    if (i < rowStrings.length) _paintJobs.set(wrap, requestAnimationFrame(step));
    else _paintJobs.delete(wrap);
  }
  _paintJobs.set(wrap, requestAnimationFrame(step));
}

// Shared by Branch/Admin/HOD stock-ledger panels.
function ledgerHeadHTML(showBranch) {
  return '<tr>' + (showBranch ? '<th scope="col">Branch</th>' : '')
    + '<th scope="col">Item Name</th><th scope="col">Batch</th><th scope="col">Opening</th><th scope="col">Inward</th><th scope="col">Sales Returns</th><th scope="col">Outward</th><th scope="col">Adjustment</th><th scope="col">Incoming Transit</th><th scope="col">Closing</th></tr>';
}
function ledgerRowHTML(r, showBranch) {
  var closing = Math.round(r.closing_qty);
  var inTransit = Math.round(r.in_transit_qty || 0);
  var salesReturns = Math.round(r.sales_return_qty || 0);
  var adjustment = Math.round(r.adjustment_qty || 0);
  var adjText = adjustment === 0 ? '0' : ((adjustment > 0 ? '+' : '') + adjustment);
  var adjCls = adjustment > 0 ? ' td-positive' : (adjustment < 0 ? ' td-negative' : '');
  return '<tr>'
    + (showBranch ? '<td class="mono">' + esc(r.branch_code) + '</td>' : '')
    + '<td class="mono">' + esc(displayItemName(r.item_name)) + '</td>'
    + '<td class="mono">' + esc(r.batch || '—') + '</td>'
    + '<td class="mono">' + Math.round(r.opening_qty) + '</td>'
    + '<td class="mono">' + Math.round(r.inward_qty) + '</td>'
    + '<td class="mono' + (salesReturns > 0 ? ' td-positive' : '') + '">' + salesReturns + '</td>'
    + '<td class="mono">' + Math.round(r.outward_qty) + '</td>'
    + '<td class="mono' + adjCls + '">' + adjText + '</td>'
    + '<td class="mono' + (inTransit > 0 ? ' td-positive' : '') + '">' + (inTransit > 0 ? ('<strong>' + inTransit + '</strong>') : inTransit) + '</td>'
    + '<td class="mono' + (closing < 0 ? ' td-negative' : (closing > 0 ? ' td-positive' : '')) + '"><strong>' + closing + '</strong></td>'
    + '</tr>';
}
// Progressive paint into a wrapper element (preferred for the live tables).
function paintLedger(wrap, rows, opts) {
  opts = opts || {};
  if (!wrap) return;
  var showBranch = !!opts.showBranch;
  var rowStrings = rows.map(function (r) { return ledgerRowHTML(r, showBranch); });
  paintTable(wrap, '<table role="table" aria-label="Stock ledger">',
    ledgerHeadHTML(showBranch), rowStrings, opts.emptyHTML);
}
// Kept: returns a full HTML string (used where a string, not a live paint, is
// needed). Live table panels use paintLedger for non-blocking rendering.
function renderLedgerRows(rows, opts) {
  opts = opts || {};
  var showBranch = !!opts.showBranch;
  if (rows.length === 0) {
    return emptyState('ph-magnifying-glass', 'No matching rows', 'Try a different search or filter, or add opening stock first.');
  }
  var body = rows.map(function (r) { return ledgerRowHTML(r, showBranch); }).join('');
  return '<table role="table" aria-label="Stock ledger"><thead>' + ledgerHeadHTML(showBranch) + '</thead><tbody>' + body + '</tbody></table>';
}

function filterLedgerRows(rows, term, opts) {
  opts = opts || {};
  term = (term || '').trim().toLowerCase();
  if (!term) return rows;
  return rows.filter(function (r) {
    return (r.item_name || '').toLowerCase().indexOf(term) !== -1
      || (r.batch || '').toLowerCase().indexOf(term) !== -1
      || (opts.showBranch && (r.branch_code || '').toLowerCase().indexOf(term) !== -1);
  });
}

/* ---------------------------- ORDER PLANNING ---------------------------- */

function gradeBadge(g) {
  if (!g) return '<span class="op-grade op-g-none">—</span>';
  var cls = 'op-g-d';
  if (g === 'A+' || g === 'A1') cls = 'op-g-a1';
  else if (g === 'A' || g === 'A2') cls = 'op-g-a2';
  else if (g === 'B1' || g === 'B') cls = 'op-g-b1';
  else if (g === 'B2') cls = 'op-g-b2';
  else if (g === 'C') cls = 'op-g-c';
  else if (g === 'CUS') cls = 'op-g-cus';
  return '<span class="op-grade ' + cls + '">' + esc(g) + '</span>';
}

/* ---- Cap sheet (ACP) policy: National rating × Branch grade → target stock
   coverage %. Values taken verbatim from the ACP tab. 'MIN' = keep a minimum
   level; CUS / unrated items are ordered only if required. ------------------*/
var OP_MATRIX = {
  'A+': { A1: 100, A2: 100, B1: 70, B2: 60, C: 40,    D: 20 },
  'A':  { A1: 90,  A2: 90,  B1: 70, B2: 50, C: 40,    D: 20 },
  'B':  { A1: 70,  A2: 70,  B1: 60, B2: 40, C: 30,    D: 20 },
  'C':  { A1: 40,  A2: 30,  B1: 20, B2: 20, C: 'MIN', D: 'MIN' },
  'D':  { A1: 20,  A2: 20,  B1: 10, B2: 10, C: 'MIN', D: 'MIN' }
};

// Gross Req covers this many months of demand.
var OP_COVERAGE_MONTHS = 2;

function opNum(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

// 4-month average monthly sale = (sum of the four 30-day ageing slabs) / 4.
function op4mAvg(r) {
  return (opNum(r.d91_120) + opNum(r.d61_90) + opNum(r.d31_60) + opNum(r.d01_30)) / 4;
}

// ACP requirement chain: Gross Req = Order% × 4m avg × coverage months;
// Actual Req = max(0, Gross Req − Closing − In-Transit).
function opRecommend(r) {
  var natl = r.n_grade, bg = r.branch_grade;
  var out = { pct: null, targetText: 'REQ', grossReq: null, actualReq: null };
  if (bg === 'CUS' || !natl || !OP_MATRIX[natl] || !(bg in OP_MATRIX[natl])) return out;
  var v = OP_MATRIX[natl][bg];
  if (v === 'MIN') { out.targetText = 'MIN'; return out; }
  out.pct = v;
  var gross = Math.round((v / 100) * op4mAvg(r) * OP_COVERAGE_MONTHS);
  var have = Math.round(opNum(r.current_stock)) + Math.round(opNum(r.in_transit));
  out.grossReq = gross;
  out.actualReq = Math.max(0, gross - have);
  return out;
}

// Editable worksheet cell; persisted via the change handler in AdminView.init.
function opInput(r, field, type, value) {
  return '<input class="op-edit" data-field="' + field + '"'
    + ' data-branch="' + esc(r.branch_code) + '" data-item="' + esc(r.item_name) + '"'
    + (type === 'number' ? ' type="number" min="0" step="1"' : ' type="text"')
    + ' value="' + esc(value == null ? '' : String(value)) + '">';
}

// The ACP worksheet: grouped headers, sticky Item column, 5 editable columns.
function planningHeadHTML(showBranch) {
  return '<tr>'
    + '<th rowspan="2" class="op-sticky">Item</th>'
    + (showBranch ? '<th rowspan="2">Branch</th>' : '')
    + '<th colspan="5" class="op-gh">Sales history</th>'
    + '<th colspan="8" class="op-gh">Requirement</th>'
    + '<th colspan="5" class="op-gh">Order entry</th>'
    + '</tr><tr>'
    + '<th>91-120</th><th>61-90</th><th>31-60</th><th>01-30</th><th>4m Avg</th>'
    + '<th>Avg Req.</th><th>Closing</th><th>In-Transit</th><th>N Rating</th><th>Br. Grade</th><th>Order %</th><th>Gross Req</th><th>Actual Req.</th>'
    + '<th>Actual Order</th><th>Branch Remarks</th><th>Appvd Order</th><th>Factory Remark</th><th>Batch</th>'
    + '</tr>';
}
function planningRowHTML(r, showBranch) {
  {
    var stock = Math.round(opNum(r.current_stock));
    var transit = Math.round(opNum(r.in_transit));
    var avg = Math.round(op4mAvg(r));
    var rec = opRecommend(r);
    var natl = r.n_grade ? (gradeBadge(r.n_grade) + ' <span class="op-score">' + (r.n_rating != null ? r.n_rating : '') + '</span>') : gradeBadge(null);
    var pctCell = rec.pct != null ? (rec.pct + '%')
      : ('<span class="op-tag">' + (rec.targetText === 'MIN' ? 'MIN' : 'Req.') + '</span>');
    var actualCell = rec.actualReq == null ? '—'
      : (rec.actualReq > 0 ? '<strong>' + rec.actualReq + '</strong>' : '0');
    return '<tr>'
      + '<td class="mono op-sticky">' + esc(displayItemName(r.item_name)) + '</td>'
      + (showBranch ? '<td class="mono">' + esc(r.branch_code) + '</td>' : '')
      + '<td class="mono">' + Math.round(opNum(r.d91_120)) + '</td>'
      + '<td class="mono">' + Math.round(opNum(r.d61_90)) + '</td>'
      + '<td class="mono">' + Math.round(opNum(r.d31_60)) + '</td>'
      + '<td class="mono">' + Math.round(opNum(r.d01_30)) + '</td>'
      + '<td class="mono">' + avg + '</td>'
      + '<td class="mono">' + avg + '</td>'
      + '<td class="mono' + (stock < 0 ? ' td-negative' : (stock > 0 ? ' td-positive' : '')) + '"><strong>' + stock + '</strong></td>'
      + '<td class="mono' + (transit > 0 ? ' td-positive' : '') + '">' + transit + '</td>'
      + '<td>' + natl + '</td>'
      + '<td>' + gradeBadge(r.branch_grade) + '</td>'
      + '<td class="mono">' + pctCell + '</td>'
      + '<td class="mono">' + (rec.grossReq != null ? rec.grossReq : '—') + '</td>'
      + '<td class="mono' + (rec.actualReq > 0 ? ' td-negative' : '') + '">' + actualCell + '</td>'
      + '<td class="op-cell">' + opInput(r, 'actual_order', 'number', r.actual_order) + '</td>'
      + '<td class="op-cell">' + opInput(r, 'branch_remarks', 'text', r.branch_remarks) + '</td>'
      + '<td class="op-cell">' + opInput(r, 'approved_order', 'number', r.approved_order) + '</td>'
      + '<td class="op-cell">' + opInput(r, 'factory_remark', 'text', r.factory_remark) + '</td>'
      + '<td class="op-cell">' + opInput(r, 'batch', 'text', r.plan_batch) + '</td>'
      + '</tr>';
  }
}
// Progressive paint of the ACP worksheet into a wrapper element.
function paintPlanning(wrap, rows, showBranch) {
  if (!wrap) return;
  var rowStrings = rows.map(function (r) { return planningRowHTML(r, showBranch); });
  paintTable(wrap, '<table role="table" aria-label="Order planning" class="op-sheet">',
    planningHeadHTML(showBranch), rowStrings,
    emptyState('ph-chart-line-up', 'No planning data', 'No customer-sales data yet, or try a different filter. Run a Refresh after syncing sales.'));
}
// Kept for string callers; live panel uses paintPlanning.
function renderPlanningRows(rows, showBranch) {
  if (rows.length === 0) {
    return emptyState('ph-chart-line-up', 'No planning data', 'No customer-sales data yet, or try a different filter. Run a Refresh after syncing sales.');
  }
  var body = rows.map(function (r) { return planningRowHTML(r, showBranch); }).join('');
  return '<table role="table" aria-label="Order planning" class="op-sheet"><thead>' + planningHeadHTML(showBranch) + '</thead><tbody>' + body + '</tbody></table>';
}

function filterPlanningRows(rows, term, grade) {
  term = (term || '').trim().toLowerCase();
  return rows.filter(function (r) {
    if (grade && r.branch_grade !== grade) return false;
    if (!term) return true;
    return (r.item_name || '').toLowerCase().indexOf(term) !== -1
      || (r.size || '').toLowerCase().indexOf(term) !== -1
      || (r.branch_code || '').toLowerCase().indexOf(term) !== -1;
  });
}

/* ------------------------------- LOGIN ---------------------------------- */
var Login = {
  init: function () {
    var form = document.getElementById('login-form');
    var errorText = document.getElementById('loginErr');
    var loginBtn = document.getElementById('loginBtn');
    var pwInput = document.getElementById('login-password');
    var pwEye = document.getElementById('login-pw-eye');

    pwEye.addEventListener('click', function () {
      var isPw = pwInput.type === 'password';
      pwInput.type = isPw ? 'text' : 'password';
      pwEye.innerHTML = isPw ? '<i class="ph ph-eye-slash"></i>' : '<i class="ph ph-eye"></i>';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errorText.textContent = '';
      errorText.style.display = 'none';
      loginBtn.disabled = true;
      loginBtn.innerHTML = '<i class="ph ph-spinner spin" style="width:auto;height:auto;border:none;"></i> Signing in…';

      var username = document.getElementById('login-username').value.trim();
      var password = pwInput.value;

      apiPost('/api/login', { username: username, password: password })
        .then(function () {
          // Cookie is set; reload so boot() picks up the session and routes.
          window.location.reload();
        })
        .catch(function (err) {
          errorText.textContent = err.message || "Couldn't reach the server. Check your connection and try again.";
          errorText.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.innerHTML = 'Sign in';
          loginBtn.closest('.login-box').style.animation = 'errShake 0.4s var(--spring)';
          setTimeout(function () { loginBtn.closest('.login-box').style.animation = ''; }, 450);
        });
    });
  }
};

/* ------------------------------- BRANCH --------------------------------- */
var BranchView = {
  ledgerRows: [],

  init: function () {
    document.getElementById('br-ledgerSearch').addEventListener('input', debounce(function (e) {
      var filtered = filterLedgerRows(BranchView.ledgerRows, e.target.value, { showBranch: false });
      paintLedger(document.getElementById('br-ledgerTableWrap'), filtered, { showBranch: false });
    }));

    BranchView.initAudit();

    document.getElementById('br-exportLedgerBtn').addEventListener('click', function () {
      var term = document.getElementById('br-ledgerSearch').value;
      var filtered = filterLedgerRows(BranchView.ledgerRows, term, { showBranch: false });
      var headers = ['Item Name', 'Batch', 'Opening Qty', 'Inward Qty', 'Sales Returns Qty', 'Outward Qty', 'Adjustment Qty', 'Incoming Transit Qty', 'Closing Qty', 'Opening As Of Date'];
      exportToCSV('branch_ledger.csv', headers, filtered, function (r) {
        return [r.item_name, r.batch, r.opening_qty, r.inward_qty, r.sales_return_qty || 0, r.outward_qty, r.adjustment_qty || 0, r.in_transit_qty || 0, r.closing_qty, r.opening_as_of_date];
      });
    });

    document.getElementById('br-recordConversionBtn').addEventListener('click', function () {
      ['fromItem', 'fromBatch', 'fromQty', 'toItem', 'toBatch', 'toQty', 'notes'].forEach(function (f) {
        document.getElementById('br-conv-' + f).value = '';
      });
      document.getElementById('br-conv-error').textContent = '';
      openModal('br-convOverlay');
      BranchView.loadConversions();
    });
    document.getElementById('br-conv-cancel').addEventListener('click', function () {
      closeModal('br-convOverlay');
    });
    document.getElementById('br-conv-submit').addEventListener('click', function () {
      var errBox = document.getElementById('br-conv-error');
      errBox.textContent = '';
      var btn = document.getElementById('br-conv-submit');
      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Saving…';
      var payload = {
        fromItemName: document.getElementById('br-conv-fromItem').value,
        fromBatch: document.getElementById('br-conv-fromBatch').value,
        fromQuantity: Number(document.getElementById('br-conv-fromQty').value),
        toItemName: document.getElementById('br-conv-toItem').value,
        toBatch: document.getElementById('br-conv-toBatch').value,
        toQuantity: Number(document.getElementById('br-conv-toQty').value),
        notes: document.getElementById('br-conv-notes').value
      };
      apiPost('/api/branch/conversion', payload)
        .then(function () {
          closeModal('br-convOverlay');
          toast('success', 'Conversion recorded.');
          BranchView.loadLedger();
        })
        .catch(function (err) { errBox.textContent = err.message; })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check"></i>Save conversion';
        });
    });
  },

  load: function () {
    document.getElementById('br-tableWrap').innerHTML = skeletonBlock();
    apiGet('/api/branch/dashboard')
      .then(BranchView.render)
      .catch(function (err) {
        document.getElementById('br-tableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load transfers', err.message || 'Your session may have expired — sign in again.');
      });
    BranchView.loadLedger();
    BranchView.loadAudit();
  },

  loadLedger: function () {
    document.getElementById('br-ledgerTableWrap').innerHTML = skeletonBlock();
    apiGet('/api/branch/ledger')
      .then(function (rows) {
        BranchView.ledgerRows = rows;
        document.getElementById('br-ledgerCount').textContent = rows.length;
        updateDatalist('br-items-datalist', rows, 'item_name');
        updateDatalist('br-batches-datalist', rows, 'batch');
        paintLedger(document.getElementById('br-ledgerTableWrap'), rows, {
          showBranch: false,
          emptyHTML: emptyState('ph-stack', 'No stock data yet', 'Opening stock and synced dispatches will appear here.')
        });

        BranchView.populateAuditItems();
      })
      .catch(function (err) {
        document.getElementById('br-ledgerTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load stock ledger', err.message || 'Try refreshing the page.');
      });
  },

  loadConversions: function () {
    document.getElementById('br-conversionsTableWrap').innerHTML = skeletonBlock(80);
    apiGet('/api/branch/conversions')
      .then(function (rows) {
        document.getElementById('br-conversionsTableWrap').innerHTML = rows.length === 0
          ? emptyState('ph-scissors', 'No conversions yet', 'Cutting/adjustment entries will appear here.')
          : '<table role="table" aria-label="Recent conversions"><thead><tr><th scope="col">Date</th><th scope="col">Consumed</th><th scope="col">Produced</th><th scope="col">Notes</th></tr></thead><tbody>'
            + rows.map(function (r) {
              return '<tr><td>' + new Date(r.created_at).toLocaleDateString() + '</td>'
                + '<td class="mono">' + esc(r.from_item_name) + (r.from_batch ? ('-' + esc(r.from_batch)) : '') + ' × ' + Math.round(r.from_quantity) + '</td>'
                + '<td class="mono">' + esc(r.to_item_name) + (r.to_batch ? ('-' + esc(r.to_batch)) : '') + ' × ' + Math.round(r.to_quantity) + '</td>'
                + '<td>' + esc(r.notes || '—') + '</td></tr>';
            }).join('')
            + '</tbody></table>';
      })
      .catch(function () {
        document.getElementById('br-conversionsTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load conversions', 'Try refreshing the page.');
      });
  },

  render: function (data) {
    document.getElementById('br-branchLabel').textContent = data.branchCode;
    document.getElementById('br-incomingCount').textContent = data.incomingTransfers.length;

    var navBadge = document.getElementById('br-nav-badge');
    if (navBadge) {
      if (data.incomingTransfers.length > 0) {
        navBadge.style.display = '';
        navBadge.textContent = data.incomingTransfers.length;
      } else {
        navBadge.style.display = 'none';
      }
    }

    var wrap = document.getElementById('br-tableWrap');

    if (data.incomingTransfers.length === 0) {
      wrap.innerHTML = emptyState('ph-truck', 'No incoming transfers', 'Nothing is currently in transit to your branch.');
      return;
    }

    var rows = data.incomingTransfers.map(function (t) {
      return '<tr data-id="' + t.id + '">'
        + '<td class="mono">' + esc(t.docnum) + '</td>'
        + '<td>' + esc(displayItemName(t.item_description)) + '</td>'
        + '<td class="mono">' + esc(t.batch) + '</td>'
        + '<td class="mono">' + Math.round(t.quantity) + '</td>'
        + '<td>' + esc(t.source_branch_code) + '</td>'
        + '<td>' + esc(t.doc_date) + '</td>'
        + '<td><span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span></td>'
        + '<td><button class="btn btn-primary btn-small mark-received-btn" data-id="' + t.id + '">Mark Received</button></td>'
        + '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table role="table" aria-label="Incoming transfers"><thead><tr>'
      + '<th scope="col">Docnum</th><th scope="col">Item</th><th scope="col">Batch</th><th scope="col">Qty</th><th scope="col">From</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col"></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';

    wrap.querySelectorAll('.mark-received-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        btn.disabled = true;
        btn.textContent = 'Updating…';

        apiPost('/api/branch/mark-received', { transactionId: id })
          .then(function () {
            toast('success', 'Transfer marked as received.');
            BranchView.load();
          })
          .catch(function (err) {
            toast('error', err.message || 'Could not mark this as received. Try again.');
            btn.disabled = false;
            btn.textContent = 'Mark Received';
          });
      });
    });
  }
};

/* -------------------------------- HOD ----------------------------------- */
var HodView = {
  ledgerRows: [],

  init: function () {
    document.getElementById('hod-ledgerSearch').addEventListener('input', debounce(function (e) {
      var filtered = filterLedgerRows(HodView.ledgerRows, e.target.value, { showBranch: true });
      paintLedger(document.getElementById('hod-ledgerTableWrap'), filtered, { showBranch: true });
    }));

    document.getElementById('hod-exportLedgerBtn').addEventListener('click', function () {
      var term = document.getElementById('hod-ledgerSearch').value;
      var filtered = filterLedgerRows(HodView.ledgerRows, term, { showBranch: true });
      var headers = ['Branch Code', 'Item Name', 'Batch', 'Opening Qty', 'Inward Qty', 'Sales Returns Qty', 'Outward Qty', 'Adjustment Qty', 'Incoming Transit Qty', 'Closing Qty', 'Opening As Of Date'];
      exportToCSV('hod_ledger.csv', headers, filtered, function (r) {
        return [r.branch_code, r.item_name, r.batch, r.opening_qty, r.inward_qty, r.sales_return_qty || 0, r.outward_qty, r.adjustment_qty || 0, r.in_transit_qty || 0, r.closing_qty, r.opening_as_of_date];
      });
    });
  },

  load: function () {
    document.getElementById('hod-transferTableWrap').innerHTML = skeletonBlock();
    apiGet('/api/hod/dashboard')
      .then(HodView.render)
      .catch(function (err) {
        document.getElementById('hod-transferTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load transfers', err.message || 'Try refreshing the page.');
      });
    HodView.loadLedger();
  },

  loadLedger: function () {
    document.getElementById('hod-ledgerTableWrap').innerHTML = skeletonBlock();
    apiGet('/api/hod/ledger')
      .then(function (rows) {
        HodView.ledgerRows = rows;
        paintLedger(document.getElementById('hod-ledgerTableWrap'), rows, {
          showBranch: true,
          emptyHTML: emptyState('ph-buildings', 'No branches assigned yet', 'Ask your Super Admin to assign branches to your account.')
        });

      })
      .catch(function (err) {
        document.getElementById('hod-ledgerTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load stock ledger', err.message || 'Try refreshing the page.');
      });
  },

  render: function (data) {
    if (data.noAssignments) {
      document.getElementById('hod-transferTableWrap').innerHTML = '';
      return;
    }

    var transferRows = data.transfers.map(function (t) {
      var badge = t.status === 'RECEIVED'
        ? '<span class="badge badge-received"><span class="badge-dot"></span>Received</span>'
        : '<span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span>';
      return '<tr><td class="mono">' + esc(t.docnum) + '</td><td>' + esc(displayItemName(t.item_description)) + '</td>'
        + '<td class="mono">' + Math.round(t.quantity) + '</td><td>' + esc(t.source_branch_code) + '</td>'
        + '<td>' + esc(t.destination_branch_code || '—') + '</td><td>' + esc(t.doc_date) + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('hod-transferTableWrap').innerHTML = data.transfers.length === 0
      ? emptyState('ph-truck', 'No transfers found', 'None recorded yet for your assigned branches.')
      : '<table role="table" aria-label="Branch transfers"><thead><tr><th scope="col">Docnum</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Date</th><th scope="col">Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';
  }
};

/* ------------------------------- ADMIN ---------------------------------- */
var AdminView = {
  allBranches: [],
  ledgerRows: [],
  planningRows: [],

  init: function () {
    document.getElementById('ad-open-date').value = new Date().toISOString().slice(0, 10);

    document.getElementById('ad-ledgerSearch').addEventListener('input', debounce(AdminView.filterLedger));
    document.getElementById('ad-ledgerBranchFilter').addEventListener('change', AdminView.filterLedger);

    document.getElementById('ad-planSearch').addEventListener('input', debounce(AdminView.filterPlanning));
    document.getElementById('ad-planBranchFilter').addEventListener('change', AdminView.filterPlanning);
    document.getElementById('ad-planGradeFilter').addEventListener('change', AdminView.filterPlanning);
    document.getElementById('ad-planNeedsOrder').addEventListener('change', AdminView.filterPlanning);

    // Autosave for the worksheet's editable cells (event delegation — the table
    // is re-rendered on every filter change).
    document.getElementById('ad-planTableWrap').addEventListener('change', function (e) {
      var input = e.target && e.target.classList && e.target.classList.contains('op-edit') ? e.target : null;
      if (!input) return;
      var field = input.getAttribute('data-field');
      var branch = input.getAttribute('data-branch');
      var item = input.getAttribute('data-item');
      var fields = {};
      fields[field] = input.value;
      input.classList.add('op-saving');
      apiPost('/api/admin/order-planning/line', { branchCode: branch, itemName: item, fields: fields })
        .then(function () {
          input.classList.remove('op-saving');
          input.classList.add('op-saved');
          setTimeout(function () { input.classList.remove('op-saved'); }, 1200);
          // Keep the local cache in sync so filter re-renders show the value.
          var rows = AdminView.planningRows;
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].branch_code === branch && rows[i].item_name === item) {
              rows[i][field === 'batch' ? 'plan_batch' : field] = input.value === '' ? null : input.value;
              break;
            }
          }
        })
        .catch(function (err) {
          input.classList.remove('op-saving');
          toast('error', 'Save failed: ' + err.message);
        });
    });
    document.getElementById('ad-planRefreshBtn').addEventListener('click', function () {
      var btn = document.getElementById('ad-planRefreshBtn');
      var icon = document.getElementById('ad-planRefreshIcon');
      btn.disabled = true;
      if (icon) icon.classList.add('spin');
      apiPost('/api/admin/order-planning/refresh', {})
        .then(function () { toast('success', 'Planning ratings rebuilt.'); AdminView.loadPlanning(); })
        .catch(function (err) { toast('error', 'Refresh failed: ' + err.message); })
        .finally(function () { btn.disabled = false; if (icon) icon.classList.remove('spin'); });
    });
    document.getElementById('ad-planExportBtn').addEventListener('click', function () {
      var term = document.getElementById('ad-planSearch').value;
      var grade = document.getElementById('ad-planGradeFilter').value;
      var branchFilter = document.getElementById('ad-planBranchFilter').value;
      var rows = AdminView.planningRows;
      if (branchFilter) rows = rows.filter(function (r) { return r.branch_code === branchFilter; });
      rows = filterPlanningRows(rows, term, grade);
      var headers = ['Branch', 'Item', '91-120 Days', '61-90 Days', '31-60 Days', '01-30 Days',
        '4m Avg Sale', 'Avg Req.', 'Closing Stock', 'In-Transit', 'N Rating', 'Branch Grade',
        'Order %', 'Gross Req', 'Actual Req.', 'Actual Order', 'Branch Remarks', 'Appvd Order', 'Factory Remark', 'Batch'];
      exportToCSV('order_planning.csv', headers, rows, function (r) {
        var rec = opRecommend(r);
        var avg = Math.round(op4mAvg(r));
        return [r.branch_code, r.item_name,
          Math.round(opNum(r.d91_120)), Math.round(opNum(r.d61_90)), Math.round(opNum(r.d31_60)), Math.round(opNum(r.d01_30)),
          avg, avg, Math.round(opNum(r.current_stock)), Math.round(opNum(r.in_transit)),
          r.n_grade ? (r.n_grade + ' (' + r.n_rating + ')') : '', r.branch_grade,
          rec.pct != null ? rec.pct : (rec.targetText === 'MIN' ? 'MIN' : 'Req.'),
          rec.grossReq != null ? rec.grossReq : '', rec.actualReq != null ? rec.actualReq : '',
          r.actual_order != null ? r.actual_order : '', r.branch_remarks || '',
          r.approved_order != null ? r.approved_order : '', r.factory_remark || '', r.plan_batch || ''];
      });
    });

    AdminView.initAudit();
    AdminView.initTransfers();

    document.getElementById('ad-refreshLedgerBtn').addEventListener('click', function () {
      var btn = document.getElementById('ad-refreshLedgerBtn');
      var icon = document.getElementById('ad-refreshLedgerIcon');
      btn.disabled = true;
      if (icon) icon.classList.add('spin');
      apiPost('/api/admin/ledger/refresh', {})
        .then(function () {
          toast('success', 'Ledger snapshot refreshed.');
          AdminView.loadLedger();
        })
        .catch(function (err) {
          toast('error', 'Refresh failed: ' + err.message);
        })
        .finally(function () {
          btn.disabled = false;
          if (icon) icon.classList.remove('spin');
        });
    });

    document.getElementById('ad-exportLedgerBtn').addEventListener('click', function () {
      var term = document.getElementById('ad-ledgerSearch').value;
      var branchFilter = document.getElementById('ad-ledgerBranchFilter').value;
      var rows = AdminView.ledgerRows;
      if (branchFilter) rows = rows.filter(function (r) { return r.branch_code === branchFilter; });
      rows = filterLedgerRows(rows, term, { showBranch: true });
      var headers = ['Branch Code', 'Item Name', 'Batch', 'Opening Qty', 'Inward Qty', 'Sales Returns Qty', 'Outward Qty', 'Adjustment Qty', 'Incoming Transit Qty', 'Closing Qty', 'Opening As Of Date'];
      exportToCSV('admin_all_ledgers.csv', headers, rows, function (r) {
        return [r.branch_code, r.item_name, r.batch, r.opening_qty, r.inward_qty, r.sales_return_qty || 0, r.outward_qty, r.adjustment_qty || 0, r.in_transit_qty || 0, r.closing_qty, r.opening_as_of_date];
      });
    });

    document.getElementById('ad-open-submit').addEventListener('click', function () {
      var errBox = document.getElementById('ad-open-error');
      errBox.textContent = '';
      var btn = document.getElementById('ad-open-submit');
      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Saving…';
      var payload = {
        branchCode: document.getElementById('ad-open-branch').value,
        itemName: document.getElementById('ad-open-item').value,
        batch: document.getElementById('ad-open-batch').value,
        quantity: Number(document.getElementById('ad-open-qty').value),
        asOfDate: document.getElementById('ad-open-date').value
      };
      apiPost('/api/admin/opening-stock', payload)
        .then(function () {
          document.getElementById('ad-open-item').value = '';
          document.getElementById('ad-open-batch').value = '';
          document.getElementById('ad-open-qty').value = '';
          toast('success', 'Opening stock saved.');
          AdminView.loadLedger();
        })
        .catch(function (err) { errBox.textContent = err.message; })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check"></i>Save';
        });
    });

    document.getElementById('ad-open-template').addEventListener('click', AdminView.downloadOpeningTemplate);
    document.getElementById('ad-open-upload').addEventListener('click', AdminView.uploadOpeningCsv);

    document.getElementById('ad-openOpeningBtn').addEventListener('click', function () {
      document.getElementById('ad-open-error').textContent = '';
      document.getElementById('ad-open-uploadResult').textContent = '';
      openModal('ad-openingOverlay');
    });
    document.getElementById('ad-open-close').addEventListener('click', function () { closeModal('ad-openingOverlay'); });

    document.getElementById('ad-openConversionBtn').addEventListener('click', function () {
      document.getElementById('ad-conv-error').textContent = '';
      openModal('ad-conversionOverlay');
    });
    document.getElementById('ad-conv-close').addEventListener('click', function () { closeModal('ad-conversionOverlay'); });

    document.getElementById('ad-conv-submit').addEventListener('click', function () {
      var errBox = document.getElementById('ad-conv-error');
      errBox.textContent = '';
      var btn = document.getElementById('ad-conv-submit');
      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Saving…';
      var payload = {
        branchCode: document.getElementById('ad-conv-branch').value,
        fromItemName: document.getElementById('ad-conv-fromItem').value,
        fromBatch: document.getElementById('ad-conv-fromBatch').value,
        fromQuantity: Number(document.getElementById('ad-conv-fromQty').value),
        toItemName: document.getElementById('ad-conv-toItem').value,
        toBatch: document.getElementById('ad-conv-toBatch').value,
        toQuantity: Number(document.getElementById('ad-conv-toQty').value),
        notes: document.getElementById('ad-conv-notes').value
      };
      apiPost('/api/admin/conversion', payload)
        .then(function () {
          ['fromItem', 'fromBatch', 'fromQty', 'toItem', 'toBatch', 'toQty', 'notes'].forEach(function (f) {
            document.getElementById('ad-conv-' + f).value = '';
          });
          toast('success', 'Conversion recorded.');
          closeModal('ad-conversionOverlay');
          AdminView.loadLedger();
          AdminView.loadConversions();
        })
        .catch(function (err) { errBox.textContent = err.message; })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check"></i>Save conversion';
        });
    });
    if (SESSION && SESSION.role) {
      var isSuper = SESSION.role === 'SUPER_ADMIN';
      var pill = document.getElementById('ad-rolePill');
      if (pill) pill.textContent = isSuper ? 'SUPER ADMIN' : 'ADMIN';
      var tag = document.getElementById('ad-rtag');
      if (tag) {
        tag.textContent = isSuper ? 'SUPER ADMIN' : 'ADMIN';
        tag.className = 'rtag ' + (isSuper ? 'rt-SUPER_ADMIN' : 'rt-ADMIN');
      }
    }

    AdminView.customNewRole = makeCustomSelect('ad-newRole', [
      { value: 'BRANCH', text: 'Branch Operator' },
      { value: 'ADMIN', text: 'Administrator' },
      { value: 'HOD', text: 'HOD (Head of Department)' }
    ], 'Select role...');

    document.getElementById('ad-newRole').addEventListener('change', function () {
      document.getElementById('ad-branchFieldWrap').style.display = (this.value === 'BRANCH') ? 'block' : 'none';
      document.getElementById('ad-hodBranchFieldWrap').style.display = (this.value === 'HOD') ? 'block' : 'none';
    });

    document.getElementById('ad-addUserBtn').addEventListener('click', function () {
      document.getElementById('ad-addUserPanelTitle').textContent = 'Add user';
      document.getElementById('ad-editUserId').value = '';
      document.getElementById('ad-newUsername').value = '';
      document.getElementById('ad-newFullName').value = '';
      document.getElementById('ad-newPassword').value = '';
      if (AdminView.customNewRole) {
        AdminView.customNewRole.setValue('BRANCH');
      } else {
        document.getElementById('ad-newRole').value = 'BRANCH';
      }
      document.getElementById('ad-addUserError').textContent = '';
      ['username', 'fullname', 'password', 'role'].forEach(function (f) {
        document.getElementById('ad-field-' + f).style.display = 'block';
      });
      document.getElementById('ad-branchFieldWrap').style.display = 'block';
      document.getElementById('ad-hodBranchFieldWrap').style.display = 'none';
      document.getElementById('ad-submitUserBtn').innerHTML = '<i class="ph ph-check"></i>Create user';
      openModal('ad-userOverlay');
    });

    document.getElementById('ad-cancelUserBtn').addEventListener('click', function () {
      closeModal('ad-userOverlay');
    });

    document.getElementById('ad-submitUserBtn').addEventListener('click', AdminView.submitUser);

    document.getElementById('ad-settings-saveSheet').addEventListener('click', function () {
      var btn = document.getElementById('ad-settings-saveSheet');
      var sheetId = document.getElementById('ad-settings-sheetId').value.trim();
      var sheetName = document.getElementById('ad-settings-sheetName').value.trim();
      var returnsSheetName = document.getElementById('ad-settings-returnsSheetName').value.trim();
      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Saving…';
      apiPost('/api/admin/settings', { 
        googleSpreadsheetId: sheetId, 
        googleSheetName: sheetName,
        googleReturnsSheetName: returnsSheetName
      })
        .then(function () {
          toast('success', 'Google Sheet settings saved.');
        })
        .catch(AdminView.showError)
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-floppy-disk"></i>Save Settings';
        });
    });

    document.getElementById('ad-settings-syncBtn').addEventListener('click', function () {
      var btn = document.getElementById('ad-settings-syncBtn');
      var status = document.getElementById('ad-settings-syncStatus');
      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Syncing…';
      status.textContent = 'Contacting Google Sheet...';
      apiPost('/api/admin/sync', { mode: 'HARD_RESET' })
        .then(function (res) {
          if (res.success) {
            toast('success', 'Synced ' + res.synced + ' rows from Google Sheet!');
            status.innerHTML = '<span style="color:var(--green)">Last Sync: Successful (' + res.synced + ' rows)</span>';
            AdminView.loadAll();
          } else {
            status.innerHTML = '<span style="color:var(--danger)">Sync failed: ' + esc(res.error) + '</span>';
          }
        })
        .catch(function (err) {
          status.innerHTML = '<span style="color:var(--danger)">Sync failed: ' + esc(err.message) + '</span>';
        })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-arrows-clockwise"></i>Sync Sheet Data Now';
        });
    });

    document.getElementById('ad-settings-clearBtn').addEventListener('click', function () {
      var pwInput = document.getElementById('ad-settings-clearPassword');
      var password = pwInput ? pwInput.value : '';
      if (!password) {
        toast('info', 'Enter your password to confirm the wipe.');
        if (pwInput) pwInput.focus();
        return;
      }
      appConfirm('Are you absolutely sure you want to clear all operational data from Supabase? This will wipe all transaction history, returns, conversions, opening stock, and reconciliations. This cannot be undone.', function () {
        var btn = document.getElementById('ad-settings-clearBtn');
        var status = document.getElementById('ad-settings-clearStatus');
        btn.disabled = true;
        btn.innerHTML = '<i class="ph ph-spinner spin"></i>Wiping Database…';
        status.textContent = 'Clearing tables…';

        apiPost('/api/admin/clear-database-data', { password: password })
          .then(function (res) {
            if (res.success) {
              toast('success', 'Database cleared successfully!');
              status.innerHTML = '<span style="color:var(--green)">Cleared successfully!</span>';
              if (pwInput) pwInput.value = '';
              AdminView.loadAll();
            } else {
              status.innerHTML = '<span style="color:var(--danger)">Failed to clear database.</span>';
            }
          })
          .catch(function (err) {
            status.innerHTML = '<span style="color:var(--danger)">Error: ' + esc(err.message) + '</span>';
          })
          .finally(function () {
            btn.disabled = false;
            btn.innerHTML = '<i class="ph ph-trash"></i>Clear All Supabase Data';
          });
      });
    });
    document.getElementById('ad-refreshSyncLogsBtn').addEventListener('click', AdminView.loadSyncLogs);
    document.getElementById('ad-refreshActivityLogsBtn').addEventListener('click', AdminView.loadActivityLogs);

    // Settings sub-tab switching
    document.querySelectorAll('.settings-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-settings-tab');
        document.querySelectorAll('.settings-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.settings-page').forEach(function (p) { p.style.display = 'none'; p.classList.remove('active'); });
        var page = document.getElementById('ad-stab-' + target);
        if (page) { page.style.display = ''; page.classList.add('active'); }
      });
    });

    // Header manual sync button
    var headerSyncBtn = document.getElementById('ad-headerSyncBtn');
    if (headerSyncBtn) {
      headerSyncBtn.addEventListener('click', function () {
        var icon = document.getElementById('ad-headerSyncIcon');
        headerSyncBtn.style.pointerEvents = 'none';
        headerSyncBtn.style.opacity = '0.6';
        if (icon) icon.classList.add('spin');
        
        apiPost('/api/admin/sync', { mode: 'HARD_RESET' })
          .then(function (res) {
            toast('success', 'Sync completed successfully! Synced ' + (res.synced || 0) + ' rows.');
            AdminView.loadAll();
          })
          .catch(function (err) {
            toast('error', 'Sync failed: ' + err.message);
          })
          .finally(function () {
            headerSyncBtn.style.pointerEvents = '';
            headerSyncBtn.style.opacity = '';
            if (icon) icon.classList.remove('spin');
          });
      });
    }
  },

  loadAll: function () {
    apiGet('/api/admin/dashboard').then(AdminView.renderDashboard).catch(AdminView.showError);
    apiGet('/api/admin/users').then(AdminView.renderUsers).catch(AdminView.showError);
    apiGet('/api/admin/settings')
      .then(function (res) {
        var idEl = document.getElementById('ad-settings-sheetId');
        var nameEl = document.getElementById('ad-settings-sheetName');
        var returnsNameEl = document.getElementById('ad-settings-returnsSheetName');
        if (idEl) idEl.value = res.googleSpreadsheetId || '';
        if (nameEl) nameEl.value = res.googleSheetName || 'RAW_DATA';
        if (returnsNameEl) returnsNameEl.value = res.googleReturnsSheetName || 'RAW_DATA_SALE_RETURN';
      })
      .catch(AdminView.showError);

    apiGet('/api/admin/branches').then(function (branches) {
      AdminView.allBranches = branches;
      AdminView.populateBranchDropdown();
      AdminView.populateHodCheckboxes();
      AdminView.populateLedgerBranchDropdowns();

      // Populate audit branch dropdown
      var branchOpts = [{ value: '', text: 'Choose branch...' }].concat(
        branches.map(function (b) { return { value: b.code, text: b.name }; })
      );
      var auditBranchEl = document.getElementById('ad-audit-branch');
      if (auditBranchEl) {
        auditBranchEl.innerHTML = branchOpts.map(function (o) {
          return '<option value="' + o.value + '">' + o.text + '</option>';
        }).join('');
      }
      if (AdminView.customAuditBranch) {
        AdminView.customAuditBranch.updateOptions(branchOpts);
        AdminView.customAuditBranch.setValue('');
      }

      // Load dependent datasets after branches are populated
      AdminView.loadLedger();
      AdminView.loadPlanning();
    }).catch(AdminView.showError);

    AdminView.loadConversions();
    AdminView.loadSyncLogs();
    AdminView.loadActivityLogs();
    AdminView.loadAudit();
  },

  loadSyncLogs: function () {
    var wrap = document.getElementById('ad-syncLogsWrap');
    if (!wrap) return;
    wrap.innerHTML = '<div style="color:var(--muted); text-align:center; padding:12px;">Loading logs...</div>';
    apiGet('/api/admin/sync-logs')
      .then(function (logs) {
        if (!logs || logs.length === 0) {
          wrap.innerHTML = '<div style="color: var(--muted); text-align: center; padding: 24px 0;">No logs found.</div>';
          return;
        }
        wrap.innerHTML = logs.map(function (l) {
          var color = l.status === 'SUCCESS' ? 'var(--green)' : 'var(--red)';
          var time = new Date(l.created_at).toLocaleString();
          return '<div style="border-bottom:1px solid var(--border); padding-bottom: 6px; margin-bottom: 6px; font-family:var(--font-ui);">'
            + '<div style="display:flex; justify-content:space-between; font-weight:600;">'
            + '<span style="color:' + color + ';">' + esc(l.status) + ' (' + (l.synced_count || 0) + ' rows)</span>'
            + '<span style="color:var(--muted); font-size:11px; font-weight:400;">' + time + '</span>'
            + '</div>'
            + '<div style="color:var(--sub); font-size:12px; margin-top:2px;">Trigger: <strong>' + esc(l.triggered_by) + '</strong></div>'
            + '<div style="color:var(--text); font-size:11px; margin-top:2px; font-family:var(--font-body); line-height:1.4;">' + esc(l.details) + '</div>'
            + '</div>';
        }).join('');
      })
      .catch(function (err) {
        wrap.innerHTML = '<div style="color:var(--danger); padding:12px;">Failed to load: ' + esc(err.message) + '</div>';
      });
  },

  loadActivityLogs: function () {
    var wrap = document.getElementById('ad-activityLogsWrap');
    if (!wrap) return;
    wrap.innerHTML = '<div style="color:var(--muted); text-align:center; padding:12px;">Loading activity...</div>';
    apiGet('/api/admin/activity-logs')
      .then(function (logs) {
        if (!logs || logs.length === 0) {
          wrap.innerHTML = '<div style="color: var(--muted); text-align: center; padding: 24px 0;">No activity found.</div>';
          return;
        }
        wrap.innerHTML = logs.map(function (l) {
          var time = new Date(l.created_at).toLocaleString();
          var details = l.details ? ('<div style="color:var(--sub); font-size:11px; margin-top:1px; line-height:1.3;">' + esc(l.details) + '</div>') : '';
          return '<div style="border-bottom:1px solid var(--border); padding-bottom: 6px; margin-bottom: 6px; font-family:var(--font-ui);">'
            + '<div style="display:flex; justify-content:space-between; font-weight:600; color:var(--text);">'
            + '<span>' + esc(l.action) + '</span>'
            + '<span style="color:var(--muted); font-size:11px; font-weight:400;">' + time + '</span>'
            + '</div>'
            + '<div style="color:var(--sub); font-size:11.5px; margin-top:1px;">User: <strong>' + esc(l.username) + '</strong></div>'
            + details
            + '</div>';
        }).join('');
      })
      .catch(function (err) {
        wrap.innerHTML = '<div style="color:var(--danger); padding:12px;">Failed to load: ' + esc(err.message) + '</div>';
      });
  },

  downloadOpeningTemplate: function () {
    var lines = ['BRANCH_CODE,ITEM_NAME,BATCH,QUANTITY,AS_OF_DATE'];
    if (AdminView.allBranches.length) {
      lines.push(AdminView.allBranches[0].code + ',ALFA3030-VL300-2440X1220,A,10,04-09-2025');
    } else {
      lines.push('BANGALORE-BRANCH,ALFA3030-VL300-2440X1220,A,10,04-09-2025');
    }
    // Valid branch codes as comment-style reference rows the user deletes.
    var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'opening_stock_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  },

  // Quote-safe CSV parse. Tolerates a leading BOM and the trailing empty
  // columns Excel likes to append (e.g. "...,AS_OF_DATE,,"); only the first
  // five columns are used.
  parseOpeningCsv: function (text) {
    var parsed = parseCsvText(text);
    if (parsed.length < 2) throw new Error('The file has no data rows.');

    var header = parsed[0].map(function (c) {
      return String(c).replace(/^﻿/, '').trim().replace(/^"|"$/g, '').toUpperCase();
    });
    while (header.length && header[header.length - 1] === '') header.pop(); // drop trailing blanks

    var expected = ['BRANCH_CODE', 'ITEM_NAME', 'BATCH', 'QUANTITY', 'AS_OF_DATE'];
    if (header.slice(0, 5).join('|') !== expected.join('|')) {
      throw new Error('Header row must be: ' + expected.join(',') + ' (extra blank columns are fine). Download the template and start from that.');
    }

    return parsed.slice(1).map(function (cells) {
      return {
        branchCode: (cells[0] || '').trim(),
        itemName: (cells[1] || '').trim(),
        batch: (cells[2] || '').trim(),
        quantity: (cells[3] || '').trim(),
        asOfDate: (cells[4] || '').trim()
      };
    });
  },

  uploadOpeningCsv: function () {
    var resultBox = document.getElementById('ad-open-uploadResult');
    var fileInput = document.getElementById('ad-open-file');
    var btn = document.getElementById('ad-open-upload');
    var file = fileInput.files && fileInput.files[0];

    if (!file) {
      resultBox.innerHTML = '<span style="color:var(--danger)">Choose a CSV file first.</span>';
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var rows;
      try {
        rows = AdminView.parseOpeningCsv(String(reader.result));
      } catch (e) {
        resultBox.innerHTML = '<span style="color:var(--danger)">' + e.message + '</span>';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Uploading…';
      resultBox.textContent = 'Validating ' + rows.length + ' rows…';

      apiPost('/api/admin/opening-stock/bulk', { rows: rows })
        .then(function (res) {
          if (res.success) {
            resultBox.innerHTML = '<span style="color:var(--green)">Saved ' + res.saved + ' opening stock rows.</span>';
            fileInput.value = '';
            toast('success', res.saved + ' opening stock rows saved.');
            AdminView.loadLedger();
          } else {
            var more = res.totalErrors > res.errors.length
              ? '<div>…and ' + (res.totalErrors - res.errors.length) + ' more.</div>' : '';
            resultBox.innerHTML = '<div style="color:var(--danger)">Nothing was saved — fix these and re-upload the whole file:</div>'
              + '<div style="max-height:180px; overflow-y:auto; margin-top:6px;">'
              + res.errors.map(function (e) { return '<div>• ' + esc(e) + '</div>'; }).join('') + more + '</div>';
          }
        })
        .catch(function (err) {
          resultBox.innerHTML = '<span style="color:var(--danger)">' + esc(err.message || 'Upload failed.') + '</span>';
        })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-upload-simple"></i>Upload CSV';
        });
    };
    reader.readAsText(file);
  },

  populateLedgerBranchDropdowns: function () {
    var rawOptions = AdminView.allBranches.map(function (b) {
      return { value: b.code, text: b.name };
    });
    
    var optionsHtml = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');
    var ledgerSel = document.getElementById('ad-ledgerBranchFilter');
    var planSel = document.getElementById('ad-planBranchFilter');
    if (ledgerSel) {
      ledgerSel.innerHTML = '<option value="">All branches</option>' + optionsHtml;
      ledgerSel.value = 'AHMEDABAD-FACTORY';
    }
    if (planSel) {
      planSel.innerHTML = '<option value="">All branches</option>' + optionsHtml;
      planSel.value = 'AHMEDABAD-FACTORY';
    }

    AdminView.customOpenBranch = makeCustomSelect('ad-open-branch', rawOptions, 'Select branch...');
    AdminView.customConvBranch = makeCustomSelect('ad-conv-branch', rawOptions, 'Select branch...');

    var filterOptions = [{ value: '', text: 'All branches' }].concat(rawOptions);
    AdminView.customLedgerBranchFilter = makeCustomSelect('ad-ledgerBranchFilter', filterOptions, 'All branches');
    AdminView.customPlanBranchFilter = makeCustomSelect('ad-planBranchFilter', filterOptions, 'All branches');
  },

  loadLedger: function () {
    document.getElementById('ad-ledgerTableWrap').innerHTML = skeletonBlock(120);
    idbGet('ad_ledger').then(function (cached) {
      if (cached && Array.isArray(cached) && cached.length && !AdminView.ledgerRows) {
        AdminView.ledgerRows = cached;
        AdminView.filterLedger();
      }
    });
    apiGet('/api/admin/ledger')
      .then(function (rows) {
        AdminView.ledgerRows = rows;
        idbSet('ad_ledger', rows);
        updateDatalist('ad-items-datalist', rows, 'item_name');
        updateDatalist('ad-batches-datalist', rows, 'batch');
        AdminView.filterLedger();
        
        var curBranch = document.getElementById('ad-audit-branch').value;
        if (curBranch) {
          AdminView.populateAuditItems(curBranch);
        }
      })
      .catch(function (err) {
        if (!AdminView.ledgerRows) {
          document.getElementById('ad-ledgerTableWrap').innerHTML =
            emptyState('ph-warning-circle', 'Could not load stock ledger', err.message || 'Try refreshing the page.');
        }
      });
  },

  filterLedger: function () {
    var term = document.getElementById('ad-ledgerSearch').value;
    var branchFilter = document.getElementById('ad-ledgerBranchFilter').value;
    var rows = AdminView.ledgerRows;
    if (branchFilter) rows = rows.filter(function (r) { return r.branch_code === branchFilter; });
    rows = filterLedgerRows(rows, term, { showBranch: true });
    paintLedger(document.getElementById('ad-ledgerTableWrap'), rows, { showBranch: true });
  },

  loadPlanning: function () {
    document.getElementById('ad-planTableWrap').innerHTML = skeletonBlock(120);
    idbGet('ad_planning').then(function (cached) {
      if (cached && Array.isArray(cached) && cached.length && !AdminView.planningRows) {
        AdminView.planningRows = cached;
        AdminView.filterPlanning();
      }
    });
    apiGet('/api/order-planning')
      .then(function (rows) {
        AdminView.planningRows = rows;
        idbSet('ad_planning', rows);
        AdminView.filterPlanning();
      })
      .catch(function (err) {
        if (!AdminView.planningRows) {
          document.getElementById('ad-planTableWrap').innerHTML =
            emptyState('ph-warning-circle', 'Could not load order planning', err.message || 'Try refreshing the page.');
        }
      });
  },

  filterPlanning: function () {
    var term = document.getElementById('ad-planSearch').value;
    var grade = document.getElementById('ad-planGradeFilter').value;
    var branchFilter = document.getElementById('ad-planBranchFilter').value;
    var needsOrder = document.getElementById('ad-planNeedsOrder').checked;
    var rows = AdminView.planningRows;
    if (branchFilter) rows = rows.filter(function (r) { return r.branch_code === branchFilter; });
    rows = filterPlanningRows(rows, term, grade);
    if (needsOrder) rows = rows.filter(function (r) { return opRecommend(r).actualReq > 0; });
    paintPlanning(document.getElementById('ad-planTableWrap'), rows, !branchFilter);
  },

  loadConversions: function () {
    document.getElementById('ad-conversionsTableWrap').innerHTML = skeletonBlock(80);
    apiGet('/api/admin/conversions')
      .then(function (rows) {
        document.getElementById('ad-conversionsTableWrap').innerHTML = rows.length === 0
          ? emptyState('ph-scissors', 'No conversions yet', 'Cutting/adjustment entries will appear here.')
          : '<table role="table" aria-label="Recent conversions"><thead><tr><th scope="col">Date</th><th scope="col">Branch</th><th scope="col">Consumed</th><th scope="col">Produced</th><th scope="col">Notes</th></tr></thead><tbody>'
            + rows.map(function (r) {
              return '<tr><td>' + new Date(r.created_at).toLocaleDateString() + '</td>'
                + '<td class="mono">' + esc(r.branch_code) + '</td>'
                + '<td class="mono">' + esc(r.from_item_name) + (r.from_batch ? ('-' + esc(r.from_batch)) : '') + ' × ' + Math.round(r.from_quantity) + '</td>'
                + '<td class="mono">' + esc(r.to_item_name) + (r.to_batch ? ('-' + esc(r.to_batch)) : '') + ' × ' + Math.round(r.to_quantity) + '</td>'
                + '<td>' + esc(r.notes || '—') + '</td></tr>';
            }).join('')
            + '</tbody></table>';
      })
      .catch(function () {
        document.getElementById('ad-conversionsTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load conversions', 'Try refreshing the page.');
      });
  },

  showError: function (err) {
    toast('error', err.message || 'Something went wrong.');
  },

  renderDashboard: function (data) {
    document.getElementById('ad-totalBranches').textContent = data.totalBranches;
    document.getElementById('ad-inTransitCount').textContent = data.inTransitCount;
    document.getElementById('ad-receivedCount').textContent = data.receivedCount;

    var transferRows = data.transfers.slice(0, 50).map(function (t) {
      var badge = t.status === 'RECEIVED'
        ? '<span class="badge badge-received"><span class="badge-dot"></span>Received</span>'
        : '<span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span>';
      return '<tr><td class="mono">' + esc(t.docnum) + '</td><td>' + esc(displayItemName(t.item_description)) + '</td>'
        + '<td class="mono">' + Math.round(t.quantity) + '</td><td>' + esc(t.source_branch_code) + '</td>'
        + '<td>' + esc(t.destination_branch_code || '—') + '</td><td>' + esc(t.doc_date) + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('ad-transferTableWrap').innerHTML = data.transfers.length === 0
      ? emptyState('ph-truck', 'No branch transfers found', 'Transfers will appear here once the sheet sync runs.')
      : '<table role="table" aria-label="Recent transfers"><thead><tr><th scope="col">Docnum</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Date</th><th scope="col">Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';


  },

  // Export-all + bulk status-update (CSV) for branch transfers.
  initTransfers: function () {
    var exportBtn = document.getElementById('ad-tr-export');
    var fileInput = document.getElementById('ad-tr-fileInput');
    var chooseBtn = document.getElementById('ad-tr-chooseFile');
    var fileNameEl = document.getElementById('ad-tr-fileName');
    var uploadBtn = document.getElementById('ad-tr-uploadBtn');
    var resultEl = document.getElementById('ad-tr-result');
    if (!exportBtn || !fileInput || !uploadBtn) return;

    exportBtn.addEventListener('click', function () {
      exportBtn.disabled = true;
      var original = exportBtn.innerHTML;
      exportBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Preparing…';
      apiGet('/api/admin/transfers/export')
        .then(function (rows) {
          if (!rows.length) { toast('info', 'No transfers to export.'); return; }
          var headers = ['DOCNUM', 'ITEM_CODE', 'ITEM_NAME', 'BATCH', 'QTY', 'FROM', 'TO', 'DATE', 'STATUS'];
          exportToCSV('branch_transfers.csv', headers, rows, function (t) {
            return [
              t.docnum, t.item_code, displayItemName(t.item_description), t.batch,
              t.quantity, t.source_branch_code, (t.destination_branch_code || ''),
              t.doc_date, (t.status === 'RECEIVED' ? 'Received' : 'In Transit')
            ];
          });
          toast('success', 'Exported ' + rows.length + ' transfers.');
        })
        .catch(function (err) { toast('error', err.message); })
        .finally(function () { exportBtn.disabled = false; exportBtn.innerHTML = original; });
    });

    chooseBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileNameEl.textContent = f ? f.name : 'No file chosen';
      uploadBtn.disabled = !f;
      resultEl.innerHTML = '';
    });

    uploadBtn.addEventListener('click', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var rows = [];
        try {
          var parsed = parseCsvText(String(reader.result));
          if (parsed.length < 2) throw new Error('The file has no data rows.');
          var header = parsed[0].map(function (c) { return c.trim().toUpperCase(); });
          var iDoc = header.indexOf('DOCNUM');
          var iItem = header.indexOf('ITEM_CODE');
          var iBatch = header.indexOf('BATCH');
          var iStatus = header.indexOf('STATUS');
          if (iDoc === -1 || iItem === -1 || iStatus === -1) {
            throw new Error('CSV must include DOCNUM, ITEM_CODE and STATUS columns — export first and edit that file.');
          }
          rows = parsed.slice(1).map(function (cells) {
            return {
              docnum: (cells[iDoc] || '').trim(),
              itemCode: (cells[iItem] || '').trim(),
              batch: iBatch === -1 ? '' : (cells[iBatch] || '').trim(),
              status: (cells[iStatus] || '').trim()
            };
          });
        } catch (e) {
          resultEl.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>';
          return;
        }

        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Updating…';
        resultEl.textContent = 'Validating ' + rows.length + ' rows…';

        apiPost('/api/admin/transfers/bulk-status', { rows: rows })
          .then(function (res) {
            if (res.success === false && res.errors) {
              var more = res.totalErrors > res.errors.length ? '<div>…and ' + (res.totalErrors - res.errors.length) + ' more.</div>' : '';
              resultEl.innerHTML = '<div style="color:var(--danger)">Nothing was updated — fix these and re-upload:</div>'
                + '<div style="max-height:160px; overflow-y:auto; margin-top:6px;">'
                + res.errors.map(function (e) { return '<div>• ' + esc(e) + '</div>'; }).join('') + more + '</div>';
              return;
            }
            resultEl.innerHTML = '<span style="color:var(--green)">Updated ' + res.updated + ' transfer(s): '
              + res.toReceived + ' → Received, ' + res.toInTransit + ' → In Transit. '
              + 'Unchanged: ' + res.unchanged + (res.notFound ? (', not matched: ' + res.notFound) : '') + '.</span>';
            toast('success', 'Updated ' + res.updated + ' transfers.');
            fileInput.value = '';
            fileNameEl.textContent = 'No file chosen';
            AdminView.loadAll();
          })
          .catch(function (err) {
            resultEl.innerHTML = '<span style="color:var(--danger)">Failed: ' + esc(err.message) + '</span>';
          })
          .finally(function () {
            uploadBtn.innerHTML = '<i class="ph ph-upload-simple"></i>Update status';
            uploadBtn.disabled = false;
          });
      };
      reader.readAsText(file);
    });
  },

  renderUsers: function (users) {
    var rows = users.map(function (u) {
      var statusBtn = u.active
        ? '<button class="btn btn-ghost btn-small toggle-active" data-id="' + u.id + '" data-active="false">Deactivate</button>'
        : '<button class="btn btn-primary btn-small toggle-active" data-id="' + u.id + '" data-active="true">Activate</button>';
      var editBtn = u.role === 'HOD'
        ? '<button class="btn btn-ghost btn-small edit-hod-btn" data-id="' + u.id + '" data-name="' + u.username + '">Edit branches</button>'
        : '';
      return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.full_name) + '</td>'
        + '<td><span class="rtag rt-' + esc(u.role) + '">' + esc(u.role.replace('_', ' ')) + '</span></td>'
        + '<td>' + esc(u.branch_code || '—') + '</td>'
        + '<td>' + (u.active ? '<span class="badge badge-received">Active</span>' : '<span class="badge" style="color:var(--text-dim);background:var(--surface-raised)">Inactive</span>') + '</td>'
        + '<td>' + statusBtn + ' ' + editBtn + '</td></tr>';
    }).join('');

    document.getElementById('ad-userTableWrap').innerHTML =
      '<table role="table" aria-label="Users"><thead><tr><th scope="col">Username</th><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Branch</th><th scope="col">Status</th><th scope="col"></th></tr></thead><tbody>' + rows + '</tbody></table>';

    document.querySelectorAll('.toggle-active').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var active = btn.getAttribute('data-active') === 'true';
        apiPost('/api/admin/users/active', { userId: id, active: active })
          .then(function () {
            toast('success', active ? 'User activated.' : 'User deactivated.');
            apiGet('/api/admin/users').then(AdminView.renderUsers);
          })
          .catch(function (err) { toast('error', err.message); });
      });
    });

    document.querySelectorAll('.edit-hod-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hodUserId = btn.getAttribute('data-id');
        apiGet('/api/admin/hod-assignments?userId=' + encodeURIComponent(hodUserId))
          .then(function (assignedCodes) { AdminView.openHodEditor(hodUserId, assignedCodes); })
          .catch(function (err) { toast('error', err.message); });
      });
    });
  },

  populateBranchDropdown: function () {
    var select = document.getElementById('ad-newBranchCode');
    var rawOptions = AdminView.allBranches.map(function (b) {
      return { value: b.code, text: b.name };
    });
    select.innerHTML = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');

    AdminView.customNewBranchCode = makeCustomSelect('ad-newBranchCode', rawOptions, 'Select branch...');
  },

  populateHodCheckboxes: function (checkedCodes) {
    checkedCodes = checkedCodes || [];
    var wrap = document.getElementById('ad-hodBranchCheckboxes');
    wrap.innerHTML = AdminView.allBranches.map(function (b) {
      var checked = checkedCodes.indexOf(b.code) !== -1 ? 'checked' : '';
      return '<label style="display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px; color:var(--text);">'
        + '<input type="checkbox" class="hod-branch-checkbox" value="' + b.code + '" ' + checked + '> ' + b.name + '</label>';
    }).join('');
  },

  openHodEditor: function (hodUserId, assignedCodes) {
    document.getElementById('ad-addUserPanelTitle').textContent = 'Edit HOD branches';
    document.getElementById('ad-editUserId').value = hodUserId;
    document.getElementById('ad-addUserError').textContent = '';
    ['username', 'fullname', 'password', 'role'].forEach(function (f) {
      document.getElementById('ad-field-' + f).style.display = 'none';
    });
    document.getElementById('ad-branchFieldWrap').style.display = 'none';
    document.getElementById('ad-hodBranchFieldWrap').style.display = 'block';
    AdminView.populateHodCheckboxes(assignedCodes);
    document.getElementById('ad-submitUserBtn').innerHTML = '<i class="ph ph-check"></i>Save branches';
    openModal('ad-userOverlay');
  },

  submitUser: function () {
    var errBox = document.getElementById('ad-addUserError');
    errBox.textContent = '';
    var editId = document.getElementById('ad-editUserId').value;
    var submitBtn = document.getElementById('ad-submitUserBtn');
    submitBtn.disabled = true;
    var originalBtnHTML = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Saving…';

    if (editId) {
      var codes = Array.prototype.slice.call(document.querySelectorAll('.hod-branch-checkbox:checked')).map(function (cb) { return cb.value; });
      apiPost('/api/admin/hod-assignments', { hodUserId: editId, branchCodes: codes })
        .then(function () {
          toast('success', 'HOD branch access updated.');
          submitBtn.disabled = false;
          AdminView.resetAddUserPanel();
          AdminView.loadAll();
        })
        .catch(function (err) {
          errBox.textContent = err.message;
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnHTML;
        });
      return;
    }

    var role = document.getElementById('ad-newRole').value;
    var payload = {
      username: document.getElementById('ad-newUsername').value,
      fullName: document.getElementById('ad-newFullName').value,
      password: document.getElementById('ad-newPassword').value,
      role: role,
      branchCode: document.getElementById('ad-newBranchCode').value,
      hodBranchCodes: role === 'HOD'
        ? Array.prototype.slice.call(document.querySelectorAll('.hod-branch-checkbox:checked')).map(function (cb) { return cb.value; })
        : []
    };

    apiPost('/api/admin/users', payload)
      .then(function () {
        toast('success', 'User created.');
        submitBtn.disabled = false;
        AdminView.resetAddUserPanel();
        AdminView.loadAll();
      })
      .catch(function (err) {
        errBox.textContent = err.message;
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnHTML;
      });
  },

  resetAddUserPanel: function () {
    closeModal('ad-userOverlay');
    ['username', 'fullname', 'password', 'role'].forEach(function (f) {
      document.getElementById('ad-field-' + f).style.display = 'block';
    });
    document.getElementById('ad-submitUserBtn').innerHTML = '<i class="ph ph-check"></i>Create user';
    document.getElementById('ad-newUsername').value = '';
    document.getElementById('ad-newFullName').value = '';
    document.getElementById('ad-newPassword').value = '';
  }
};

function wirePasswordChangeHandlers() {
  var prefixes = ['br', 'hod', 'ad'];
  prefixes.forEach(function (prefix) {
    var submitBtn = document.getElementById(prefix + '-pwd-submitBtn');
    if (!submitBtn) return;
    
    submitBtn.addEventListener('click', function () {
      var errorEl = document.getElementById(prefix + '-pwd-error');
      var currentPwd = document.getElementById(prefix + '-pwd-current').value.trim();
      var newPwd = document.getElementById(prefix + '-pwd-new').value.trim();
      var confirmPwd = document.getElementById(prefix + '-pwd-confirm').value.trim();

      if (!currentPwd || !newPwd || !confirmPwd) {
        errorEl.textContent = 'All fields are required.';
        return;
      }
      if (newPwd !== confirmPwd) {
        errorEl.textContent = 'New passwords do not match.';
        return;
      }
      if (newPwd.length < 6) {
        errorEl.textContent = 'New password must be at least 6 characters.';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Changing…';
      errorEl.textContent = '';

      apiPost('/api/user/change-password', {
        currentPassword: currentPwd,
        newPassword: newPwd
      })
        .then(function () {
          toast('success', 'Password changed successfully!');
          document.getElementById(prefix + '-pwd-current').value = '';
          document.getElementById(prefix + '-pwd-new').value = '';
          document.getElementById(prefix + '-pwd-confirm').value = '';
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Failed to change password';
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="ph ph-check"></i>Change Password';
        });
    });
  });
}

function wireReconcileModal() {
  var modalId = 'shared-reconcileOverlay';
  var customBranchSelect, customItemSelect, customBatchSelect;

  document.querySelectorAll('#br-reconcileBtn, #ad-reconcileBtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.getElementById('rec-physicalQty').value = '';
      document.getElementById('rec-ledgerQty').value = '0';
      document.getElementById('rec-variance').textContent = '—';
      document.getElementById('rec-variance').style.color = '';
      document.getElementById('rec-error').textContent = '';

      var isBranch = (SESSION.role === 'BRANCH');
      var branchEl = document.getElementById('rec-branch');
      var branchCont = document.getElementById('rec-branch-container');

      if (isBranch) {
        branchCont.style.display = 'none';
        branchEl.innerHTML = '<option value="' + SESSION.branchCode + '" selected>' + SESSION.branchCode + '</option>';
        if (customBranchSelect) {
          customBranchSelect.updateOptions([{ value: SESSION.branchCode, text: SESSION.branchCode }]);
          customBranchSelect.setValue(SESSION.branchCode);
        }
        populateReconcileItems(SESSION.branchCode);
      } else {
        branchCont.style.display = '';
        var branchOpts = [{ value: '', text: 'Choose branch...' }].concat(
          AdminView.allBranches.map(function (b) {
            return { value: b.code, text: b.name };
          })
        );
        branchEl.innerHTML = branchOpts.map(function (o) {
          return '<option value="' + o.value + '">' + o.text + '</option>';
        }).join('');
        
        if (!customBranchSelect) {
          customBranchSelect = makeCustomSelect('rec-branch', branchOpts, 'Choose branch...');
        } else {
          customBranchSelect.updateOptions(branchOpts);
        }
        customBranchSelect.setValue('');

        var itemOpts = [{ value: '', text: 'Select branch first...' }];
        document.getElementById('rec-item').innerHTML = '<option value="">Select branch first...</option>';
        if (!customItemSelect) {
          customItemSelect = makeCustomSelect('rec-item', itemOpts, 'Select branch first...');
        } else {
          customItemSelect.updateOptions(itemOpts);
        }
        customItemSelect.setValue('');

        var batchOpts = [{ value: '', text: 'Select item first...' }];
        document.getElementById('rec-batch').innerHTML = '<option value="">Select item first...</option>';
        if (!customBatchSelect) {
          customBatchSelect = makeCustomSelect('rec-batch', batchOpts, 'Select item first...');
        } else {
          customBatchSelect.updateOptions(batchOpts);
        }
        customBatchSelect.setValue('');
      }

      openModal(modalId);
    });
  });

  document.getElementById('rec-cancelBtn').addEventListener('click', function () {
    closeModal(modalId);
  });

  document.getElementById('rec-branch').addEventListener('change', function (e) {
    populateReconcileItems(e.target.value);
  });

  document.getElementById('rec-item').addEventListener('change', function () {
    populateReconcileBatches();
  });

  document.getElementById('rec-batch').addEventListener('change', function () {
    updateReconcileLedgerQty();
  });

  document.getElementById('rec-physicalQty').addEventListener('input', function () {
    calculateReconcileVariance();
  });

  document.getElementById('rec-submitBtn').addEventListener('click', function () {
    var btn = document.getElementById('rec-submitBtn');
    var errorEl = document.getElementById('rec-error');
    var branchCode = document.getElementById('rec-branch').value;
    var itemName = document.getElementById('rec-item').value;
    var batch = document.getElementById('rec-batch').value;
    var ledgerQty = Number(document.getElementById('rec-ledgerQty').value || 0);
    var physicalQtyVal = document.getElementById('rec-physicalQty').value.trim();

    if (!branchCode || !itemName || physicalQtyVal === '') {
      errorEl.textContent = 'Branch, item name, and physical count quantity are required.';
      return;
    }

    var physicalQty = Number(physicalQtyVal);
    if (isNaN(physicalQty) || physicalQty < 0) {
      errorEl.textContent = 'Physical quantity must be a non-negative number.';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner spin"></i>Submitting…';
    errorEl.textContent = '';

    apiPost('/api/reconciliation', {
      branchCode: branchCode,
      itemName: itemName,
      batch: batch,
      ledgerQty: ledgerQty,
      physicalQty: physicalQty
    })
      .then(function (res) {
        toast('success', 'Reconciliation submitted successfully! Variance: ' + res.variance);
        closeModal(modalId);
        if (SESSION.role === 'BRANCH') {
          BranchView.loadLedger();
        } else {
          AdminView.loadLedger();
          AdminView.loadActivityLogs();
        }
      })
      .catch(function (err) {
        errorEl.textContent = err.message || 'Failed to submit reconciliation.';
      })
      .finally(function () {
        btn.disabled = false;
        btn.innerHTML = '<i class="ph ph-check"></i>Submit Reconcile';
      });
  });

  function populateReconcileItems(branchCode) {
    if (!branchCode) return;
    var rows = (SESSION.role === 'BRANCH') ? BranchView.ledgerRows : AdminView.ledgerRows;
    var branchRows = rows.filter(function (r) { return r.branch_code === branchCode; });
    var uniqueItems = Array.from(new Set(branchRows.map(function (r) { return r.item_name; })));

    var itemOpts = [{ value: '', text: 'Choose item...' }].concat(
      uniqueItems.map(function (item) {
        return { value: item, text: displayItemName(item) };
      })
    );

    document.getElementById('rec-item').innerHTML = itemOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');

    if (!customItemSelect) {
      customItemSelect = makeCustomSelect('rec-item', itemOpts, 'Choose item...');
    } else {
      customItemSelect.updateOptions(itemOpts);
    }
    customItemSelect.setValue('');

    var batchOpts = [{ value: '', text: 'Select item first...' }];
    document.getElementById('rec-batch').innerHTML = '<option value="">Select item first...</option>';
    if (!customBatchSelect) {
      customBatchSelect = makeCustomSelect('rec-batch', batchOpts, 'Select item first...');
    } else {
      customBatchSelect.updateOptions(batchOpts);
    }
    customBatchSelect.setValue('');

    document.getElementById('rec-ledgerQty').value = '0';
    document.getElementById('rec-variance').textContent = '—';
    document.getElementById('rec-variance').style.color = '';
  }

  function populateReconcileBatches() {
    var branchCode = document.getElementById('rec-branch').value;
    var itemName = document.getElementById('rec-item').value;
    if (!branchCode || !itemName) return;

    var rows = (SESSION.role === 'BRANCH') ? BranchView.ledgerRows : AdminView.ledgerRows;
    var branchItemRows = rows.filter(function (r) { return r.branch_code === branchCode && r.item_name === itemName; });
    
    var batchOpts = [{ value: '', text: 'Choose batch...' }].concat(
      branchItemRows.map(function (r) {
        return { value: r.batch || '', text: r.batch ? r.batch : 'None' };
      })
    );

    document.getElementById('rec-batch').innerHTML = batchOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');

    if (!customBatchSelect) {
      customBatchSelect = makeCustomSelect('rec-batch', batchOpts, 'Choose batch...');
    } else {
      customBatchSelect.updateOptions(batchOpts);
    }
    customBatchSelect.setValue('');

    document.getElementById('rec-ledgerQty').value = '0';
    document.getElementById('rec-variance').textContent = '—';
    document.getElementById('rec-variance').style.color = '';
  }

  function updateReconcileLedgerQty() {
    var branchCode = document.getElementById('rec-branch').value;
    var itemName = document.getElementById('rec-item').value;
    var batch = document.getElementById('rec-batch').value;
    if (!branchCode || !itemName) return;

    var rows = (SESSION.role === 'BRANCH') ? BranchView.ledgerRows : AdminView.ledgerRows;
    var matched = rows.find(function (r) { 
      return r.branch_code === branchCode && r.item_name === itemName && (r.batch || '') === (batch || ''); 
    });
    
    var ledgerQty = matched ? Number(matched.closing_qty || 0) : 0;
    document.getElementById('rec-ledgerQty').value = ledgerQty;
    calculateReconcileVariance();
  }

  function calculateReconcileVariance() {
    var ledgerQty = Number(document.getElementById('rec-ledgerQty').value || 0);
    var physicalQtyVal = document.getElementById('rec-physicalQty').value.trim();
    var varEl = document.getElementById('rec-variance');

    if (physicalQtyVal === '') {
      varEl.textContent = '—';
      varEl.style.color = '';
      return;
    }

    var physicalQty = Number(physicalQtyVal);
    var variance = physicalQty - ledgerQty;
    varEl.textContent = (variance > 0 ? '+' : '') + variance;

    if (variance === 0) {
      varEl.style.color = 'var(--green)';
    } else if (variance < 0) {
      varEl.style.color = 'var(--red)';
    } else {
      varEl.style.color = 'var(--yellow)';
    }
  }
}

/* ------------------------------- DEDICATED AUDIT PAGE ------------------- */
AdminView.initAudit = function () {
  // 1. Setup template downloader
  var templateBtn = document.getElementById('ad-audit-template');
  if (templateBtn) {
    templateBtn.addEventListener('click', function () {
      var lines = ['BRANCH_CODE,ITEM_NAME,BATCH,PHYSICAL_QTY'];
      if (AdminView.allBranches.length) {
        lines.push(AdminView.allBranches[0].code + ',ALFA3030-VL13004-3355X1220,PR,50');
      } else {
        lines.push('AHMEDABAD-FACTORY,ALFA3030-VL13004-3355X1220,PR,50');
      }
      var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'audit_reconciliation_template.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  // 2. Setup custom selects
  AdminView.customAuditBranch = makeCustomSelect('ad-audit-branch', [], 'Choose branch...');
  AdminView.customAuditItem = makeCustomSelect('ad-audit-item', [{ value: '', text: 'Select branch first...' }], 'Select branch first...');
  AdminView.customAuditBatch = makeCustomSelect('ad-audit-batch', [{ value: '', text: 'Select item first...' }], 'Select item first...');

  // 3. Dropdown change listeners
  var branchSelect = document.getElementById('ad-audit-branch');
  if (branchSelect) {
    branchSelect.addEventListener('change', function (e) {
      AdminView.populateAuditItems(e.target.value);
    });
  }
  var itemSelect = document.getElementById('ad-audit-item');
  if (itemSelect) {
    itemSelect.addEventListener('change', function () {
      AdminView.populateAuditBatches();
    });
  }
  var batchSelect = document.getElementById('ad-audit-batch');
  if (batchSelect) {
    batchSelect.addEventListener('change', function () {
      AdminView.updateAuditLedgerQty();
    });
  }

  var physQty = document.getElementById('ad-audit-physicalQty');
  if (physQty) {
    physQty.addEventListener('input', function () {
      AdminView.calculateAuditVariance();
    });
  }

  // 4. Submit Single entry
  var submitBtn = document.getElementById('ad-audit-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      var btn = document.getElementById('ad-audit-submit');
      var errorEl = document.getElementById('ad-audit-error');
      var branchCode = document.getElementById('ad-audit-branch').value;
      var itemName = document.getElementById('ad-audit-item').value;
      var batch = document.getElementById('ad-audit-batch').value;
      var ledgerQty = Number(document.getElementById('ad-audit-ledgerQty').value || 0);
      var physicalQtyVal = document.getElementById('ad-audit-physicalQty').value.trim();

      if (!branchCode || !itemName || physicalQtyVal === '') {
        errorEl.textContent = 'Branch, item name, and physical count quantity are required.';
        return;
      }
      var physicalQty = Number(physicalQtyVal);
      if (isNaN(physicalQty) || physicalQty < 0) {
        errorEl.textContent = 'Physical quantity must be a non-negative number.';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Submitting…';
      errorEl.textContent = '';

      apiPost('/api/reconciliation', {
        branchCode: branchCode,
        itemName: itemName,
        batch: batch,
        ledgerQty: ledgerQty,
        physicalQty: physicalQty
      })
        .then(function (res) {
          toast('success', 'Reconciliation submitted successfully! Variance: ' + res.variance);
          // Reset form
          document.getElementById('ad-audit-physicalQty').value = '';
          document.getElementById('ad-audit-ledgerQty').value = '0';
          document.getElementById('ad-audit-variance').textContent = '—';
          document.getElementById('ad-audit-variance').style.color = '';
          if (AdminView.customAuditBranch) AdminView.customAuditBranch.setValue('');
          AdminView.loadAudit();
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Failed to submit reconciliation.';
        })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check"></i>Submit Reconciliation';
        });
    });
  }

  // 5. Bulk upload setup
  var fileInput = document.getElementById('ad-audit-fileInput');
  var uploadBtn = document.getElementById('ad-audit-uploadBtn');
  var fileNameEl = document.getElementById('ad-audit-fileName');
  var uploadResultEl = document.getElementById('ad-audit-uploadResult');

  if (fileInput && uploadBtn) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (file) {
        fileNameEl.textContent = file.name;
        uploadBtn.disabled = false;
      } else {
        fileNameEl.textContent = 'No file chosen';
        uploadBtn.disabled = true;
      }
    });

    uploadBtn.addEventListener('click', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        var rows = [];
        try {
          var parsed = parseCsvText(String(reader.result));
          if (parsed.length < 2) throw new Error('The file has no data rows.');

          var header = parsed[0].map(function (c) { return c.trim().toUpperCase(); });
          var expected = ['BRANCH_CODE', 'ITEM_NAME', 'BATCH', 'PHYSICAL_QTY'];
          if (header.join('|') !== expected.join('|')) {
            throw new Error('Header row must be: ' + expected.join(',') + ' — download the template and use it.');
          }

          rows = parsed.slice(1).map(function (cells) {
            return {
              branchCode: (cells[0] || '').trim(),
              itemName: (cells[1] || '').trim(),
              batch: (cells[2] || '').trim(),
              physicalQty: (cells[3] || '').trim()
            };
          });
        } catch (e) {
          uploadResultEl.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>';
          return;
        }

        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Uploading…';
        uploadResultEl.textContent = 'Validating ' + rows.length + ' rows…';

        apiPost('/api/reconciliations/bulk', { rows: rows })
          .then(function (res) {
            if (renderBulkReconResult(uploadResultEl, res)) {
              fileInput.value = '';
              fileNameEl.textContent = 'No file chosen';
              toast('success', res.count + ' reconciliations saved.');
              AdminView.loadAudit();
            }
          })
          .catch(function (err) {
            uploadResultEl.innerHTML = '<span style="color:var(--danger)">Failed: ' + esc(err.message) + '</span>';
          })
          .finally(function () {
            uploadBtn.innerHTML = '<i class="ph ph-upload-simple"></i>Upload & Reconcile';
          });
      };
      reader.readAsText(file);
    });
  }

  var refreshHistoryBtn = document.getElementById('ad-audit-refreshHistory');
  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', AdminView.loadAudit);
  }

  VarianceReport.init('ad');
};

AdminView.populateAuditItems = function (branchCode) {
  if (!branchCode) {
    if (AdminView.customAuditItem) {
      AdminView.customAuditItem.updateOptions([{ value: '', text: 'Select branch first...' }]);
      AdminView.customAuditItem.setValue('');
    }
    return;
  }
  var branchRows = AdminView.ledgerRows.filter(function (r) { return r.branch_code === branchCode; });
  var uniqueItems = Array.from(new Set(branchRows.map(function (r) { return r.item_name; })));

  var itemOpts = [{ value: '', text: 'Choose item...' }].concat(
    uniqueItems.map(function (item) {
      return { value: item, text: displayItemName(item) };
    })
  );

  var itemSelect = document.getElementById('ad-audit-item');
  if (itemSelect) {
    itemSelect.innerHTML = itemOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');
  }

  if (AdminView.customAuditItem) {
    AdminView.customAuditItem.updateOptions(itemOpts);
    AdminView.customAuditItem.setValue('');
  }

  if (AdminView.customAuditBatch) {
    AdminView.customAuditBatch.updateOptions([{ value: '', text: 'Select item first...' }]);
    AdminView.customAuditBatch.setValue('');
  }
  document.getElementById('ad-audit-ledgerQty').value = '0';
  document.getElementById('ad-audit-variance').textContent = '—';
  document.getElementById('ad-audit-variance').style.color = '';
};

AdminView.populateAuditBatches = function () {
  var branchCode = document.getElementById('ad-audit-branch').value;
  var itemName = document.getElementById('ad-audit-item').value;
  if (!branchCode || !itemName) return;

  var branchItemRows = AdminView.ledgerRows.filter(function (r) { return r.branch_code === branchCode && r.item_name === itemName; });
  var batchOpts = [{ value: '', text: 'Choose batch...' }].concat(
    branchItemRows.map(function (r) {
      return { value: r.batch || '', text: r.batch ? r.batch : 'None' };
    })
  );

  var batchSelect = document.getElementById('ad-audit-batch');
  if (batchSelect) {
    batchSelect.innerHTML = batchOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');
  }

  if (AdminView.customAuditBatch) {
    AdminView.customAuditBatch.updateOptions(batchOpts);
    AdminView.customAuditBatch.setValue('');
  }
  document.getElementById('ad-audit-ledgerQty').value = '0';
  document.getElementById('ad-audit-variance').textContent = '—';
  document.getElementById('ad-audit-variance').style.color = '';
};

AdminView.updateAuditLedgerQty = function () {
  var branchCode = document.getElementById('ad-audit-branch').value;
  var itemName = document.getElementById('ad-audit-item').value;
  var batch = document.getElementById('ad-audit-batch').value;
  if (!branchCode || !itemName) return;

  var matched = AdminView.ledgerRows.find(function (r) {
    return r.branch_code === branchCode && r.item_name === itemName && (r.batch || '') === (batch || '');
  });

  var ledgerQty = matched ? Number(matched.closing_qty || 0) : 0;
  document.getElementById('ad-audit-ledgerQty').value = ledgerQty;
  AdminView.calculateAuditVariance();
};

AdminView.calculateAuditVariance = function () {
  var ledgerQty = Number(document.getElementById('ad-audit-ledgerQty').value || 0);
  var physicalQtyVal = document.getElementById('ad-audit-physicalQty').value.trim();
  var varEl = document.getElementById('ad-audit-variance');

  if (physicalQtyVal === '') {
    varEl.textContent = '—';
    varEl.style.color = '';
    return;
  }

  var physicalQty = Number(physicalQtyVal);
  var variance = physicalQty - ledgerQty;
  varEl.textContent = (variance > 0 ? '+' : '') + variance;
  if (variance === 0) {
    varEl.style.color = 'var(--green)';
  } else if (variance < 0) {
    varEl.style.color = 'var(--danger)';
  } else {
    varEl.style.color = 'var(--accent)';
  }
};

AdminView.loadAudit = function () {
  var wrap = document.getElementById('ad-audit-historyWrap');
  if (!wrap) return;
  wrap.innerHTML = skeletonBlock(80);

  apiGet('/api/reconciliations')
    .then(function (rows) {
      if (rows.length === 0) {
        wrap.innerHTML = emptyState('ph-shield-check', 'No reconciliations found', 'Physical stock audits will appear here.');
        return;
      }

      var tableHtml = '<table role="table" aria-label="Reconciliation Logs"><thead><tr>'
        + '<th scope="col">Date</th>'
        + '<th scope="col">Audited By</th>'
        + '<th scope="col">Branch</th>'
        + '<th scope="col">Item Description</th>'
        + '<th scope="col">Batch</th>'
        + '<th scope="col">Ledger Qty</th>'
        + '<th scope="col">Physical Qty</th>'
        + '<th scope="col">Variance</th>'
        + '</tr></thead><tbody>'
        + rows.map(function (r) {
          var varText = (r.variance > 0 ? '+' : '') + r.variance;
          var varStyle = '';
          if (r.variance === 0) varStyle = 'color:var(--green); font-weight:bold;';
          else if (r.variance < 0) varStyle = 'color:var(--danger); font-weight:bold;';
          else varStyle = 'color:var(--accent); font-weight:bold;';

          return '<tr>'
            + '<td>' + new Date(r.created_at).toLocaleString() + '</td>'
            + '<td>' + esc(r.audited_by) + '</td>'
            + '<td class="mono">' + esc(r.branch_code) + '</td>'
            + '<td class="mono">' + esc(displayItemName(r.item_name)) + '</td>'
            + '<td class="mono">' + esc(r.batch || '—') + '</td>'
            + '<td class="mono">' + r.ledger_qty + '</td>'
            + '<td class="mono">' + r.physical_qty + '</td>'
            + '<td class="mono" style="' + varStyle + '">' + varText + '</td>'
            + '</tr>';
        }).join('')
        + '</tbody></table>';

      wrap.innerHTML = tableHtml;
    })
    .catch(function (err) {
      wrap.innerHTML = '<div style="color:var(--danger); padding:12px;">Failed to load reconciliations: ' + esc(err.message) + '</div>';
    });

  VarianceReport.load('ad');
};

/* BranchView dedicated audit page methods */
BranchView.initAudit = function () {
  // 1. Setup template downloader
  var templateBtn = document.getElementById('br-audit-template');
  if (templateBtn) {
    templateBtn.addEventListener('click', function () {
      var lines = ['ITEM_NAME,BATCH,PHYSICAL_QTY'];
      if (BranchView.ledgerRows.length) {
        lines.push(BranchView.ledgerRows[0].item_name + ',PR,50');
      } else {
        lines.push('ALFA3030-VL13004-3355X1220,PR,50');
      }
      var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'audit_reconciliation_template.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  // 2. Setup custom selects
  BranchView.customAuditItem = makeCustomSelect('br-audit-item', [], 'Choose item...');
  BranchView.customAuditBatch = makeCustomSelect('br-audit-batch', [{ value: '', text: 'Select item first...' }], 'Select item first...');

  // 3. Dropdown change listeners
  var itemSelect = document.getElementById('br-audit-item');
  if (itemSelect) {
    itemSelect.addEventListener('change', function () {
      BranchView.populateAuditBatches();
    });
  }
  var batchSelect = document.getElementById('br-audit-batch');
  if (batchSelect) {
    batchSelect.addEventListener('change', function () {
      BranchView.updateAuditLedgerQty();
    });
  }

  var physQty = document.getElementById('br-audit-physicalQty');
  if (physQty) {
    physQty.addEventListener('input', function () {
      BranchView.calculateAuditVariance();
    });
  }

  // 4. Submit Single entry
  var submitBtn = document.getElementById('br-audit-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      var btn = document.getElementById('br-audit-submit');
      var errorEl = document.getElementById('br-audit-error');
      var itemName = document.getElementById('br-audit-item').value;
      var batch = document.getElementById('br-audit-batch').value;
      var ledgerQty = Number(document.getElementById('br-audit-ledgerQty').value || 0);
      var physicalQtyVal = document.getElementById('br-audit-physicalQty').value.trim();

      if (!itemName || physicalQtyVal === '') {
        errorEl.textContent = 'Item name and physical count quantity are required.';
        return;
      }
      var physicalQty = Number(physicalQtyVal);
      if (isNaN(physicalQty) || physicalQty < 0) {
        errorEl.textContent = 'Physical quantity must be a non-negative number.';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="ph ph-spinner spin"></i>Submitting…';
      errorEl.textContent = '';

      apiPost('/api/reconciliation', {
        branchCode: SESSION.branchCode,
        itemName: itemName,
        batch: batch,
        ledgerQty: ledgerQty,
        physicalQty: physicalQty
      })
        .then(function (res) {
          toast('success', 'Reconciliation submitted successfully! Variance: ' + res.variance);
          // Reset form
          document.getElementById('br-audit-physicalQty').value = '';
          document.getElementById('br-audit-ledgerQty').value = '0';
          document.getElementById('br-audit-variance').textContent = '—';
          document.getElementById('br-audit-variance').style.color = '';
          if (BranchView.customAuditItem) BranchView.customAuditItem.setValue('');
          BranchView.loadAudit();
        })
        .catch(function (err) {
          errorEl.textContent = err.message || 'Failed to submit reconciliation.';
        })
        .finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check"></i>Submit Reconciliation';
        });
    });
  }

  // 5. Bulk upload setup
  var fileInput = document.getElementById('br-audit-fileInput');
  var uploadBtn = document.getElementById('br-audit-uploadBtn');
  var fileNameEl = document.getElementById('br-audit-fileName');
  var uploadResultEl = document.getElementById('br-audit-uploadResult');

  if (fileInput && uploadBtn) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (file) {
        fileNameEl.textContent = file.name;
        uploadBtn.disabled = false;
      } else {
        fileNameEl.textContent = 'No file chosen';
        uploadBtn.disabled = true;
      }
    });

    uploadBtn.addEventListener('click', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function () {
        var rows = [];
        try {
          var parsed = parseCsvText(String(reader.result));
          if (parsed.length < 2) throw new Error('The file has no data rows.');

          var header = parsed[0].map(function (c) { return c.trim().toUpperCase(); });
          var expected = ['ITEM_NAME', 'BATCH', 'PHYSICAL_QTY'];
          if (header.join('|') !== expected.join('|')) {
            throw new Error('Header row must be: ' + expected.join(',') + ' — download the template and use it.');
          }

          rows = parsed.slice(1).map(function (cells) {
            return {
              itemName: (cells[0] || '').trim(),
              batch: (cells[1] || '').trim(),
              physicalQty: (cells[2] || '').trim()
            };
          });
        } catch (e) {
          uploadResultEl.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>';
          return;
        }

        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<i class="ph ph-spinner spin"></i>Uploading…';
        uploadResultEl.textContent = 'Validating ' + rows.length + ' rows…';

        apiPost('/api/reconciliations/bulk', { rows: rows })
          .then(function (res) {
            if (renderBulkReconResult(uploadResultEl, res)) {
              fileInput.value = '';
              fileNameEl.textContent = 'No file chosen';
              toast('success', res.count + ' reconciliations saved.');
              BranchView.loadAudit();
            }
          })
          .catch(function (err) {
            uploadResultEl.innerHTML = '<span style="color:var(--danger)">Failed: ' + esc(err.message) + '</span>';
          })
          .finally(function () {
            uploadBtn.innerHTML = '<i class="ph ph-upload-simple"></i>Upload & Reconcile';
          });
      };
      reader.readAsText(file);
    });
  }

  var refreshHistoryBtn = document.getElementById('br-audit-refreshHistory');
  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', BranchView.loadAudit);
  }

  VarianceReport.init('br');
};

BranchView.populateAuditItems = function () {
  var uniqueItems = Array.from(new Set(BranchView.ledgerRows.map(function (r) { return r.item_name; })));
  var itemOpts = [{ value: '', text: 'Choose item...' }].concat(
    uniqueItems.map(function (item) {
      return { value: item, text: displayItemName(item) };
    })
  );

  var itemSelect = document.getElementById('br-audit-item');
  if (itemSelect) {
    itemSelect.innerHTML = itemOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');
  }

  if (BranchView.customAuditItem) {
    BranchView.customAuditItem.updateOptions(itemOpts);
    BranchView.customAuditItem.setValue('');
  }

  if (BranchView.customAuditBatch) {
    BranchView.customAuditBatch.updateOptions([{ value: '', text: 'Select item first...' }]);
    BranchView.customAuditBatch.setValue('');
  }
  document.getElementById('br-audit-ledgerQty').value = '0';
  document.getElementById('br-audit-variance').textContent = '—';
  document.getElementById('br-audit-variance').style.color = '';
};

BranchView.populateAuditBatches = function () {
  var itemName = document.getElementById('br-audit-item').value;
  if (!itemName) return;

  var branchItemRows = BranchView.ledgerRows.filter(function (r) { return r.item_name === itemName; });
  var batchOpts = [{ value: '', text: 'Choose batch...' }].concat(
    branchItemRows.map(function (r) {
      return { value: r.batch || '', text: r.batch ? r.batch : 'None' };
    })
  );

  var batchSelect = document.getElementById('br-audit-batch');
  if (batchSelect) {
    batchSelect.innerHTML = batchOpts.map(function (o) {
      return '<option value="' + o.value + '">' + o.text + '</option>';
    }).join('');
  }

  if (BranchView.customAuditBatch) {
    BranchView.customAuditBatch.updateOptions(batchOpts);
    BranchView.customAuditBatch.setValue('');
  }
  document.getElementById('br-audit-ledgerQty').value = '0';
  document.getElementById('br-audit-variance').textContent = '—';
  document.getElementById('br-audit-variance').style.color = '';
};

BranchView.updateAuditLedgerQty = function () {
  var itemName = document.getElementById('br-audit-item').value;
  var batch = document.getElementById('br-audit-batch').value;
  if (!itemName) return;

  var matched = BranchView.ledgerRows.find(function (r) {
    return r.item_name === itemName && (r.batch || '') === (batch || '');
  });

  var ledgerQty = matched ? Number(matched.closing_qty || 0) : 0;
  document.getElementById('br-audit-ledgerQty').value = ledgerQty;
  BranchView.calculateAuditVariance();
};

BranchView.calculateAuditVariance = function () {
  var ledgerQty = Number(document.getElementById('br-audit-ledgerQty').value || 0);
  var physicalQtyVal = document.getElementById('br-audit-physicalQty').value.trim();
  var varEl = document.getElementById('br-audit-variance');

  if (physicalQtyVal === '') {
    varEl.textContent = '—';
    varEl.style.color = '';
    return;
  }

  var physicalQty = Number(physicalQtyVal);
  var variance = physicalQty - ledgerQty;
  varEl.textContent = (variance > 0 ? '+' : '') + variance;
  if (variance === 0) {
    varEl.style.color = 'var(--green)';
  } else if (variance < 0) {
    varEl.style.color = 'var(--danger)';
  } else {
    varEl.style.color = 'var(--accent)';
  }
};

BranchView.loadAudit = function () {
  var wrap = document.getElementById('br-audit-historyWrap');
  if (!wrap) return;
  wrap.innerHTML = skeletonBlock(80);

  apiGet('/api/reconciliations')
    .then(function (rows) {
      if (rows.length === 0) {
        wrap.innerHTML = emptyState('ph-shield-check', 'No reconciliations found', 'Physical stock audits will appear here.');
        return;
      }

      var tableHtml = '<table role="table" aria-label="Reconciliation Logs"><thead><tr>'
        + '<th scope="col">Date</th>'
        + '<th scope="col">Audited By</th>'
        + '<th scope="col">Item Description</th>'
        + '<th scope="col">Batch</th>'
        + '<th scope="col">Ledger Qty</th>'
        + '<th scope="col">Physical Qty</th>'
        + '<th scope="col">Variance</th>'
        + '</tr></thead><tbody>'
        + rows.map(function (r) {
          var varText = (r.variance > 0 ? '+' : '') + r.variance;
          var varStyle = '';
          if (r.variance === 0) varStyle = 'color:var(--green); font-weight:bold;';
          else if (r.variance < 0) varStyle = 'color:var(--danger); font-weight:bold;';
          else varStyle = 'color:var(--accent); font-weight:bold;';

          return '<tr>'
            + '<td>' + new Date(r.created_at).toLocaleString() + '</td>'
            + '<td>' + esc(r.audited_by) + '</td>'
            + '<td class="mono">' + esc(displayItemName(r.item_name)) + '</td>'
            + '<td class="mono">' + esc(r.batch || '—') + '</td>'
            + '<td class="mono">' + r.ledger_qty + '</td>'
            + '<td class="mono">' + r.physical_qty + '</td>'
            + '<td class="mono" style="' + varStyle + '">' + varText + '</td>'
            + '</tr>';
        }).join('')
        + '</tbody></table>';

      wrap.innerHTML = tableHtml;
    })
    .catch(function (err) {
      wrap.innerHTML = '<div style="color:var(--danger); padding:12px;">Failed to load reconciliations: ' + esc(err.message) + '</div>';
    });

  VarianceReport.load('br');
};

/* ------------------------------- BOOT ----------------------------------- */
async function boot() {
  initTheme();
  wireLogout();
  wireSidebarToggles();
  wireSidebarNav();
  wireStatGoto();
  wireModals();
  wirePasswordChangeHandlers();
  wireRipples();

  try {
    SESSION = await apiGet('/api/session');
  } catch (e) {
    SESSION = null;
  }

  if (!SESSION) {
    showView('view-login');
    Login.init();
    return;
  }

  // Set role class on body for role-differentiated styling
  document.body.classList.remove('role-admin', 'role-branch', 'role-hod');
  if (SESSION.role === 'SUPER_ADMIN' || SESSION.role === 'ADMIN') {
    document.body.classList.add('role-admin');
  } else if (SESSION.role === 'BRANCH') {
    document.body.classList.add('role-branch');
  } else if (SESSION.role === 'HOD') {
    document.body.classList.add('role-hod');
  }

  switch (SESSION.role) {
    case 'BRANCH':
      showView('view-branch');
      fillUserChrome('br');
      BranchView.init();
      BranchView.load();
      break;
    case 'SUPER_ADMIN':
    case 'ADMIN':
      showView('view-admin');
      fillUserChrome('ad');
      AdminView.init();
      AdminView.loadAll();
      break;
    case 'HOD':
      showView('view-hod');
      fillUserChrome('hod');
      HodView.init();
      HodView.load();
      break;
    default:
      showView('view-login');
      Login.init();
  }
}

/* ------------------------ IndexedDB Cache Engine ------------------------- */
var IDB_NAME = 'IMS_CACHE_DB';
var IDB_VERSION = 1;
var IDB_STORE = 'app_cache';

function getIDB() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) return reject(new Error('IndexedDB not supported'));
    var req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

function idbGet(key) {
  return getIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readonly');
      var store = tx.objectStore(IDB_STORE);
      var req = store.get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }).catch(function () { return null; });
}

function idbSet(key, val) {
  return getIDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      var store = tx.objectStore(IDB_STORE);
      var req = store.put(val, key);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { reject(req.error); };
    });
  }).catch(function () { return false; });
}

/* ----------------------- Service Worker Registration ---------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* ignore */ });
  });
}

boot();

