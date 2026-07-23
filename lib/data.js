'use strict';

const { supabase } = require('./supabase');
const { hashPassword } = require('./auth');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function logActivity(username, action, details) {
  try {
    await supabase.from('system_activity_logs').insert({
      username: username || 'SYSTEM',
      action: action,
      details: details || null
    });
  } catch (e) {
    console.error('Failed to log system activity: ' + e.message);
  }
}

async function getActivityLogs() {
  const { data, error } = await supabase
    .from('system_activity_logs')
    .select('id, username, action, details, created_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw httpError(500, 'Failed to fetch activity logs: ' + error.message);
  return data || [];
}

/* ============================================================================
   BRANCH ROLE
   ========================================================================== */

async function getBranchDashboard(session) {
  const branchCode = session.branchCode;
  if (!branchCode) {
    throw httpError(400, 'Your account has no branch assigned. Contact your admin.');
  }

  const { data: transfers, error: txnErr } = await supabase
    .from('sales_transactions')
    .select('id,docnum,item_code,item_description,quantity,source_branch_code,doc_date,batch')
    .eq('destination_branch_code', branchCode)
    .eq('order_type', 'BRANCH-TRANSFER')
    .eq('status', 'IN_TRANSIT')
    .order('doc_date', { ascending: false });
  if (txnErr) throw httpError(500, 'Failed to load transfers.');

  return {
    branchCode: branchCode,
    fullName: session.fullName,
    incomingTransfers: transfers || []
  };
}

async function markReceived(session, transactionId) {
  if (!transactionId) throw httpError(400, 'Missing transfer id.');

  // Re-verify ownership server-side; never trust the id alone (service_role
  // bypasses RLS).
  const { data: rows } = await supabase
    .from('sales_transactions')
    .select('destination_branch_code,status,docnum,item_description')
    .eq('id', transactionId)
    .limit(1);
  const row = rows && rows[0];

  if (!row) throw httpError(404, 'Transfer not found.');
  if (row.destination_branch_code !== session.branchCode) {
    throw httpError(403, 'This transfer does not belong to your branch.');
  }
  if (row.status === 'RECEIVED') {
    throw httpError(409, 'This transfer is already marked Received.');
  }

  const { error } = await supabase
    .from('sales_transactions')
    .update({
      status: 'RECEIVED',
      received_at: new Date().toISOString(),
      received_by: session.userId
    })
    .eq('id', transactionId);
  if (error) throw httpError(500, 'Failed to update: ' + error.message);

  await logActivity(session.username, 'Received Transfer', 'Received transfer docnum ' + row.docnum + ' (' + row.item_description + ') at ' + session.branchCode);

  return { success: true };
}

/* ============================================================================
   ADMIN / SUPER_ADMIN
   ========================================================================== */

async function getAdminDashboard() {
  const [branchesRes, transfersRes] = await Promise.all([
    supabase.from('branches').select('code', { count: 'exact', head: true }),
    supabase.from('sales_transactions')
      .select('id,docnum,item_code,item_description,quantity,source_branch_code,destination_branch_code,status,doc_date,received_at')
      .eq('order_type', 'BRANCH-TRANSFER')
      .order('doc_date', { ascending: false })
      .limit(200)
  ]);

  const totalBranches = (branchesRes && branchesRes.count) || 0;
  const txns = (transfersRes && transfersRes.data) || [];
  const inTransitCount = txns.filter(function (t) { return t.status === 'IN_TRANSIT'; }).length;
  const receivedCount = txns.filter(function (t) { return t.status === 'RECEIVED'; }).length;

  return {
    totalBranches: totalBranches,
    transfers: txns,
    inTransitCount: inTransitCount,
    receivedCount: receivedCount
  };
}

async function getAllUsers() {
  const { data } = await supabase
    .from('user_profiles')
    .select('id,username,full_name,role,branch_code,active')
    .order('username', { ascending: true });
  return data || [];
}

async function getAllBranches() {
  const { data } = await supabase
    .from('branches')
    .select('code,name,facility_type')
    .order('name', { ascending: true });
  return data || [];
}

async function createUserByAdmin(session, userData) {
  userData = userData || {};
  const role = userData.role;
  const ROLES = ['SUPER_ADMIN', 'ADMIN', 'BRANCH', 'HOD'];
  if (ROLES.indexOf(role) === -1) {
    throw httpError(400, 'Invalid user role specified.');
  }

  if (session.role === 'ADMIN' && role !== 'BRANCH') {
    throw httpError(403, 'Admins can only create Branch-role accounts. Contact a Super Admin for other roles.');
  }
  if (role === 'BRANCH' && !userData.branchCode) {
    throw httpError(400, 'A branch must be selected for Branch-role accounts.');
  }

  const username = (userData.username || '').trim().toLowerCase();
  if (!username || !userData.password || !userData.fullName) {
    throw httpError(400, 'Username, password, and full name are required.');
  }

  const payload = {
    username: username,
    password_hash: hashPassword(userData.password),
    full_name: userData.fullName,
    role: role,
    branch_code: (role === 'BRANCH') ? userData.branchCode : null,
    active: true
  };

  const { data, error } = await supabase
    .from('user_profiles')
    .insert(payload)
    .select();

  if (error) {
    if ((error.message || '').indexOf('duplicate key') !== -1) {
      throw httpError(409, 'That username is already taken.');
    }
    throw httpError(500, 'Failed to create user: ' + error.message);
  }

  await logActivity(session.username, 'Create User', 'Created user account: ' + username + ' (Role: ' + role + ')');

  if (role === 'HOD' && session.role === 'SUPER_ADMIN' && Array.isArray(userData.hodBranchCodes) && userData.hodBranchCodes.length) {
    await _assignHodBranches(data[0].id, userData.hodBranchCodes);
  }

  return { success: true };
}

async function setUserActive(session, userId, active) {
  if (!userId) throw httpError(400, 'Missing user id.');

  const { data: userData } = await supabase
    .from('user_profiles')
    .select('username,role')
    .eq('id', userId)
    .limit(1);
  const target = userData && userData[0];
  if (!target) throw httpError(404, 'User not found.');

  if (session.role === 'ADMIN' && target.role !== 'BRANCH') {
    throw httpError(403, 'Admins can only manage Branch-role accounts.');
  }

  const { error } = await supabase
    .from('user_profiles')
    .update({ active: !!active })
    .eq('id', userId);
  if (error) throw httpError(500, 'Failed to update user.');

  await logActivity(session.username, 'Toggle User Status', 'Set active=' + !!active + ' for ' + target.username);

  return { success: true };
}

/* ============================================================================
   HOD ASSIGNMENTS & DASHBOARD
   ========================================================================== */

async function _assignHodBranches(hodUserId, branchCodes) {
  await supabase
    .from('hod_branch_assignments')
    .delete()
    .eq('hod_user_id', hodUserId);

  if (Array.isArray(branchCodes) && branchCodes.length) {
    const rows = branchCodes.map(function (code) {
      return { hod_user_id: hodUserId, branch_code: code };
    });
    const { error } = await supabase.from('hod_branch_assignments').insert(rows);
    if (error) throw httpError(500, 'Failed to save assignments: ' + error.message);
  }
}

async function assignHodBranches(session, hodUserId, branchCodes) {
  if (!hodUserId) throw httpError(400, 'Missing HOD user id.');
  
  const { data: userData } = await supabase
    .from('user_profiles')
    .select('username')
    .eq('id', hodUserId)
    .limit(1);
  const targetUsername = userData && userData[0] ? userData[0].username : hodUserId;

  await _assignHodBranches(hodUserId, branchCodes || []);

  await logActivity(session.username, 'HOD Assign Branches', 'Assigned HOD ' + targetUsername + ' to branches: ' + (branchCodes || []).join(', '));

  return { success: true };
}

async function getHodBranchAssignments(hodUserId) {
  if (!hodUserId) throw httpError(400, 'Missing HOD user id.');
  const { data } = await supabase
    .from('hod_branch_assignments')
    .select('branch_code')
    .eq('hod_user_id', hodUserId);
  return (data || []).map(function (r) { return r.branch_code; });
}

async function getHodDashboard(session) {
  const branchCodes = await _hodBranchCodes(session.userId);
  if (branchCodes.length === 0) {
    return { transfers: [], noAssignments: true };
  }

  const inList = branchCodes.join(',');
  const { data: transfers } = await supabase
    .from('sales_transactions')
    .select('id,docnum,item_code,item_description,quantity,source_branch_code,destination_branch_code,status,doc_date')
    .eq('order_type', 'BRANCH-TRANSFER')
    .or('source_branch_code.in.(' + inList + '),destination_branch_code.in.(' + inList + ')')
    .order('doc_date', { ascending: false })
    .limit(200);

  return {
    transfers: transfers || [],
    noAssignments: false
  };
}

async function _hodBranchCodes(hodUserId) {
  const { data: assignments } = await supabase
    .from('hod_branch_assignments')
    .select('branch_code')
    .eq('hod_user_id', hodUserId);
  return (assignments || []).map(function (a) { return a.branch_code; });
}


/* ============================================================================
   BRANCH-TRANSFER EXPORT + BULK STATUS UPDATE
   ========================================================================== */

// All branch transfers (paginated past Supabase's 1000-row cap) for CSV export.
async function getBranchTransfersForExport() {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('sales_transactions')
      .select('id,docnum,item_code,item_description,batch,quantity,source_branch_code,destination_branch_code,doc_date,status')
      .eq('order_type', 'BRANCH-TRANSFER')
      .order('doc_date', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw httpError(500, 'Failed to export transfers: ' + error.message);
    if (!data || data.length === 0) break;
    all.push.apply(all, data);
    if (data.length < PAGE || all.length >= 200000) break;
    from += PAGE;
  }
  return all;
}

async function _updateTransferStatusByIds(ids, patch) {
  const CH = 500;
  for (let i = 0; i < ids.length; i += CH) {
    const { error } = await supabase
      .from('sales_transactions')
      .update(patch)
      .in('id', ids.slice(i, i + CH));
    if (error) throw httpError(500, 'Failed to update transfer status: ' + error.message);
  }
}

// Bulk-set transfer status from an uploaded CSV. Rows are matched on the stable
// business key docnum+item_code+batch (survives re-syncs, unlike the row id).
// Only rows whose status actually changes are written, so received_at on
// already-received rows is preserved. Admin / Super Admin only.
async function bulkUpdateTransferStatus(session, rows) {
  if (session.role !== 'SUPER_ADMIN' && session.role !== 'ADMIN') {
    throw httpError(403, 'Only administrators can bulk-update transfer status.');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw httpError(400, 'No rows found in the uploaded file.');
  }
  if (rows.length > 200000) {
    throw httpError(400, 'Too many rows in one upload (max 200,000).');
  }

  const wanted = new Map();
  const errors = [];
  rows.forEach(function (r, i) {
    const line = i + 2; // header is line 1
    const docnum = String(r.docnum || '').trim();
    const itemCode = String(r.itemCode || '').trim();
    const batch = String(r.batch || '').trim().toUpperCase();
    let status = String(r.status || '').trim().toUpperCase().replace(/\s+/g, '_');
    if (status === 'INTRANSIT') status = 'IN_TRANSIT';

    if (!docnum || !itemCode) {
      errors.push('Line ' + line + ': DOCNUM and ITEM_CODE are required.');
      return;
    }
    if (status !== 'IN_TRANSIT' && status !== 'RECEIVED') {
      errors.push('Line ' + line + ': STATUS must be "In Transit" or "Received" (got "' + (r.status || '') + '").');
      return;
    }
    wanted.set(docnum + '|' + itemCode + '|' + batch, status);
  });

  if (errors.length) {
    return { success: false, updated: 0, errors: errors.slice(0, 50), totalErrors: errors.length };
  }

  // Snapshot current transfers to resolve business keys → {id, status} and to
  // skip no-op changes.
  const current = await getBranchTransfersForExport();
  const curMap = {};
  current.forEach(function (t) {
    curMap[t.docnum + '|' + t.item_code + '|' + (t.batch || '')] = { id: t.id, status: t.status };
  });

  const toReceived = [];
  const toInTransit = [];
  let unchanged = 0;
  let notFound = 0;
  wanted.forEach(function (status, key) {
    const cur = curMap[key];
    if (!cur) { notFound++; return; }
    if (cur.status === status) { unchanged++; return; }
    if (status === 'RECEIVED') toReceived.push(cur.id);
    else toInTransit.push(cur.id);
  });

  const nowIso = new Date().toISOString();
  await _updateTransferStatusByIds(toReceived, { status: 'RECEIVED', received_at: nowIso, received_by: session.userId });
  await _updateTransferStatusByIds(toInTransit, { status: 'IN_TRANSIT', received_at: null, received_by: null });

  const updated = toReceived.length + toInTransit.length;
  await logActivity(session.username, 'Bulk Transfer Status',
    'Updated ' + updated + ' transfers (' + toReceived.length + ' → Received, ' + toInTransit.length + ' → In Transit). Unchanged: ' + unchanged + ', not matched: ' + notFound + '.');

  return {
    success: true,
    updated: updated,
    toReceived: toReceived.length,
    toInTransit: toInTransit.length,
    unchanged: unchanged,
    notFound: notFound
  };
}

/* ============================================================================
   ITEM + BATCH STOCK LEDGER
   ========================================================================== */

// Canonical item key: descriptive name, uppercased, with any leading
// "VIRGO " stripped — matches how item_stock_ledger normalizes SAP data.
function normalizeItemName(s) {
  return String(s || '').trim().replace(/^VIRGO\s+/i, '').toUpperCase();
}
function normalizeBatch(s) {
  return String(s || '').trim().toUpperCase();
}

// Normalize a date string to ISO YYYY-MM-DD. Accepts YYYY-MM-DD as-is, and
// DD-MM-YYYY / DD/MM/YYYY (the Indian format the branch sheets use). Returns
// null if it can't be parsed. Ambiguous D-M vs M-D is resolved as DAY-month,
// matching the source data.
function _normalizeIsoDate(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) {
    const day = m[1].padStart(2, '0');
    const mon = m[2].padStart(2, '0');
    if (Number(day) > 31 || Number(mon) > 12) return null;
    return m[3] + '-' + mon + '-' + day;
  }
  return null;
}

