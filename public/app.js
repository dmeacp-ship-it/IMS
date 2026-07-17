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

// Nav items scroll their target panel into view and mark themselves active.
function wireSidebarNav() {
  document.querySelectorAll('.sb-nav').forEach(function (nav) {
    nav.querySelectorAll('.ni').forEach(function (item) {
      item.addEventListener('click', function () {
        nav.querySelectorAll('.ni').forEach(function (n) { n.classList.remove('active'); });
        item.classList.add('active');
        var targetId = item.getAttribute('data-target');
        var target = targetId && document.getElementById(targetId);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      loginBtn.textContent = 'Signing in…';

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
        });
    });
  }
};

/* ------------------------------- BRANCH --------------------------------- */
var BranchView = {
  load: function () {
    apiGet('/api/branch/dashboard')
      .then(BranchView.render)
      .catch(function (err) {
        document.getElementById('br-tableWrap').innerHTML =
          '<div class="empty-state">' + (err.message || 'Failed to load. Please sign in again.') + '</div>';
      });
  },

  render: function (data) {
    document.getElementById('br-branchLabel').textContent = data.branchCode;
    document.getElementById('br-runningBalance').textContent =
      data.ledger ? Math.round(data.ledger.running_balance).toLocaleString() : '—';
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
      wrap.innerHTML = '<div class="empty-state">No transfers currently in transit to your branch.</div>';
      return;
    }

    var rows = data.incomingTransfers.map(function (t) {
      return '<tr data-id="' + t.id + '">'
        + '<td class="mono">' + t.docnum + '</td>'
        + '<td>' + t.item_description + '</td>'
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
          .then(function () { BranchView.load(); })
          .catch(function (err) {
            alert(err.message || 'Failed to update.');
            btn.disabled = false;
            btn.textContent = 'Mark Received';
          });
      });
    });
  }
};

