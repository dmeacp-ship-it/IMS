'use strict';

/* ===========================================================================
   Virgo ACP IMS — client SPA.
   Talks to the Express API over fetch; the session lives in an httpOnly cookie
   set by the server, so there is no token to manage in the browser.
   =========================================================================== */

var SESSION = null;

/* ------------------------------ fetch helpers --------------------------- */
async function api(path, opts) {
  var res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  }, opts || {}));

  var body = {};
  try { body = await res.json(); } catch (e) { body = {}; }

  if (!res.ok) {
    var err = new Error(body.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return body;
}
function apiGet(path) { return api(path, { method: 'GET' }); }
function apiPost(path, data) { return api(path, { method: 'POST', body: JSON.stringify(data || {}) }); }

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
    var nav = view.querySelector('.sb-nav');
    if (!nav) return;
    var items = nav.querySelectorAll('.ni');

    function showPage(page) {
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

    items.forEach(function (item) {
      item.addEventListener('click', function () {
        items.forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        showPage(item.getAttribute('data-page'));
      });
    });

    var active = nav.querySelector('.ni.active') || items[0];
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
  });
}

// Light is the default; the user's choice persists in localStorage.
function initTheme() {
  var theme = 'light';
  try { theme = localStorage.getItem('ims_theme') || 'light'; } catch (e) { /* ignore */ }
  applyTheme(theme);
  document.querySelectorAll('.theme-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = document.body.classList.contains('light') ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('ims_theme', next); } catch (e) { /* ignore */ }
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

// Shared by Branch/Admin/HOD stock-ledger panels.
function renderLedgerRows(rows, opts) {
  opts = opts || {};
  var showBranch = !!opts.showBranch;
  if (rows.length === 0) {
    return emptyState('ph-magnifying-glass', 'No matching rows', 'Try a different search or filter, or add opening stock first.');
  }
  var head = (showBranch ? '<th>Branch</th>' : '')
    + '<th>Item Name</th><th>Batch</th><th>Opening</th><th>Inward</th><th>Outward</th><th>Closing</th>';
  var body = rows.map(function (r) {
    var closing = Math.round(r.closing_qty);
    return '<tr>'
      + (showBranch ? '<td class="mono">' + r.branch_code + '</td>' : '')
      + '<td class="mono">' + r.item_name + '</td>'
      + '<td class="mono">' + (r.batch || '—') + '</td>'
      + '<td class="mono">' + Math.round(r.opening_qty) + '</td>'
      + '<td class="mono">' + Math.round(r.inward_qty) + '</td>'
      + '<td class="mono">' + Math.round(r.outward_qty) + '</td>'
      + '<td class="mono"' + (closing < 0 ? ' style="color:var(--danger)"' : '') + '><strong>' + closing + '</strong></td>'
      + '</tr>';
  }).join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
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
          errorText.textContent = err.message || 'Something went wrong. Please try again.';
          errorText.style.display = 'block';
          loginBtn.disabled = false;
          loginBtn.textContent = 'Sign in';
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
    document.getElementById('br-ledgerSearch').addEventListener('input', function (e) {
      var filtered = filterLedgerRows(BranchView.ledgerRows, e.target.value, { showBranch: false });
      document.getElementById('br-ledgerTableWrap').innerHTML = renderLedgerRows(filtered, { showBranch: false });
    });

    document.getElementById('br-recordConversionBtn').addEventListener('click', function () {
      ['fromItem', 'fromBatch', 'fromQty', 'toItem', 'toBatch', 'toQty', 'notes'].forEach(function (f) {
        document.getElementById('br-conv-' + f).value = '';
      });
      document.getElementById('br-conv-error').textContent = '';
      openModal('br-convOverlay');
    });
    document.getElementById('br-conv-cancel').addEventListener('click', function () {
      closeModal('br-convOverlay');
    });
    document.getElementById('br-conv-submit').addEventListener('click', function () {
      var errBox = document.getElementById('br-conv-error');
      errBox.textContent = '';
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
        .catch(function (err) { errBox.textContent = err.message; });
    });
  },

  load: function () {
    document.getElementById('br-tableWrap').innerHTML = skeletonBlock();
    apiGet('/api/branch/dashboard')
      .then(BranchView.render)
      .catch(function (err) {
        document.getElementById('br-tableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load transfers', err.message || 'Please sign in again.');
      });
    BranchView.loadLedger();
  },

  loadLedger: function () {
    document.getElementById('br-ledgerTableWrap').innerHTML = skeletonBlock();
    apiGet('/api/branch/ledger')
      .then(function (rows) {
        BranchView.ledgerRows = rows;
        document.getElementById('br-ledgerCount').textContent = rows.length;
        document.getElementById('br-ledgerTableWrap').innerHTML = rows.length === 0
          ? emptyState('ph-stack', 'No stock data yet', 'Opening stock and synced dispatches will appear here.')
          : renderLedgerRows(rows, { showBranch: false });
      })
      .catch(function (err) {
        document.getElementById('br-ledgerTableWrap').innerHTML =
          emptyState('ph-warning-circle', 'Could not load stock ledger', err.message || 'Try refreshing the page.');
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
        + '<td class="mono">' + t.docnum + '</td>'
        + '<td>' + displayItemName(t.item_description) + '</td>'
        + '<td class="mono">' + t.batch + '</td>'
        + '<td class="mono">' + t.quantity + '</td>'
        + '<td>' + t.source_branch_code + '</td>'
        + '<td>' + t.doc_date + '</td>'
        + '<td><span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span></td>'
        + '<td><button class="btn btn-primary btn-small mark-received-btn" data-id="' + t.id + '">Mark Received</button></td>'
        + '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table><thead><tr>'
      + '<th>Docnum</th><th>Item</th><th>Batch</th><th>Qty</th><th>From</th><th>Date</th><th>Status</th><th></th>'
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
            toast('error', err.message || 'Failed to update.');
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
    document.getElementById('hod-ledgerSearch').addEventListener('input', function (e) {
      var filtered = filterLedgerRows(HodView.ledgerRows, e.target.value, { showBranch: true });
      document.getElementById('hod-ledgerTableWrap').innerHTML = renderLedgerRows(filtered, { showBranch: true });
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
        document.getElementById('hod-ledgerTableWrap').innerHTML = rows.length === 0
          ? emptyState('ph-buildings', 'No branches assigned yet', 'Ask your Super Admin to assign branches to your account.')
          : renderLedgerRows(rows, { showBranch: true });
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
      return '<tr><td class="mono">' + t.docnum + '</td><td>' + displayItemName(t.item_description) + '</td>'
        + '<td class="mono">' + t.quantity + '</td><td>' + t.source_branch_code + '</td>'
        + '<td>' + (t.destination_branch_code || '—') + '</td><td>' + t.doc_date + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('hod-transferTableWrap').innerHTML = data.transfers.length === 0
      ? emptyState('ph-truck', 'No transfers found', 'No branch transfers exist yet for your assigned branches.')
      : '<table><thead><tr><th>Docnum</th><th>Item</th><th>Qty</th><th>From</th><th>To</th><th>Date</th><th>Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';
  }
};

/* ------------------------------- ADMIN ---------------------------------- */
var AdminView = {
  allBranches: [],
  ledgerRows: [],

  init: function () {
    document.getElementById('ad-open-date').value = new Date().toISOString().slice(0, 10);

    document.getElementById('ad-ledgerSearch').addEventListener('input', AdminView.filterLedger);
    document.getElementById('ad-ledgerBranchFilter').addEventListener('change', AdminView.filterLedger);

    document.getElementById('ad-open-submit').addEventListener('click', function () {
      var errBox = document.getElementById('ad-open-error');
      errBox.textContent = '';
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
        .catch(function (err) { errBox.textContent = err.message; });
    });

    document.getElementById('ad-open-template').addEventListener('click', AdminView.downloadOpeningTemplate);
    document.getElementById('ad-open-upload').addEventListener('click', AdminView.uploadOpeningCsv);

    document.getElementById('ad-conv-submit').addEventListener('click', function () {
      var errBox = document.getElementById('ad-conv-error');
      errBox.textContent = '';
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
          AdminView.loadLedger();
          AdminView.loadConversions();
        })
        .catch(function (err) { errBox.textContent = err.message; });
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
      document.getElementById('ad-newRole').value = 'BRANCH';
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
  },

  loadAll: function () {
    apiGet('/api/admin/dashboard').then(AdminView.renderDashboard).catch(AdminView.showError);
    apiGet('/api/admin/users').then(AdminView.renderUsers).catch(AdminView.showError);
    apiGet('/api/admin/needs-tagging').then(AdminView.renderTagging).catch(AdminView.showError);
    apiGet('/api/admin/branches').then(function (branches) {
      AdminView.allBranches = branches;
      AdminView.populateBranchDropdown();
      AdminView.populateHodCheckboxes();
      AdminView.populateLedgerBranchDropdowns();
    }).catch(AdminView.showError);
    AdminView.loadLedger();
    AdminView.loadConversions();
  },

  downloadOpeningTemplate: function () {
    var lines = ['BRANCH_CODE,ITEM_NAME,BATCH,QUANTITY,AS_OF_DATE'];
    if (AdminView.allBranches.length) {
      lines.push(AdminView.allBranches[0].code + ',ALFA3030-VL300-2440X1220,A,10,2025-09-04');
    } else {
      lines.push('BANGALORE-BRANCH,ALFA3030-VL300-2440X1220,A,10,2025-09-04');
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

  // Minimal CSV parse: split lines/commas, strip surrounding quotes. Item
  // names and branch codes contain no commas, so this is sufficient.
  parseOpeningCsv: function (text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (lines.length < 2) throw new Error('The file has no data rows.');

    var header = lines[0].split(',').map(function (c) {
      return c.trim().replace(/^"|"$/g, '').toUpperCase();
    });
    var expected = ['BRANCH_CODE', 'ITEM_NAME', 'BATCH', 'QUANTITY', 'AS_OF_DATE'];
    if (header.join('|') !== expected.join('|')) {
      throw new Error('Header row must be exactly: ' + expected.join(',') + ' — download the template and start from that.');
    }

    return lines.slice(1).map(function (line) {
      var cells = line.split(',').map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      return {
        branchCode: cells[0],
        itemName: cells[1],
        batch: cells[2] || '',
        quantity: cells[3],
        asOfDate: cells[4]
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
      btn.textContent = 'Uploading…';
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
              + res.errors.map(function (e) { return '<div>• ' + e + '</div>'; }).join('') + more + '</div>';
          }
        })
        .catch(function (err) {
          resultBox.innerHTML = '<span style="color:var(--danger)">' + (err.message || 'Upload failed.') + '</span>';
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = 'Upload CSV';
        });
    };
    reader.readAsText(file);
  },

  populateLedgerBranchDropdowns: function () {
    var options = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');
    document.getElementById('ad-open-branch').innerHTML = options;
    document.getElementById('ad-conv-branch').innerHTML = options;
    document.getElementById('ad-ledgerBranchFilter').innerHTML = '<option value="">All branches</option>' + options;
  },

  loadLedger: function () {
    apiGet('/api/admin/ledger')
      .then(function (rows) {
        AdminView.ledgerRows = rows;
        AdminView.filterLedger();
      })
      .catch(function (err) {
        document.getElementById('ad-ledgerTableWrap').innerHTML =
          '<div class="empty-state">' + (err.message || 'Failed to load stock ledger.') + '</div>';
      });
  },

  filterLedger: function () {
    var term = document.getElementById('ad-ledgerSearch').value;
    var branchFilter = document.getElementById('ad-ledgerBranchFilter').value;
    var rows = AdminView.ledgerRows;
    if (branchFilter) rows = rows.filter(function (r) { return r.branch_code === branchFilter; });
    rows = filterLedgerRows(rows, term, { showBranch: true });
    document.getElementById('ad-ledgerTableWrap').innerHTML = renderLedgerRows(rows, { showBranch: true });
  },

  loadConversions: function () {
    document.getElementById('ad-conversionsTableWrap').innerHTML = skeletonBlock(80);
    apiGet('/api/admin/conversions')
      .then(function (rows) {
        document.getElementById('ad-conversionsTableWrap').innerHTML = rows.length === 0
          ? emptyState('ph-scissors', 'No conversions yet', 'Cutting/adjustment entries will appear here.')
          : '<table><thead><tr><th>Date</th><th>Branch</th><th>Consumed</th><th>Produced</th><th>Notes</th></tr></thead><tbody>'
            + rows.map(function (r) {
              return '<tr><td>' + new Date(r.created_at).toLocaleDateString() + '</td>'
                + '<td class="mono">' + r.branch_code + '</td>'
                + '<td class="mono">' + r.from_item_name + (r.from_batch ? ('-' + r.from_batch) : '') + ' × ' + r.from_quantity + '</td>'
                + '<td class="mono">' + r.to_item_name + (r.to_batch ? ('-' + r.to_batch) : '') + ' × ' + r.to_quantity + '</td>'
                + '<td>' + (r.notes || '—') + '</td></tr>';
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
    document.getElementById('ad-needsTaggingCount').textContent = data.needsTaggingCount;

    var navBadge = document.getElementById('ad-nav-badge-tagging');
    if (navBadge) {
      if (data.needsTaggingCount > 0) {
        navBadge.style.display = '';
        navBadge.textContent = data.needsTaggingCount;
      } else {
        navBadge.style.display = 'none';
      }
    }

    var transferRows = data.transfers.slice(0, 50).map(function (t) {
      var badge = t.status === 'RECEIVED'
        ? '<span class="badge badge-received"><span class="badge-dot"></span>Received</span>'
        : '<span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span>';
      return '<tr><td class="mono">' + t.docnum + '</td><td>' + displayItemName(t.item_description) + '</td>'
        + '<td class="mono">' + t.quantity + '</td><td>' + t.source_branch_code + '</td>'
        + '<td>' + (t.destination_branch_code || '—') + '</td><td>' + t.doc_date + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('ad-transferTableWrap').innerHTML = data.transfers.length === 0
      ? emptyState('ph-truck', 'No branch transfers found', 'Transfers will appear here once the sheet sync runs.')
      : '<table><thead><tr><th>Docnum</th><th>Item</th><th>Qty</th><th>From</th><th>To</th><th>Date</th><th>Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';
  },

  renderTagging: function (rows) {
    if (rows.length === 0) {
      document.getElementById('ad-taggingTableWrap').innerHTML =
        emptyState('ph-check-circle', 'All tagged', 'No transfers need destination tagging right now.');
      return;
    }

    var branchOptions = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');

    var tableRows = rows.map(function (r) {
      return '<tr data-id="' + r.id + '">'
        + '<td class="mono">' + r.docnum + '</td>'
        + '<td>' + displayItemName(r.item_description) + '</td>'
        + '<td>' + (r.customer_name || '—') + '</td>'
        + '<td class="mono">' + r.quantity + '</td>'
        + '<td>' + r.source_branch_code + '</td>'
        + '<td><select class="tag-branch-select"><option value="">Select branch…</option>' + branchOptions + '</select></td>'
        + '<td><button class="btn btn-primary btn-small tag-save-btn" data-id="' + r.id + '">Save</button></td>'
        + '</tr>';
    }).join('');

    document.getElementById('ad-taggingTableWrap').innerHTML =
      '<table><thead><tr><th>Docnum</th><th>Item</th><th>Customer</th><th>Qty</th><th>From</th><th>Assign destination</th><th></th></tr></thead><tbody>' + tableRows + '</tbody></table>';

    document.querySelectorAll('.tag-save-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var row = btn.closest('tr');
        var select = row.querySelector('.tag-branch-select');
        var branchCode = select.value;
        if (!branchCode) { toast('info', 'Choose a destination branch first.'); return; }

        btn.disabled = true;
        btn.textContent = 'Saving…';
        apiPost('/api/admin/resolve-destination', { transactionId: id, branchCode: branchCode })
          .then(function () {
            toast('success', 'Destination saved.');
            AdminView.loadAll();
          })
          .catch(function (err) {
            toast('error', err.message);
            btn.disabled = false;
            btn.textContent = 'Save';
          });
      });
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
      return '<tr><td>' + u.username + '</td><td>' + u.full_name + '</td>'
        + '<td><span class="rtag rt-' + u.role + '">' + u.role.replace('_', ' ') + '</span></td>'
        + '<td>' + (u.branch_code || '—') + '</td>'
        + '<td>' + (u.active ? '<span class="badge badge-received">Active</span>' : '<span class="badge" style="color:var(--text-dim);background:var(--surface-raised)">Inactive</span>') + '</td>'
        + '<td>' + statusBtn + ' ' + editBtn + '</td></tr>';
    }).join('');

    document.getElementById('ad-userTableWrap').innerHTML =
      '<table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Branch</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';

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
    select.innerHTML = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');
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

    if (editId) {
      var codes = Array.prototype.slice.call(document.querySelectorAll('.hod-branch-checkbox:checked')).map(function (cb) { return cb.value; });
      apiPost('/api/admin/hod-assignments', { hodUserId: editId, branchCodes: codes })
        .then(function () {
          toast('success', 'HOD branch access updated.');
          AdminView.resetAddUserPanel();
          AdminView.loadAll();
        })
        .catch(function (err) { errBox.textContent = err.message; });
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
        AdminView.resetAddUserPanel();
        AdminView.loadAll();
      })
      .catch(function (err) { errBox.textContent = err.message; });
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

/* ------------------------------- BOOT ----------------------------------- */
async function boot() {
  initTheme();
  wireLogout();
  wireSidebarToggles();
  wireSidebarNav();
  wireStatGoto();
  wireModals();
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

boot();