async function mergeInTransitIntoLedger(ledgerRows, allowedBranches) {
  let query = supabase
    .from('sales_transactions')
    .select('destination_branch_code, item_description, batch, quantity')
    .eq('order_type', 'BRANCH-TRANSFER')
    .eq('status', 'IN_TRANSIT');
    
  if (allowedBranches && Array.isArray(allowedBranches) && allowedBranches.length > 0) {
    query = query.in('destination_branch_code', allowedBranches);
  }

  const { data: trans, error } = await query;
    
  if (error) {
    console.error('Failed to fetch in-transit for ledger:', error);
  }

  const inTransitMap = {};
  if (trans) {
    trans.forEach(function (t) {
      const branch = t.destination_branch_code;
      if (!branch) return;
      
      if (allowedBranches && allowedBranches.indexOf(branch) === -1) return;
      
      const item = normalizeItemName(t.item_description);
      const batch = normalizeBatch(t.batch);
      const key = branch + '||' + item + '||' + batch;
      inTransitMap[key] = (inTransitMap[key] || 0) + Number(t.quantity || 0);
    });
  }

  const rowMap = {};
  ledgerRows.forEach(function (r) {
    const key = r.branch_code + '||' + r.item_name + '||' + (r.batch || '');
    rowMap[key] = r;
    r.in_transit_qty = 0;
  });

  for (const key in inTransitMap) {
    const qty = inTransitMap[key];
    if (rowMap[key]) {
      rowMap[key].in_transit_qty = qty;
    } else {
      const parts = key.split('||');
      const branchCode = parts[0];
      const itemName = parts[1];
      const batch = parts[2];
      const newRow = {
        branch_code: branchCode,
        item_name: itemName,
        batch: batch || null,
        opening_qty: 0,
        inward_qty: 0,
        sales_return_qty: 0,
        outward_qty: 0,
        adjustment_qty: 0,
        closing_qty: 0,
        in_transit_qty: qty,
        opening_as_of_date: null
      };
      ledgerRows.push(newRow);
    }
  }

  return ledgerRows;
}

// Supabase/PostgREST caps every response at ~1000 rows regardless of .limit(),
// so a plain select on item_stock_ledger silently truncates (the view has 20k+
// rows). This fetches ALL matching rows by paging with .range(), several pages
// in flight at once to keep it quick. `applyFilters` adds the branch scope to
// both the count and the page queries; (branch_code,item_name,batch) is unique
// per row, so the ordering gives a stable total order for range pagination.
// `source` selects which relation to read: the live `item_stock_ledger` view
// (always current, but recomputes the full CTE on every query) or the
// precomputed `item_stock_ledger_mat` materialized view (cheap indexed scan,
// up to ~15 min stale — see supabase/patch_015). Use the matview for heavy
// all-branches reads; the live view for small, correctness-sensitive reads.
async function _fetchLedgerPaged(applyFilters, columns, source) {
  columns = columns || '*';
  source = source || 'item_stock_ledger';
  const PAGE = 1000;
  const CONCURRENCY = 5;

  // Fast path: try fetching page 0 first. If < PAGE items are returned, we are done in 1 query round-trip.
  let page0Q = supabase.from(source).select(columns)
    .order('branch_code', { ascending: true })
    .order('item_name', { ascending: true })
    .order('batch', { ascending: true })
    .range(0, PAGE - 1);
  page0Q = applyFilters(page0Q);
  const { data: firstPageData, error: p0Err } = await page0Q;
  if (p0Err) throw httpError(500, 'Failed to load stock ledger: ' + p0Err.message);

  const initialRows = firstPageData || [];
  if (initialRows.length < PAGE) {
    return initialRows;
  }

  // If page 0 hit the PAGE limit (1000 items), perform full count & page remaining items.
  let countQ = supabase.from(source).select('branch_code', { count: 'exact', head: true });
  countQ = applyFilters(countQ);
  const { count, error: cErr } = await countQ;
  if (cErr) throw httpError(500, 'Failed to load stock ledger: ' + cErr.message);
  const total = count || 0;
  if (total === 0) return [];

  const numPages = Math.ceil(total / PAGE);
  const pages = new Array(numPages);
  pages[0] = initialRows;
  let next = 1;
  async function worker() {
    while (next < numPages) {
      const p = next++;
      let q = supabase.from(source).select(columns)
        .order('branch_code', { ascending: true })
        .order('item_name', { ascending: true })
        .order('batch', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1);
      q = applyFilters(q);
      const { data, error } = await q;
      if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
      pages[p] = data || [];
    }
  }
  const pool = [];
  for (let w = 0; w < Math.min(CONCURRENCY, numPages - 1); w++) pool.push(worker());
  await Promise.all(pool);
  return [].concat.apply([], pages);
}

const LEDGER_COLS = 'branch_code,item_name,batch,opening_qty,inward_qty,sales_return_qty,outward_qty,adjustment_qty,closing_qty,opening_as_of_date';

async function getItemLedger(branchCode) {
  const rows = await _fetchLedgerPaged(function (q) { return q.eq('branch_code', branchCode); }, LEDGER_COLS);
  return mergeInTransitIntoLedger(rows, [branchCode]);
}