/* -------------------------------- HOD ----------------------------------- */
var HodView = {
  load: function () {
    apiGet('/api/hod/dashboard')
      .then(HodView.render)
      .catch(function (err) {
        document.getElementById('hod-branchTableWrap').innerHTML =
          '<div class="empty-state">' + (err.message || 'Failed to load.') + '</div>';
        document.getElementById('hod-transferTableWrap').innerHTML = '';
      });
  },

  render: function (data) {
    if (data.noAssignments) {
      document.getElementById('hod-branchTableWrap').innerHTML =
        '<div class="empty-state">No branches assigned to your account yet. Contact your Super Admin.</div>';
      document.getElementById('hod-transferTableWrap').innerHTML = '';
      return;
    }

    var branchRows = data.branches.map(function (b) {
      return '<tr><td>' + b.branch_name + '</td><td class="mono">' + b.branch_code + '</td>'
        + '<td class="mono"><strong>' + Math.round(b.running_balance) + '</strong></td></tr>';
    }).join('');

    document.getElementById('hod-branchTableWrap').innerHTML = data.branches.length === 0
      ? '<div class="empty-state">No stock data for your assigned branches.</div>'
      : '<table><thead><tr><th>Branch</th><th>Code</th><th>Current Balance</th></tr></thead><tbody>' + branchRows + '</tbody></table>';

    var transferRows = data.transfers.map(function (t) {
      var badge = t.status === 'RECEIVED'
        ? '<span class="badge badge-received"><span class="badge-dot"></span>Received</span>'
        : '<span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span>';
      return '<tr><td class="mono">' + t.docnum + '</td><td>' + t.item_description + '</td>'
        + '<td class="mono">' + t.quantity + '</td><td>' + t.source_branch_code + '</td>'
        + '<td>' + (t.destination_branch_code || '—') + '</td><td>' + t.doc_date + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('hod-transferTableWrap').innerHTML = data.transfers.length === 0
      ? '<div class="empty-state">No transfers found for your assigned branches.</div>'
      : '<table><thead><tr><th>Docnum</th><th>Item</th><th>Qty</th><th>From</th><th>To</th><th>Date</th><th>Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';
  }
};

/* ------------------------------- ADMIN ---------------------------------- */
var AdminView = {
  allBranches: [],

  init: function () {
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
      document.getElementById('ad-branchFieldWrap').style.display = 'block';
      document.getElementById('ad-hodBranchFieldWrap').style.display = 'none';
      document.getElementById('ad-addUserPanel').style.display = 'block';
    });

    document.getElementById('ad-cancelUserBtn').addEventListener('click', function () {
      document.getElementById('ad-addUserPanel').style.display = 'none';
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
    }).catch(AdminView.showError);
  },

  showError: function (err) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="empty-state" style="color:var(--danger)">' + (err.message || 'Something went wrong.') + '</div>');
  },

  renderDashboard: function (data) {
    document.getElementById('ad-totalBranches').textContent = data.branches.length;
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

    var branchRows = data.branches.map(function (b) {
      return '<tr><td>' + b.branch_name + '</td><td class="mono">' + b.branch_code + '</td>'
        + '<td class="mono">' + Math.round(b.opening_qty) + '</td>'
        + '<td class="mono">' + Math.round(b.received_in) + '</td>'
        + '<td class="mono">' + Math.round(b.transferred_out) + '</td>'
        + '<td class="mono">' + Math.round(b.sold_out) + '</td>'
        + '<td class="mono"><strong>' + Math.round(b.running_balance) + '</strong></td></tr>';
    }).join('');

    document.getElementById('ad-branchTableWrap').innerHTML =
      '<table><thead><tr><th>Branch</th><th>Code</th><th>Opening</th><th>Received In</th>'
      + '<th>Transferred Out</th><th>Sold</th><th>Balance</th></tr></thead><tbody>' + branchRows + '</tbody></table>';

    var transferRows = data.transfers.slice(0, 50).map(function (t) {
      var badge = t.status === 'RECEIVED'
        ? '<span class="badge badge-received"><span class="badge-dot"></span>Received</span>'
        : '<span class="badge badge-transit"><span class="badge-dot"></span>In Transit</span>';
      return '<tr><td class="mono">' + t.docnum + '</td><td>' + t.item_description + '</td>'
        + '<td class="mono">' + t.quantity + '</td><td>' + t.source_branch_code + '</td>'
        + '<td>' + (t.destination_branch_code || '—') + '</td><td>' + t.doc_date + '</td><td>' + badge + '</td></tr>';
    }).join('');

    document.getElementById('ad-transferTableWrap').innerHTML = data.transfers.length === 0
      ? '<div class="empty-state">No branch transfers found.</div>'
      : '<table><thead><tr><th>Docnum</th><th>Item</th><th>Qty</th><th>From</th><th>To</th><th>Date</th><th>Status</th></tr></thead><tbody>' + transferRows + '</tbody></table>';
  },

  renderTagging: function (rows) {
    var panel = document.getElementById('ad-taggingPanel');
    if (rows.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    var branchOptions = AdminView.allBranches.map(function (b) {
      return '<option value="' + b.code + '">' + b.name + '</option>';
    }).join('');

    var tableRows = rows.map(function (r) {
      return '<tr data-id="' + r.id + '">'
        + '<td class="mono">' + r.docnum + '</td>'
        + '<td>' + r.item_description + '</td>'
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
        if (!branchCode) { alert('Choose a branch first.'); return; }

        btn.disabled = true;
        btn.textContent = 'Saving…';
        apiPost('/api/admin/resolve-destination', { transactionId: id, branchCode: branchCode })
          .then(function () { AdminView.loadAll(); })
          .catch(function (err) {
            alert(err.message);
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
      return '<tr><td>' + u.username + '</td><td>' + u.full_name + '</td><td>' + u.role + '</td>'
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
          .then(function () { apiGet('/api/admin/users').then(AdminView.renderUsers); })
          .catch(function (err) { alert(err.message); });
      });
    });

    document.querySelectorAll('.edit-hod-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hodUserId = btn.getAttribute('data-id');
        apiGet('/api/admin/hod-assignments?userId=' + encodeURIComponent(hodUserId))
          .then(function (assignedCodes) { AdminView.openHodEditor(hodUserId, assignedCodes); })
          .catch(function (err) { alert(err.message); });
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
    document.getElementById('ad-newUsername').style.display = 'none';
    document.getElementById('ad-newFullName').style.display = 'none';
    document.getElementById('ad-newPassword').style.display = 'none';
    document.getElementById('ad-newRole').style.display = 'none';
    document.getElementById('ad-branchFieldWrap').style.display = 'none';
    document.getElementById('ad-hodBranchFieldWrap').style.display = 'block';
    AdminView.populateHodCheckboxes(assignedCodes);
    document.getElementById('ad-submitUserBtn').textContent = 'Save branches';
    document.getElementById('ad-addUserPanel').style.display = 'block';
  },

  submitUser: function () {
    var errBox = document.getElementById('ad-addUserError');
    errBox.textContent = '';
    var editId = document.getElementById('ad-editUserId').value;

    if (editId) {
      var codes = Array.prototype.slice.call(document.querySelectorAll('.hod-branch-checkbox:checked')).map(function (cb) { return cb.value; });
      apiPost('/api/admin/hod-assignments', { hodUserId: editId, branchCodes: codes })
        .then(function () {
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
        AdminView.resetAddUserPanel();
        AdminView.loadAll();
      })
      .catch(function (err) { errBox.textContent = err.message; });
  },

  resetAddUserPanel: function () {
    document.getElementById('ad-addUserPanel').style.display = 'none';
    document.getElementById('ad-newUsername').style.display = 'block';
    document.getElementById('ad-newFullName').style.display = 'block';
    document.getElementById('ad-newPassword').style.display = 'block';
    document.getElementById('ad-newRole').style.display = 'block';
    document.getElementById('ad-submitUserBtn').textContent = 'Create user';
    document.getElementById('ad-newUsername').value = '';
    document.getElementById('ad-newFullName').value = '';
    document.getElementById('ad-newPassword').value = '';
  }
};

/* ------------------------------- BOOT ----------------------------------- */
async function boot() {
  wireLogout();
  wireSidebarToggles();
  wireSidebarNav();

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
      HodView.load();
      break;
    default:
      showView('view-login');
      Login.init();
  }
}

boot();