async function getAllItemLedger() {
  // All-branches read: use the precomputed matview to stay under the 10s limit.
  const rows = await _fetchLedgerPaged(function (q) { return q; }, LEDGER_COLS, 'item_stock_ledger_mat');
  return mergeInTransitIntoLedger(rows, null);
}

// Force an immediate rebuild of the item_stock_ledger_mat snapshot (normally
// refreshed every 15 min by pg_cron — see supabase/patch_015). Calls the
// SECURITY DEFINER helper so the all-branches ledger/variance reports pick up
// recent changes without waiting for the next scheduled cycle.
async function refreshLedgerSnapshot(session) {
  const { error } = await supabase.rpc('refresh_item_stock_ledger');
  if (error) throw httpError(500, 'Failed to refresh ledger: ' + error.message);
  await logActivity(session.username, 'Refresh Ledger', 'Manually rebuilt the stock ledger snapshot.');
  return { success: true };
}

async function getHodItemLedger(session) {
  const branchCodes = await _hodBranchCodes(session.userId);
  if (branchCodes.length === 0) return [];
  // Dashboard read across possibly many branches: use the precomputed matview.
  const rows = await _fetchLedgerPaged(function (q) { return q.in('branch_code', branchCodes); }, '*', 'item_stock_ledger_mat');
  return mergeInTransitIntoLedger(rows, branchCodes);
}

/* ============================================================================
   ORDER PLANNING
   National rating + branch grade + current stock, computed in Postgres from
   sales_transactions (see supabase/patch_016). Reads the precomputed op_planning
   view, scoped to the caller's branches.
   ========================================================================== */

async function getOrderPlanning(session) {
  // Resolve branch scope (null = all branches, for ADMIN/SUPER_ADMIN).
  let scope = null;
  if (session.role === 'BRANCH') {
    if (!session.branchCode) return [];
    scope = [session.branchCode];
  } else if (session.role === 'HOD') {
    scope = await _hodBranchCodes(session.userId);
    if (scope.length === 0) return [];
  }

  const PAGE = 1000;
  const CONCURRENCY = 5;
  function applyScope(q) { return scope ? q.in('branch_code', scope) : q; }

  const { count, error: cErr } = await applyScope(
    supabase.from('op_planning').select('branch_code', { count: 'exact', head: true })
  );
  if (cErr) throw httpError(500, 'Failed to load order planning: ' + cErr.message);
  const total = count || 0;
  if (total === 0) return [];

  const numPages = Math.ceil(total / PAGE);
  const pages = new Array(numPages);
  let next = 0;
  async function worker() {
    while (next < numPages) {
      const p = next++;
      let q = supabase.from('op_planning').select('*')
        .order('branch_code', { ascending: true })
        .order('item_name', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1);
      q = applyScope(q);
      const { data, error } = await q;
      if (error) throw httpError(500, 'Failed to load order planning: ' + error.message);
      pages[p] = data || [];
    }
  }
  const pool = [];
  for (let w = 0; w < Math.min(CONCURRENCY, numPages); w++) pool.push(worker());
  await Promise.all(pool);
  const rows = [].concat.apply([], pages);

  // Merge the manually entered order fields (order_plan_lines) into the rows.
  // NOTE: single request — fine while manual entries stay under the ~1000-row
  // PostgREST cap; page this like the ledger if the worksheet grows past that.
  let linesQ = supabase.from('order_plan_lines')
    .select('branch_code,item_name,actual_order,branch_remarks,approved_order,factory_remark,batch');
  if (scope) linesQ = linesQ.in('branch_code', scope);
  const { data: lines, error: lErr } = await linesQ;
  if (lErr) throw httpError(500, 'Failed to load order entries: ' + lErr.message);
  const lineMap = {};
  (lines || []).forEach(function (l) { lineMap[l.branch_code + '||' + l.item_name] = l; });
  rows.forEach(function (r) {
    const l = lineMap[r.branch_code + '||' + r.item_name];
    r.actual_order   = l ? l.actual_order : null;
    r.branch_remarks = l ? l.branch_remarks : null;
    r.approved_order = l ? l.approved_order : null;
    r.factory_remark = l ? l.factory_remark : null;
    r.plan_batch     = l ? l.batch : null;
  });
  return rows;
}

// Editable worksheet fields → value type. Whitelist for saveOrderPlanLine.
const OP_EDITABLE_FIELDS = {
  actual_order: 'number',
  branch_remarks: 'text',
  approved_order: 'number',
  factory_remark: 'text',
  batch: 'text'
};

// Upsert one manual order-entry line (only the provided fields are written).
async function saveOrderPlanLine(session, entry) {
  entry = entry || {};
  const branchCode = String(entry.branchCode || '').trim().toUpperCase();
  const itemName = String(entry.itemName || '').trim().toUpperCase();
  if (!branchCode || !itemName) throw httpError(400, 'Branch and item are required.');

  const { data: validBranch } = await supabase
    .from('branches').select('code').eq('code', branchCode).limit(1);
  if (!validBranch || validBranch.length === 0) {
    throw httpError(400, 'Not a recognized branch code.');
  }

  const row = {
    branch_code: branchCode,
    item_name: itemName,
    updated_by: session.userId,
    updated_at: new Date().toISOString()
  };
  const touched = [];
  const fields = entry.fields || {};
  for (const key in OP_EDITABLE_FIELDS) {
    if (!(key in fields)) continue;
    let v = fields[key];
    if (v === '' || v === null || v === undefined) {
      v = null;
    } else if (OP_EDITABLE_FIELDS[key] === 'number') {
      v = Number(v);
      if (isNaN(v) || v < 0) throw httpError(400, 'Value for ' + key.replace(/_/g, ' ') + ' must be a non-negative number.');
    } else {
      v = String(v).slice(0, 500);
    }
    row[key] = v;
    touched.push(key);
  }
  if (touched.length === 0) throw httpError(400, 'Nothing to save.');

  const { error } = await supabase
    .from('order_plan_lines')
    .upsert(row, { onConflict: 'branch_code,item_name' });
  if (error) throw httpError(500, 'Failed to save order entry: ' + error.message);

  await logActivity(session.username, 'Order Plan Entry',
    'Saved ' + touched.join(', ') + ' for ' + itemName + ' @ ' + branchCode);

  return { success: true };
}

// Force an immediate rebuild of the national-rating + branch-grade snapshots
// (normally refreshed hourly by pg_cron — see supabase/patch_016).
async function refreshOrderPlanning(session) {
  const { error } = await supabase.rpc('refresh_order_planning');
  if (error) throw httpError(500, 'Failed to refresh order planning: ' + error.message);
  await logActivity(session.username, 'Refresh Order Planning', 'Rebuilt the order planning ratings.');
  return { success: true };
}

// Validates one opening-stock entry into a DB-ready row, or throws with a
// message (prefixed with the CSV line number when called from bulk upload).
function _validateOpeningRow(entry, validBranchCodes, userId, lineLabel) {
  const prefix = lineLabel ? (lineLabel + ': ') : '';
  const branchCode = String(entry.branchCode || '').trim().toUpperCase();
  const itemName = normalizeItemName(entry.itemName);
  const batch = normalizeBatch(entry.batch);
  const quantity = Number(entry.quantity);
  const asOfDateRaw = String(entry.asOfDate || '').trim();
  const asOfDate = _normalizeIsoDate(asOfDateRaw);

  if (!branchCode || !itemName || !asOfDateRaw) {
    throw httpError(400, prefix + 'Branch, item name, and date are required.');
  }
  if (!validBranchCodes.has(branchCode)) {
    throw httpError(400, prefix + '"' + branchCode + '" is not a recognized branch code.');
  }
  if (isNaN(quantity) || quantity < 0) {
    throw httpError(400, prefix + 'Quantity must be a non-negative number.');
  }
  if (!asOfDate || isNaN(new Date(asOfDate).getTime())) {
    throw httpError(400, prefix + 'Date must be YYYY-MM-DD or DD-MM-YYYY (e.g. 2025-09-04 or 04-09-2025).');
  }

  return {
    branch_code: branchCode,
    item_name: itemName,
    batch: batch,
    quantity: quantity,
    as_of_date: asOfDate,
    updated_by: userId,
    updated_at: new Date().toISOString()
  };
}

async function _validBranchCodeSet() {
  const { data, error } = await supabase.from('branches').select('code');
  if (error) throw httpError(500, 'Failed to load branches: ' + error.message);
  return new Set((data || []).map(function (b) { return b.code; }));
}

async function upsertOpeningStock(session, entry) {
  const codes = await _validBranchCodeSet();
  const row = _validateOpeningRow(entry || {}, codes, session.userId, '');

  const { error } = await supabase
    .from('opening_stock')
    .upsert(row, { onConflict: 'branch_code,item_name,batch' });
  if (error) throw httpError(500, 'Failed to save opening stock: ' + error.message);

  await logActivity(session.username, 'Set Opening Stock', 'Set opening stock for ' + row.item_name + (row.batch ? (' (Batch: ' + row.batch + ')') : '') + ' to ' + row.quantity + ' at branch ' + row.branch_code);

  return { success: true };
}

// Bulk CSV upload. All-or-nothing: every row is validated first and the
// errors are reported with line numbers; nothing is written unless the whole
// file is clean. Re-uploading a corrected file is safe (upsert semantics).
async function bulkUpsertOpeningStock(session, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw httpError(400, 'No rows found in the uploaded file.');
  }
  if (rows.length > 20000) {
    throw httpError(400, 'Too many rows in one upload (max 20,000). Split the file.');
  }

  const codes = await _validBranchCodeSet();
  const validated = [];
  const errors = [];

  rows.forEach(function (entry, i) {
    try {
      validated.push(_validateOpeningRow(entry, codes, session.userId, 'Row ' + (i + 2)));
    } catch (e) {
      errors.push(e.message);
    }
  });

  // Same branch+item+batch appearing twice in one file would make the upsert
  // ambiguous — flag as an error instead of silently keeping one.
  const seen = new Map();
  validated.forEach(function (r) {
    const key = r.branch_code + '|' + r.item_name + '|' + r.batch;
    if (seen.has(key)) {
      errors.push('Duplicate row for ' + r.branch_code + ' / ' + r.item_name + ' / batch "' + r.batch + '" — each branch+item+batch may appear only once.');
    }
    seen.set(key, true);
  });

  if (errors.length) {
    return { success: false, saved: 0, errors: errors.slice(0, 50), totalErrors: errors.length };
  }

  const CHUNK = 500;
  for (let start = 0; start < validated.length; start += CHUNK) {
    const { error } = await supabase
      .from('opening_stock')
      .upsert(validated.slice(start, start + CHUNK), { onConflict: 'branch_code,item_name,batch' });
    if (error) throw httpError(500, 'Failed while saving rows ' + (start + 1) + '+: ' + error.message);
  }

  await logActivity(session.username, 'Bulk Opening Stock', 'Bulk uploaded ' + validated.length + ' opening stock records.');

  return { success: true, saved: validated.length, errors: [] };
}

async function createConversion(session, entry) {
  entry = entry || {};
  const branchCode = entry.branchCode;
  const fromItemName = normalizeItemName(entry.fromItemName);
  const fromBatch = normalizeBatch(entry.fromBatch);
  const fromQuantity = Number(entry.fromQuantity);
  const toItemName = normalizeItemName(entry.toItemName);
  const toBatch = normalizeBatch(entry.toBatch);
  const toQuantity = Number(entry.toQuantity);
  const notes = entry.notes || null;

  if (session.role === 'BRANCH' && branchCode !== session.branchCode) {
    throw httpError(403, 'You can only record conversions for your own branch.');
  }
  if (!branchCode || !fromItemName || !toItemName) {
    throw httpError(400, 'Branch, source item, and output item are required.');
  }
  if (!(fromQuantity > 0) || !(toQuantity > 0)) {
    throw httpError(400, 'Quantities must be greater than zero.');
  }

  const ledger = await getItemLedger(branchCode);
  const sourceRow = ledger.find(function (r) { return r.item_name === fromItemName && r.batch === fromBatch; });
  const available = sourceRow ? Number(sourceRow.closing_qty) : 0;
  if (fromQuantity > available) {
    throw httpError(400, 'Only ' + available + ' available in ' + fromItemName + (fromBatch ? ('-' + fromBatch) : '') + ' — cannot consume ' + fromQuantity + '.');
  }

  const { error } = await supabase.from('stock_conversions').insert({
    branch_code: branchCode,
    from_item_name: fromItemName,
    from_batch: fromBatch,
    from_quantity: fromQuantity,
    to_item_name: toItemName,
    to_batch: toBatch,
    to_quantity: toQuantity,
    notes: notes,
    created_by: session.userId
  });
  if (error) throw httpError(500, 'Failed to save conversion: ' + error.message);

  await logActivity(session.username, 'Record Conversion', 'Converted ' + fromItemName + (fromBatch ? ('-' + fromBatch) : '') + ' x ' + fromQuantity + ' to ' + toItemName + (toBatch ? ('-' + toBatch) : '') + ' x ' + toQuantity + ' at branch ' + branchCode);

  return { success: true };
}

async function getConversions(branchCode) {
  let query = supabase
    .from('stock_conversions')
    .select('id,branch_code,from_item_name,from_batch,from_quantity,to_item_name,to_batch,to_quantity,notes,created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (branchCode) query = query.eq('branch_code', branchCode);

  const { data, error } = await query;
  if (error) throw httpError(500, 'Failed to load conversions: ' + error.message);
  return data || [];
}

async function getAdminSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value');
  if (error) {
    if (error.code === '42P01') {
      throw httpError(500, 'Database table "app_settings" is missing. Please execute the SQL patch script in "supabase/patch_005_settings.sql" in your Supabase SQL Editor.');
    }
    throw httpError(500, 'Failed to fetch settings: ' + error.message);
  }
  const settings = { googleSpreadsheetId: '', googleSheetName: 'RAW_DATA', googleReturnsSheetName: 'RAW_DATA_SALE_RETURN' };
  if (data) {
    data.forEach(function (row) {
      if (row.key === 'google_spreadsheet_id') settings.googleSpreadsheetId = row.value || '';
      if (row.key === 'google_sheet_name') settings.googleSheetName = row.value || 'RAW_DATA';
      if (row.key === 'google_returns_sheet_name') settings.googleReturnsSheetName = row.value || 'RAW_DATA_SALE_RETURN';
    });
  }
  return settings;
}

async function saveAdminSettings(session, settings) {
  const sheetId = String(settings.googleSpreadsheetId || '').trim();
  const sheetName = String(settings.googleSheetName || 'RAW_DATA').trim();
  const returnsSheetName = String(settings.googleReturnsSheetName || 'RAW_DATA_SALE_RETURN').trim();
  
  const { error: err1 } = await supabase
    .from('app_settings')
    .upsert({ key: 'google_spreadsheet_id', value: sheetId, updated_at: new Date().toISOString() });
  if (err1) {
    if (err1.code === '42P01') {
      throw httpError(500, 'Database table "app_settings" is missing. Please execute the SQL patch script in "supabase/patch_005_settings.sql" in your Supabase SQL Editor.');
    }
    throw httpError(500, 'Failed to save settings: ' + err1.message);
  }

  const { error: err2 } = await supabase
    .from('app_settings')
    .upsert({ key: 'google_sheet_name', value: sheetName, updated_at: new Date().toISOString() });
  if (err2) {
    throw httpError(500, 'Failed to save settings: ' + err2.message);
  }

  const { error: err3 } = await supabase
    .from('app_settings')
    .upsert({ key: 'google_returns_sheet_name', value: returnsSheetName, updated_at: new Date().toISOString() });
  if (err3) {
    throw httpError(500, 'Failed to save settings: ' + err3.message);
  }
  
  await logActivity(session.username, 'Update Settings', 'Updated spreadsheet configuration. Sales: ' + sheetName + ', Returns: ' + returnsSheetName);

  return { success: true };
}

function parseCSV(text) {
  var lines = [];
  var row = [];
  var inQuotes = false;
  var start = 0;
  var len = text.length;

  for (var i = 0; i < len; i++) {
    var c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      var cell = text.substring(start, i);
      if (cell.length >= 2 && cell[0] === '"' && cell[cell.length - 1] === '"') {
        cell = cell.slice(1, -1);
      }
      if (cell.indexOf('""') !== -1) {
        cell = cell.replace(/""/g, '"');
      }
      row.push(cell);
      start = i + 1;
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      var cell = text.substring(start, i);
      if (cell.length >= 2 && cell[0] === '"' && cell[cell.length - 1] === '"') {
        cell = cell.slice(1, -1);
      }
      if (cell.indexOf('""') !== -1) {
        cell = cell.replace(/""/g, '"');
      }
      row.push(cell);
      lines.push(row);
      row = [];
      if (c === '\r' && text[i+1] === '\n') {
        i++;
      }
      start = i + 1;
    }
  }
  if (start < len) {
    var cell = text.substring(start);
    if (cell.length >= 2 && cell[0] === '"' && cell[cell.length - 1] === '"') {
      cell = cell.slice(1, -1);
    }
    if (cell.indexOf('""') !== -1) {
      cell = cell.replace(/""/g, '"');
    }
    row.push(cell);
    lines.push(row);
  }
  return lines;
}

function _normalize(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Upsert rows in chunks with several chunks in flight at once, to keep total
// wall-clock inside the serverless function timeout. The payload is de-duped on
// the conflict key upstream, so chunks touch disjoint keys and never contend.
// Throws on the first failed chunk. Returns the number of rows written.
async function _upsertChunks(table, rows, conflict) {
  const CHUNK = 5000;
  const CONCURRENCY = 4;
  const chunks = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  let next = 0;
  let done = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const { error } = await supabase.from(table).upsert(chunk, { onConflict: conflict });
      if (error) throw httpError(500, 'Upsert failed on ' + table + ': ' + error.message);
      done += chunk.length;
    }
  }
  const pool = [];
  for (let w = 0; w < Math.min(CONCURRENCY, chunks.length); w++) pool.push(worker());
  await Promise.all(pool);
  return done;
}

async function syncGoogleSheet(triggeredBy, mode) {
  triggeredBy = triggeredBy || 'SYSTEM';
  if (mode === 'HARD_RESET') {
    triggeredBy += ' (Hard Reset)';
  } else {
    triggeredBy += ' (Append)';
  }
  let upsertedCount = 0;
  
  try {
    const settings = await getAdminSettings();
    const googleSpreadsheetId = settings.googleSpreadsheetId;
    const googleSheetName = settings.googleSheetName || 'RAW_DATA';
    
    if (!googleSpreadsheetId) {
      throw httpError(400, 'Google Spreadsheet ID is not configured. Go to Settings and configure it.');
    }

    if (mode === 'HARD_RESET') {
      const { error: delErr } = await supabase
        .from('sales_transactions')
        .delete()
        .neq('docnum', 'dummy_nonexistent_12345');
      if (delErr) {
        throw httpError(500, 'Hard reset failed to clear transactions: ' + delErr.message);
      }

      const { error: delRetErr } = await supabase
        .from('sales_returns')
        .delete()
        .neq('docnum', 'dummy_nonexistent_12345');
      if (delRetErr) {
        throw httpError(500, 'Hard reset failed to clear sales returns: ' + delRetErr.message);
      }
    }

    const csvUrl = 'https://docs.google.com/spreadsheets/d/' + googleSpreadsheetId + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(googleSheetName);
    let response;
    try {
      response = await fetch(csvUrl);
    } catch (e) {
      throw httpError(502, 'Failed to connect to Google Sheets: ' + e.message);
    }

    if (!response.ok) {
      throw httpError(502, 'Failed to download Google Sheet. Verify that the sheet is shared as "Anyone with the link can view" and that the sheet tab name is correct.');
    }

    const csvText = await response.text();
    const parsedRows = parseCSV(csvText);

    if (parsedRows.length < 2) {
      throw httpError(400, 'The sheet "' + googleSheetName + '" contains no rows to sync.');
    }

    const headers = parsedRows[0].map(function (h) { return String(h || '').trim().toUpperCase(); });
    
    const colIndex = {
      BRANCH_NAME: headers.indexOf('BRANCH_NAME'),
      DATE: headers.indexOf('DATE'),
      BILL_DATE: headers.indexOf('BILL_DATE'),
      SAP_BILL_NO: headers.indexOf('SAP_BILL_NO'),
      FMS_BILL_NO: headers.indexOf('FMS BILL NO'),
      CUSTOMER_CODE: headers.indexOf('CUSTOMER_CODE'),
      CUSTOMER_NAME: headers.indexOf('CUSTOMER_NAME'),
      ITEM_CODE: headers.indexOf('ITEM_CODE'),
      ITEM_DESCRIPTION: headers.indexOf('ITEM_DESCRIPTION'),
      BATCH: headers.indexOf('BATCH'),
      HSN: headers.indexOf('HSN'),
      THICKNESS: headers.indexOf('THICKNESS'),
      THICKNESS_TYPE: headers.indexOf('THICKNESS_TYPE'),
      SIZE: headers.indexOf('SIZE'),
      FINISH: headers.indexOf('FINISH'),
      BRAND: headers.indexOf('BRAND'),
      GST_RATE: headers.indexOf('GST_RATE'),
      QUANTITY: headers.indexOf('QUANTITY'),
      CUSTOMER_GST: headers.indexOf('CUTOMER_GST'),
      NET_REVENUE: headers.indexOf('NET_REVENUE'),
      CGST_AMT: headers.indexOf('CGST_AMT'),
      SGST_AMT: headers.indexOf('SGST_AMT'),
      IGST_AMT: headers.indexOf('IGST_AMT'),
      REVENUE_WITH_GST: headers.indexOf('REVENUE_WITH_GST'),
      DOCTOTAL: headers.indexOf('DOCTOTAL'),
      WTAMOUNT: headers.indexOf('WTAMOUNT'),
      UNIT_OF_PACKG: headers.indexOf('UNIT_OF_PACKG'),
      TOTAL_SQM: headers.indexOf('TOTAL_SQM'),
      RATE_PER_SQM: headers.indexOf('RATE_PER_SQM')
    };

    if (colIndex.SAP_BILL_NO === -1 || colIndex.ITEM_CODE === -1 || colIndex.BRANCH_NAME === -1) {
      throw httpError(400, 'Required columns (SAP_BILL_NO, ITEM_CODE, BRANCH_NAME) are missing in the Google Sheet.');
    }

    const { data: dbBranches, error: brErr } = await supabase.from('branches').select('code,name');
    if (brErr) throw httpError(500, 'Failed to fetch branch map: ' + brErr.message);
    
    const branchMap = {};
    dbBranches.forEach(function (b) {
      branchMap[_normalize(b.name)] = b.code;
    });

    const VIRGO_ROOT_NAMES = ['VIRGO LAMINATES', 'VIRGO ACP INDUSTRIES', 'VIRGO ALUMINUM', 'VIRGO ALUMINIUM'];
    
    const CITY_KEYWORDS = [
      ['GUJRAT', 'GUJRAT-BRANCH'],
      ['AHMEDABAD', 'AHMEDABAD-FACTORY'],
      ['BANGALORE', 'BANGALORE-BRANCH'],
      ['RANCHI', 'RANCHI-BRANCH'],
      ['PANCHKULA', 'PANCHKULA-BRANCH'],
      ['MUMBAI', 'MUMBAI-BRANCH'],
      ['LUCKNOW', 'LUCKNOW-BRANCH'],
      ['KOLKATA', 'KOLKATA-BRANCH'],
      ['PATNA', 'PATNA-BRANCH'],
      ['KOCHI', 'KOCHI-BRANCH'],
      ['JAIPUR', 'JAIPUR-BRANCH'],
      ['INDORE', 'INDORE-BRANCH'],
      ['HYDERABAD', 'HYDERABAD-BRANCH'],
      ['DELHI', 'DELHI-BRANCH'],
      ['CHENNAI', 'CHENNAI-BRANCH'],
      ['GUWAHATI', 'GUWAHATI-BRANCH'],
      ['RAIPUR', 'RAIPUR-BRANCH']
    ];

    function _num(val) {
      const n = Number(val);
      return isNaN(n) ? null : n;
    }

    function _fmtDate(val) {
      if (!val) return null;
      const d = new Date(val);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }

    const payload = [];
    const missingBranches = new Set();

    for (let i = 1; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      if (row.length < 5) continue;
      
      const docnum = String(row[colIndex.SAP_BILL_NO] || '').trim();
      const itemCode = String(row[colIndex.ITEM_CODE] || '').trim();
      if (!docnum || !itemCode) continue;

      const branchName = String(row[colIndex.BRANCH_NAME] || '').trim();
      const customerName = String(row[colIndex.CUSTOMER_NAME] || '').trim();
      
      const sourceBranchCode = branchMap[_normalize(branchName)] || null;
      if (!sourceBranchCode) {
        if (branchName) missingBranches.add(branchName);
      }
      
      // A row is a BRANCH-TRANSFER only when the customer name is Virgo-internal
      // AND it resolves to a real destination branch. Anything that does not map
      // to a known branch (a place with no branch, or a plain "(ACP)" with no
      // city) is treated as a normal CUSTOMER ORDER. This removes the old
      // "needs destination tagging" state entirely — transfers are never left
      // with a null destination.
      const upperName = customerName.toUpperCase();
      const isVirgoInternal = VIRGO_ROOT_NAMES.some(function (root) { return upperName.indexOf(root) !== -1; });

      let destinationBranchCode = null;
      if (isVirgoInternal) {
        for (let c = 0; c < CITY_KEYWORDS.length; c++) {
          if (upperName.indexOf(CITY_KEYWORDS[c][0]) !== -1) {
            destinationBranchCode = CITY_KEYWORDS[c][1];
            break;
          }
        }
      }

      const isTransfer = destinationBranchCode !== null;
      const orderType = isTransfer ? 'BRANCH-TRANSFER' : 'CUSTOMER ORDER';

      payload.push({
        doc_date: _fmtDate(row[colIndex.DATE]) || new Date().toISOString().slice(0, 10),
        bill_date: _fmtDate(row[colIndex.BILL_DATE]),
        docnum: docnum,
        bill_no: String(row[colIndex.FMS_BILL_NO] || '').trim() || null,
        customer_code: String(row[colIndex.CUSTOMER_CODE] || '').trim() || null,
        customer_name: customerName || null,
        item_code: itemCode,
        item_description: String(row[colIndex.ITEM_DESCRIPTION] || '').trim() || null,
        batch: String(row[colIndex.BATCH] || '').trim().toUpperCase() || '',
        hsn: String(row[colIndex.HSN] || '').trim() || null,
        thickness: String(row[colIndex.THICKNESS] || '').trim() || null,
        thickness_type: String(row[colIndex.THICKNESS_TYPE] || '').trim() || null,
        size: String(row[colIndex.SIZE] || '').trim() || null,
        finish: String(row[colIndex.FINISH] || '').trim() || null,
        brand: String(row[colIndex.BRAND] || '').trim() || null,
        gst_rate: _num(row[colIndex.GST_RATE]),
        quantity: _num(row[colIndex.QUANTITY]) || 0,
        customer_gstin: String(row[colIndex.CUSTOMER_GST] || '').trim() || null,
        net_revenue: _num(row[colIndex.NET_REVENUE]),
        cgst_amt: _num(row[colIndex.CGST_AMT]),
        sgst_amt: _num(row[colIndex.SGST_AMT]),
        igst_amt: _num(row[colIndex.IGST_AMT]),
        revenue_with_gst: _num(row[colIndex.REVENUE_WITH_GST]),
        doc_total: _num(row[colIndex.DOCTOTAL]),
        wt_amount: _num(row[colIndex.WTAMOUNT]),
        unit_of_packg: String(row[colIndex.UNIT_OF_PACKG] || '').trim() || null,
        total_sqm: _num(row[colIndex.TOTAL_SQM]),
        rate_per_sqm: _num(row[colIndex.RATE_PER_SQM]),
        source_branch_code: sourceBranchCode,
        order_type: orderType,
        destination_branch_code: destinationBranchCode
      });
    }

    if (payload.length === 0) {
      throw httpError(400, 'No valid transaction records found in the sheet.');
    }

    // Aggregate payload to avoid PG "ON CONFLICT DO UPDATE command cannot affect row a second time" error and preserve total quantities
    const uniquePayloadMap = {};
    payload.forEach(function (row) {
      const key = row.docnum + '|' + row.item_code + '|' + row.batch;
      if (uniquePayloadMap[key]) {
        uniquePayloadMap[key].quantity = (uniquePayloadMap[key].quantity || 0) + (row.quantity || 0);
        uniquePayloadMap[key].net_revenue = (uniquePayloadMap[key].net_revenue || 0) + (row.net_revenue || 0);
        uniquePayloadMap[key].cgst_amt = (uniquePayloadMap[key].cgst_amt || 0) + (row.cgst_amt || 0);
        uniquePayloadMap[key].sgst_amt = (uniquePayloadMap[key].sgst_amt || 0) + (row.sgst_amt || 0);
        uniquePayloadMap[key].igst_amt = (uniquePayloadMap[key].igst_amt || 0) + (row.igst_amt || 0);
        uniquePayloadMap[key].revenue_with_gst = (uniquePayloadMap[key].revenue_with_gst || 0) + (row.revenue_with_gst || 0);
        uniquePayloadMap[key].wt_amount = (uniquePayloadMap[key].wt_amount || 0) + (row.wt_amount || 0);
        uniquePayloadMap[key].total_sqm = (uniquePayloadMap[key].total_sqm || 0) + (row.total_sqm || 0);
      } else {
        uniquePayloadMap[key] = row;
      }
    });
    const deduplicatedPayload = Object.values(uniquePayloadMap);

    upsertedCount = await _upsertChunks('sales_transactions', deduplicatedPayload, 'docnum,item_code,batch');

    // Sync Sales Returns (googleReturnsSheetName)
    let returnsCount = 0;
    let returnsError = null;
    try {
      const googleReturnsSheetName = settings.googleReturnsSheetName || 'RAW_DATA_SALE_RETURN';
      const csvUrlReturns = 'https://docs.google.com/spreadsheets/d/' + googleSpreadsheetId + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(googleReturnsSheetName);
      const responseReturns = await fetch(csvUrlReturns);
      if (responseReturns.ok) {
        const csvTextReturns = await responseReturns.text();
        const parsedRowsReturns = parseCSV(csvTextReturns);
        if (parsedRowsReturns.length >= 2) {
          const headersReturns = parsedRowsReturns[0].map(function (h) { return String(h || '').trim().toUpperCase(); });
          
          const colIndexReturns = {
            BRANCH_NAME: headersReturns.indexOf('BRANCH_NAME'),
            DATE: headersReturns.indexOf('DATE'),
            BILL_DATE: headersReturns.indexOf('BILL_DATE'),
            SAP_BILL_NO: headersReturns.indexOf('SAP_BILL_NO'),
            BILL_NO: headersReturns.indexOf('BILL NO'),
            CUSTOMER_CODE: headersReturns.indexOf('CUSTOMER_CODE'),
            CUSTOMER_NAME: headersReturns.indexOf('CUSTOMER_NAME'),
            ITEM_CODE: headersReturns.indexOf('ITEM_CODE'),
            ITEM_DESCRIPTION: headersReturns.indexOf('ITEM_DESCRIPTION'),
            BATCH: headersReturns.indexOf('BATCH'),
            HSN: headersReturns.indexOf('HSN'),
            GST_RATE: headersReturns.indexOf('GST_RATE'),
            QUANTITY: headersReturns.indexOf('QUANTITY'),
            BILL_GSTIN: headersReturns.indexOf('BILL_GSTIN'),
            LINETOTAL: headersReturns.indexOf('LINETOTAL'),
            CGST_AMT: headersReturns.indexOf('CGST_AMT'),
            SGST_AMT: headersReturns.indexOf('SGST_AMT'),
            IGST_AMT: headersReturns.indexOf('IGST_AMT'),
            DOCTOTAL: headersReturns.indexOf('DOCTOTAL'),
            WTAMOUNT: headersReturns.indexOf('WTAMOUNT'),
            THICKNESS: headersReturns.indexOf('THICKNESS'),
            THICKNESS_TYPE: headersReturns.indexOf('THICKNESS_TYPE'),
            SIZE: headersReturns.indexOf('SIZE'),
            FINISH: headersReturns.indexOf('FINISH'),
            BRAND: headersReturns.indexOf('BRAND')
          };

          if (colIndexReturns.SAP_BILL_NO !== -1 && colIndexReturns.ITEM_CODE !== -1 && colIndexReturns.BRANCH_NAME !== -1) {


            const payloadReturns = [];
            for (let i = 1; i < parsedRowsReturns.length; i++) {
              const row = parsedRowsReturns[i];
              if (row.length < 5) continue;

              const docnum = String(row[colIndexReturns.SAP_BILL_NO] || '').trim();
              const itemCode = String(row[colIndexReturns.ITEM_CODE] || '').trim();
              if (!docnum || !itemCode) continue;

              const branchName = String(row[colIndexReturns.BRANCH_NAME] || '').trim();
              const sourceBranchCode = branchMap[_normalize(branchName)] || null;

              payloadReturns.push({
                doc_date: _fmtDate(row[colIndexReturns.DATE]) || new Date().toISOString().slice(0, 10),
                bill_date: _fmtDate(row[colIndexReturns.BILL_DATE]),
                docnum: docnum,
                bill_no: String(row[colIndexReturns.BILL_NO] || '').trim() || null,
                customer_code: String(row[colIndexReturns.CUSTOMER_CODE] || '').trim() || null,
                customer_name: String(row[colIndexReturns.CUSTOMER_NAME] || '').trim() || null,
                item_code: itemCode,
                item_description: String(row[colIndexReturns.ITEM_DESCRIPTION] || '').trim() || null,
                batch: String(row[colIndexReturns.BATCH] || '').trim().toUpperCase() || '',
                hsn: String(row[colIndexReturns.HSN] || '').trim() || null,
                thickness: String(row[colIndexReturns.THICKNESS] || '').trim() || null,
                thickness_type: String(row[colIndexReturns.THICKNESS_TYPE] || '').trim() || null,
                size: String(row[colIndexReturns.SIZE] || '').trim() || null,
                finish: String(row[colIndexReturns.FINISH] || '').trim() || null,
                brand: String(row[colIndexReturns.BRAND] || '').trim() || null,
                gst_rate: _num(row[colIndexReturns.GST_RATE]),
                quantity: _num(row[colIndexReturns.QUANTITY]) || 0,
                customer_gstin: String(row[colIndexReturns.BILL_GSTIN] || '').trim() || null,
                net_revenue: _num(row[colIndexReturns.LINETOTAL]),
                cgst_amt: _num(row[colIndexReturns.CGST_AMT]),
                sgst_amt: _num(row[colIndexReturns.SGST_AMT]),
                igst_amt: _num(row[colIndexReturns.IGST_AMT]),
                revenue_with_gst: _num(row[colIndexReturns.DOCTOTAL]),
                doc_total: _num(row[colIndexReturns.DOCTOTAL]),
                wt_amount: _num(row[colIndexReturns.WTAMOUNT]),
                source_branch_code: sourceBranchCode
              });
            }

            // Aggregate returns to avoid PG "ON CONFLICT DO UPDATE" error and preserve total quantities
            const uniqueReturnsMap = {};
            payloadReturns.forEach(function (row) {
              const key = row.docnum + '|' + row.item_code + '|' + row.batch;
              if (uniqueReturnsMap[key]) {
                uniqueReturnsMap[key].quantity = (uniqueReturnsMap[key].quantity || 0) + (row.quantity || 0);
                uniqueReturnsMap[key].net_revenue = (uniqueReturnsMap[key].net_revenue || 0) + (row.net_revenue || 0);
                uniqueReturnsMap[key].cgst_amt = (uniqueReturnsMap[key].cgst_amt || 0) + (row.cgst_amt || 0);
                uniqueReturnsMap[key].sgst_amt = (uniqueReturnsMap[key].sgst_amt || 0) + (row.sgst_amt || 0);
                uniqueReturnsMap[key].igst_amt = (uniqueReturnsMap[key].igst_amt || 0) + (row.igst_amt || 0);
                uniqueReturnsMap[key].revenue_with_gst = (uniqueReturnsMap[key].revenue_with_gst || 0) + (row.revenue_with_gst || 0);
                uniqueReturnsMap[key].doc_total = (uniqueReturnsMap[key].doc_total || 0) + (row.doc_total || 0);
                uniqueReturnsMap[key].wt_amount = (uniqueReturnsMap[key].wt_amount || 0) + (row.wt_amount || 0);
              } else {
                uniqueReturnsMap[key] = row;
              }
            });
            const deduplicatedReturns = Object.values(uniqueReturnsMap);

            returnsCount = await _upsertChunks('sales_returns', deduplicatedReturns, 'docnum,item_code,batch');
          } else {
            returnsError = 'Returns sheet is missing required columns (SAP_BILL_NO, ITEM_CODE, BRANCH_NAME).';
          }
        }
      } else if (responseReturns && !responseReturns.ok) {
        returnsError = 'Could not download the returns sheet (HTTP ' + responseReturns.status + '). Check the tab name and sharing.';
      }
    } catch (err) {
      console.error('Error syncing sales returns:', err);
      returnsError = err.message || 'Unknown error while syncing sales returns.';
    }

    // The returns sync is best-effort — a broken returns sheet must not fail the
    // whole sync — but its failure is surfaced in the log so it isn't silent.
    let detailsStr = 'Successfully synced ' + upsertedCount + ' transactions and ' + returnsCount + ' sales returns.';
    if (returnsError) {
      detailsStr += ' WARNING: sales returns did not fully sync — ' + returnsError;
    }
    if (missingBranches.size > 0) {
      detailsStr += ' Skipped unrecognized branch names: ' + Array.from(missingBranches).join(', ');
    }

    await supabase.from('sync_logs').insert({
      triggered_by: triggeredBy,
      status: returnsError ? 'PARTIAL' : 'SUCCESS',
      synced_count: upsertedCount,
      details: detailsStr
    });

    return { success: true, synced: upsertedCount, returnsSynced: returnsCount, returnsError: returnsError };
  } catch (err) {
    await supabase.from('sync_logs').insert({
      triggered_by: triggeredBy,
      status: 'FAILED',
      synced_count: 0,
      details: err.message || 'Unknown sync failure.'
    });
    throw err;
  }
}

async function getSyncLogs() {
  const { data, error } = await supabase
    .from('sync_logs')
    .select('id, triggered_by, status, synced_count, details, created_at')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw httpError(500, 'Failed to fetch sync logs: ' + error.message);
  return data || [];
}

async function changeUserPassword(session, currentPassword, newPassword) {
  if (!session || !session.userId) throw httpError(401, 'Not authenticated');

  const { data: user, error: fetchErr } = await supabase
    .from('user_profiles')
    .select('password_hash')
    .eq('id', session.userId)
    .limit(1)
    .single();
  if (fetchErr || !user) throw httpError(404, 'User profile not found');

  const currentHash = hashPassword(currentPassword);
  if (user.password_hash !== currentHash) {
    throw httpError(400, 'Current password is incorrect.');
  }

  const newHash = hashPassword(newPassword);
  const { error: updateErr } = await supabase
    .from('user_profiles')
    .update({ password_hash: newHash })
    .eq('id', session.userId);
  if (updateErr) throw httpError(500, 'Failed to update password: ' + updateErr.message);

  await logActivity(session.username, 'Change Password', 'User updated password successfully.');

  return { success: true };
}

async function submitReconciliation(session, entry) {
  entry = entry || {};
  const branchCode = entry.branchCode;
  const itemName = normalizeItemName(entry.itemName);
  const batch = normalizeBatch(entry.batch);
  const ledgerQty = Number(entry.ledgerQty || 0);
  const physicalQty = Number(entry.physicalQty || 0);

  if (session.role === 'BRANCH' && branchCode !== session.branchCode) {
    throw httpError(403, 'You can only submit reconciliations for your own branch.');
  }
  if (session.role === 'HOD') {
    const allowed = await _hodBranchCodes(session.userId);
    if (allowed.indexOf(branchCode) === -1) {
      throw httpError(403, 'You are not authorized to reconcile stock for this branch.');
    }
  }

  if (!branchCode || !itemName) {
    throw httpError(400, 'Branch and item name are required.');
  }
  if (isNaN(physicalQty) || physicalQty < 0) {
    throw httpError(400, 'Physical quantity must be a non-negative number.');
  }

  const variance = physicalQty - ledgerQty;

  const { error } = await supabase.from('physical_reconciliations').insert({
    branch_code: branchCode,
    audited_by: session.username,
    item_name: itemName,
    batch: batch,
    ledger_qty: ledgerQty,
    physical_qty: physicalQty,
    variance: variance
  });

  if (error) throw httpError(500, 'Failed to save reconciliation: ' + error.message);

  await logActivity(
    session.username,
    'Stock Reconciliation',
    'Reconciled ' + itemName + (batch ? ('-' + batch) : '') + ' at ' + branchCode + '. Physical: ' + physicalQty + ', Ledger: ' + ledgerQty + ', Variance: ' + variance
  );

  return { success: true, variance: variance };
}

async function getReconciliations(session) {
  let query = supabase
    .from('physical_reconciliations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (session.role === 'BRANCH') {
    query = query.eq('branch_code', session.branchCode);
  } else if (session.role === 'HOD') {
    const allowed = await _hodBranchCodes(session.userId);
    query = query.in('branch_code', allowed);
  }

  const { data, error } = await query;
  if (error) throw httpError(500, 'Failed to fetch reconciliations: ' + error.message);
  return data || [];
}

async function submitBulkReconciliations(session, rows) {
  if (!rows || !Array.isArray(rows)) {
    throw httpError(400, 'Invalid rows payload.');
  }

  const validBranchCodes = await _validBranchCodeSet();
  let allowedBranches = null;
  if (session.role === 'HOD') {
    allowedBranches = new Set(await _hodBranchCodes(session.userId));
  }

  const inserts = [];
  const branchCodes = [];
  const errors = [];

  // Validate every row and collect ALL problems with line numbers, rather than
  // failing on the first — so the uploader can fix the whole file in one pass.
  // Nothing is written unless the entire file is clean.
  for (let i = 0; i < rows.length; i++) {
    const line = i + 2; // header is line 1
    const entry = rows[i];

    let branchCode = '';
    if (session.role === 'BRANCH') {
      branchCode = session.branchCode;
    } else {
      branchCode = String(entry.branchCode || '').trim().toUpperCase();
    }

    const itemName = normalizeItemName(entry.itemName);
    const batch = normalizeBatch(entry.batch);
    const physicalQty = Number(entry.physicalQty);

    if (!branchCode) {
      errors.push(`Line ${line}: Branch Code is required.`);
      continue;
    }
    if (!validBranchCodes.has(branchCode)) {
      errors.push(`Line ${line}: "${branchCode}" is not a recognized branch code.`);
      continue;
    }
    if (session.role === 'BRANCH' && branchCode !== session.branchCode) {
      errors.push(`Line ${line}: You can only submit reconciliations for your own branch.`);
      continue;
    }
    if (session.role === 'HOD' && allowedBranches && !allowedBranches.has(branchCode)) {
      errors.push(`Line ${line}: You are not authorized to reconcile stock for "${branchCode}".`);
      continue;
    }
    if (!itemName) {
      errors.push(`Line ${line}: Item Name is required.`);
      continue;
    }
    if (isNaN(physicalQty) || physicalQty < 0) {
      errors.push(`Line ${line}: Physical Counted Qty must be a non-negative number.`);
      continue;
    }

    inserts.push({
      branch_code: branchCode,
      audited_by: session.username,
      item_name: itemName,
      batch: batch,
      physical_qty: physicalQty,
      ledger_qty: 0,
      variance: 0
    });

    if (branchCodes.indexOf(branchCode) === -1) {
      branchCodes.push(branchCode);
    }
  }

  if (errors.length) {
    return { success: false, count: 0, errors: errors.slice(0, 50), totalErrors: errors.length };
  }

  if (inserts.length === 0) {
    return { success: true, count: 0 };
  }

  const ledgerRows = await _fetchLedgerPaged(function (q) {
    return q.in('branch_code', branchCodes);
  }, 'branch_code, item_name, batch, closing_qty');

  const ledgerMap = {};
  if (ledgerRows) {
    ledgerRows.forEach(r => {
      const key = r.branch_code + '||' + r.item_name + '||' + (r.batch || '');
      ledgerMap[key] = Number(r.closing_qty || 0);
    });
  }

  inserts.forEach(ins => {
    const key = ins.branch_code + '||' + ins.item_name + '||' + (ins.batch || '');
    ins.ledger_qty = ledgerMap[key] || 0;
    ins.variance = ins.physical_qty - ins.ledger_qty;
  });

  const { error } = await supabase.from('physical_reconciliations').insert(inserts);
  if (error) {
    throw httpError(500, 'Failed to save bulk reconciliations: ' + error.message);
  }

  await logActivity(
    session.username,
    'Bulk Stock Reconciliation',
    'Reconciled ' + inserts.length + ' stock records via CSV upload.'
  );

  return { success: true, count: inserts.length };
}

/* ============================================================================
   ITEM-WISE VARIANCE REPORT
   ========================================================================== */

// Representative unit rate per (normalized) item name, taken from the most
// recent sales transaction that carries a rate. Used to value variances in ₹.
let _rateMapCache = { map: null, timestamp: 0 };
const RATE_MAP_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

async function _itemRateMap() {
  const now = Date.now();
  if (_rateMapCache.map && (now - _rateMapCache.timestamp) < RATE_MAP_TTL_MS) {
    return _rateMapCache.map;
  }

  const { data, error } = await supabase
    .from('sales_transactions')
    .select('item_description, rate_per_sqm, doc_date')
    .not('rate_per_sqm', 'is', null)
    .order('doc_date', { ascending: false })
    .limit(10000);
  if (error) {
    console.error('Failed to build item rate map: ' + error.message);
    return _rateMapCache.map || {};
  }
  const map = {};
  (data || []).forEach(function (r) {
    const name = normalizeItemName(r.item_description);
    if (name && map[name] === undefined) {
      map[name] = Number(r.rate_per_sqm);
    }
  });
  _rateMapCache = { map: map, timestamp: now };
  return map;
}

// Item-wise variance report: for every branch+item+batch that has been
// physically counted, compare the LATEST count against the CURRENT ledger
// closing qty. Role-scoped (Branch = own, HOD = assigned, Admin = all).
async function getVarianceReport(session) {
  const emptyResult = {
    rows: [],
    summary: { totalShortage: 0, totalSurplus: 0, discrepancyCount: 0, itemCount: 0, netValue: null }
  };

  // 1. Resolve branch scope (null = all branches).
  let branchScope = null;
  if (session.role === 'BRANCH') {
    if (!session.branchCode) return emptyResult;
    branchScope = [session.branchCode];
  } else if (session.role === 'HOD') {
    branchScope = await _hodBranchCodes(session.userId);
    if (branchScope.length === 0) return emptyResult;
  }

  // 2. Fetch latest physical counts, ledger closing qty, and rate map concurrently
  let recQuery = supabase
    .from('physical_reconciliations')
    .select('branch_code,item_name,batch,physical_qty,audited_by,created_at')
    .order('created_at', { ascending: false })
    .limit(5000);
  if (branchScope) recQuery = recQuery.in('branch_code', branchScope);

  const [recRes, ledger, rateMap] = await Promise.all([
    recQuery,
    _fetchLedgerPaged(function (q) {
      return branchScope ? q.in('branch_code', branchScope) : q;
    }, 'branch_code,item_name,batch,closing_qty', 'item_stock_ledger_mat'),
    _itemRateMap()
  ]);

  if (recRes.error) throw httpError(500, 'Failed to load reconciliations: ' + recRes.error.message);
  const recs = recRes.data || [];

  const latestMap = {};
  recs.forEach(function (r) {
    const key = r.branch_code + '||' + r.item_name + '||' + (r.batch || '');
    if (!latestMap[key]) latestMap[key] = r;
  });

  const ledgerMap = {};
  (ledger || []).forEach(function (r) {
    const key = r.branch_code + '||' + r.item_name + '||' + (r.batch || '');
    ledgerMap[key] = Number(r.closing_qty || 0);
  });

  // 5. Build one row per counted key, comparing against the live ledger.
  const rows = [];
  let totalShortage = 0;
  let totalSurplus = 0;
  let discrepancyCount = 0;
  let netValue = 0;
  let valueKnown = false;

  Object.keys(latestMap).forEach(function (key) {
    const rec = latestMap[key];
    const ledgerQty = ledgerMap[key] || 0;
    const physicalQty = Number(rec.physical_qty || 0);
    const variance = physicalQty - ledgerQty;
    const variancePct = ledgerQty !== 0 ? (variance / ledgerQty) * 100 : null;
    const rate = rateMap[rec.item_name];
    const varianceValue = (rate !== undefined && rate !== null && !isNaN(rate)) ? variance * rate : null;

    if (variance < 0) totalShortage += Math.abs(variance);
    else if (variance > 0) totalSurplus += variance;
    if (variance !== 0) discrepancyCount++;
    if (varianceValue !== null) { netValue += varianceValue; valueKnown = true; }

    rows.push({
      branch_code: rec.branch_code,
      item_name: rec.item_name,
      batch: rec.batch || '',
      ledger_qty: ledgerQty,
      physical_qty: physicalQty,
      variance: variance,
      variance_pct: variancePct,
      rate_per_sqm: (rate !== undefined ? rate : null),
      variance_value: varianceValue,
      counted_by: rec.audited_by,
      counted_at: rec.created_at
    });
  });

  // Largest absolute discrepancies first.
  rows.sort(function (a, b) { return Math.abs(b.variance) - Math.abs(a.variance); });

  return {
    rows: rows,
    summary: {
      totalShortage: totalShortage,
      totalSurplus: totalSurplus,
      discrepancyCount: discrepancyCount,
      itemCount: rows.length,
      netValue: valueKnown ? netValue : null
    }
  };
}

/* ============================================================================
   LEDGER-ADJUSTING RECONCILIATIONS (Phase 2)
   Applying a physical count posts a signed correction into stock_adjustments
   so the ledger closing balance matches reality. Admin / Super Admin only.
   ========================================================================== */

function _requireAdmin(session) {
  if (session.role !== 'SUPER_ADMIN' && session.role !== 'ADMIN') {
    throw httpError(403, 'Only administrators can apply stock adjustments.');
  }
}

async function _currentClosing(branchCode, itemName, batch) {
  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('closing_qty')
    .eq('branch_code', branchCode)
    .eq('item_name', itemName)
    .eq('batch', batch)
    .limit(1);
  if (error) throw httpError(500, 'Failed to load ledger: ' + error.message);
  return (data && data[0]) ? Number(data[0].closing_qty || 0) : 0;
}

// Correct one branch+item+batch to its latest physical count.
async function applyStockAdjustment(session, entry) {
  _requireAdmin(session);
  entry = entry || {};
  const branchCode = String(entry.branchCode || '').trim().toUpperCase();
  const itemName = normalizeItemName(entry.itemName);
  const batch = normalizeBatch(entry.batch);
  if (!branchCode || !itemName) throw httpError(400, 'Branch and item are required.');

  const { data: recs, error: recErr } = await supabase
    .from('physical_reconciliations')
    .select('id, physical_qty, created_at')
    .eq('branch_code', branchCode)
    .eq('item_name', itemName)
    .eq('batch', batch)
    .order('created_at', { ascending: false })
    .limit(1);
  if (recErr) throw httpError(500, 'Failed to load reconciliation: ' + recErr.message);
  const rec = recs && recs[0];
  if (!rec) throw httpError(404, 'No physical count found for this item to adjust against.');

  const closing = await _currentClosing(branchCode, itemName, batch);
  const physical = Number(rec.physical_qty || 0);
  const delta = physical - closing;
  if (Math.round(delta) === 0) {
    return { success: true, adjusted: false, message: 'Ledger already matches the physical count.', closing: closing };
  }

  const { error } = await supabase.from('stock_adjustments').insert({
    branch_code: branchCode,
    item_name: itemName,
    batch: batch,
    adjustment_qty: delta,
    reason: 'Reconciliation adjustment to physical count of ' + physical,
    reconciliation_id: rec.id,
    created_by: session.userId
  });
  if (error) throw httpError(500, 'Failed to apply adjustment: ' + error.message);

  await logActivity(session.username, 'Stock Adjustment',
    'Adjusted ' + itemName + (batch ? ('-' + batch) : '') + ' at ' + branchCode + ' by ' + (delta > 0 ? '+' : '') + delta + ' to match physical count ' + physical + ' (ledger was ' + closing + ').');

  return { success: true, adjusted: true, delta: delta, newClosing: physical };
}

// Bulk-apply corrections for a set of keys (recomputed server-side from the
// live variance report — client-supplied deltas are never trusted).
async function applyAllAdjustments(session, payload) {
  _requireAdmin(session);
  payload = payload || {};

  const report = await getVarianceReport(session);
  let rows = report.rows.filter(function (r) { return Math.round(r.variance) !== 0; });

  if (Array.isArray(payload.keys) && payload.keys.length) {
    const wanted = new Set(payload.keys.map(function (k) {
      return String(k.branchCode || '').trim().toUpperCase()
        + '||' + normalizeItemName(k.itemName)
        + '||' + normalizeBatch(k.batch);
    }));
    rows = rows.filter(function (r) {
      return wanted.has(r.branch_code + '||' + r.item_name + '||' + (r.batch || ''));
    });
  }

  if (rows.length === 0) return { success: true, applied: 0 };

  const inserts = rows.map(function (r) {
    return {
      branch_code: r.branch_code,
      item_name: r.item_name,
      batch: r.batch || '',
      adjustment_qty: r.variance,
      reason: 'Bulk reconciliation adjustment to physical count of ' + r.physical_qty,
      reconciliation_id: null,
      created_by: session.userId
    };
  });

  const CHUNK = 500;
  for (let start = 0; start < inserts.length; start += CHUNK) {
    const { error } = await supabase
      .from('stock_adjustments')
      .insert(inserts.slice(start, start + CHUNK));
    if (error) throw httpError(500, 'Failed while applying adjustments: ' + error.message);
  }

  await logActivity(session.username, 'Bulk Stock Adjustment',
    'Applied ' + inserts.length + ' stock adjustments to match physical counts.');

  return { success: true, applied: inserts.length };
}

async function clearAllDatabaseData(session, password) {
  if (session.role !== 'SUPER_ADMIN' && session.role !== 'ADMIN') {
    throw httpError(403, 'Forbidden: Only administrators can clear database data.');
  }

  // Server-side second factor for this irreversible full wipe: the caller must
  // re-enter their own password. A client-side confirm dialog alone is not a
  // safeguard because the endpoint would accept the request regardless.
  if (!password) {
    throw httpError(400, 'Password confirmation is required to clear all data.');
  }
  const { data: acct, error: acctErr } = await supabase
    .from('user_profiles')
    .select('password_hash')
    .eq('id', session.userId)
    .limit(1)
    .single();
  if (acctErr || !acct) throw httpError(404, 'User profile not found.');
  if (acct.password_hash !== hashPassword(password)) {
    throw httpError(403, 'Incorrect password. Database was not cleared.');
  }

  // Clear tables with bigint IDs
  const bigintTables = ['sales_transactions', 'sales_returns', 'stock_conversions', 'stock_adjustments'];
  for (const table of bigintTables) {
    const { error } = await supabase.from(table).delete().neq('id', -1);
    if (error) {
      throw httpError(500, `Failed to clear table ${table}: ${error.message}`);
    }
  }

  // Clear tables with UUID IDs
  const uuidTables = ['physical_reconciliations', 'sync_logs'];
  for (const table of uuidTables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      throw httpError(500, `Failed to clear table ${table}: ${error.message}`);
    }
  }

  // Clear opening stocks (composite key)
  const { error: opError } = await supabase.from('opening_stock').delete().neq('branch_code', '');
  if (opError) {
    throw httpError(500, `Failed to clear opening stock table: ${opError.message}`);
  }

  // Clear system activity logs
  const { error: actError } = await supabase.from('system_activity_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (actError) {
    throw httpError(500, `Failed to clear activity logs: ${actError.message}`);
  }

  // Log the wipe action
  await logActivity(
    session.username,
    'Clear All Database Data',
    'All transaction logs, sales returns, opening stocks, conversions, reconciliations, and sync logs were wiped clean.'
  );

  return { success: true };
}

module.exports = {
  getBranchDashboard,
  markReceived,
  getAdminDashboard,
  getAllUsers,
  getAllBranches,
  createUserByAdmin,
  setUserActive,
  assignHodBranches,
  getHodBranchAssignments,
  getHodDashboard,
  getBranchTransfersForExport,
  bulkUpdateTransferStatus,
  getItemLedger,
  getAllItemLedger,
  refreshLedgerSnapshot,
  getOrderPlanning,
  saveOrderPlanLine,
  refreshOrderPlanning,
  getHodItemLedger,
  upsertOpeningStock,
  bulkUpsertOpeningStock,
  createConversion,
  getConversions,
  getAdminSettings,
  saveAdminSettings,
  syncGoogleSheet,
  changeUserPassword,
  getSyncLogs,
  getActivityLogs,
  submitReconciliation,
  getReconciliations,
  submitBulkReconciliations,
  getVarianceReport,
  applyStockAdjustment,
  applyAllAdjustments,
  logActivity,
  clearAllDatabaseData
};
