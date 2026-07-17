'use strict';

const { supabase } = require('./supabase');
const { hashPassword } = require('./auth');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
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
    .select('destination_branch_code,status')
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

  return { success: true };
}

/* ============================================================================
   ADMIN / SUPER_ADMIN
   ========================================================================== */

async function getAdminDashboard() {
  const { count: totalBranches } = await supabase
    .from('branches')
    .select('code', { count: 'exact', head: true });

  const { data: transfers } = await supabase
    .from('sales_transactions')
    .select('id,docnum,item_code,item_description,quantity,source_branch_code,destination_branch_code,status,doc_date,received_at')
    .eq('order_type', 'BRANCH-TRANSFER')
    .order('doc_date', { ascending: false })
    .limit(200);

  const txns = transfers || [];
  const inTransitCount = txns.filter(function (t) { return t.status === 'IN_TRANSIT'; }).length;
  const receivedCount = txns.filter(function (t) { return t.status === 'RECEIVED'; }).length;

  const { count: needsTaggingCount } = await supabase
    .from('sales_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('order_type', 'BRANCH-TRANSFER')
    .is('destination_branch_code', null);

  return {
    totalBranches: totalBranches || 0,
    transfers: txns,
    inTransitCount: inTransitCount,
    receivedCount: receivedCount,
    needsTaggingCount: needsTaggingCount || 0
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

  if (role === 'HOD' && session.role === 'SUPER_ADMIN' && Array.isArray(userData.hodBranchCodes) && userData.hodBranchCodes.length) {
    await _assignHodBranches(data[0].id, userData.hodBranchCodes);
  }

  return { success: true };
}

async function setUserActive(session, userId, active) {
  if (!userId) throw httpError(400, 'Missing user id.');

  if (session.role === 'ADMIN') {
    const { data } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', userId)
      .limit(1);
    const target = data && data[0];
    if (!target || target.role !== 'BRANCH') {
      throw httpError(403, 'Admins can only manage Branch-role accounts.');
    }
  }

  const { error } = await supabase
    .from('user_profiles')
    .update({ active: !!active })
    .eq('id', userId);
  if (error) throw httpError(500, 'Failed to update user.');

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

async function assignHodBranches(hodUserId, branchCodes) {
  if (!hodUserId) throw httpError(400, 'Missing HOD user id.');
  await _assignHodBranches(hodUserId, branchCodes || []);
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
   NEEDS-TAGGING RESOLUTION
   ========================================================================== */

async function getNeedsTaggingRows() {
  const { data } = await supabase
    .from('sales_transactions')
    .select('id,docnum,item_code,item_description,customer_name,quantity,source_branch_code,doc_date')
    .eq('order_type', 'BRANCH-TRANSFER')
    .is('destination_branch_code', null);
  return data || [];
}

async function resolveDestination(transactionId, branchCode) {
  if (!transactionId || !branchCode) throw httpError(400, 'Missing transfer id or branch code.');

  const { data: validBranch } = await supabase
    .from('branches')
    .select('code')
    .eq('code', branchCode)
    .limit(1);
  if (!validBranch || validBranch.length === 0) {
    throw httpError(400, 'Not a recognized branch code.');
  }

  const { error } = await supabase
    .from('sales_transactions')
    .update({ destination_branch_code: branchCode })
    .eq('id', transactionId);
  if (error) throw httpError(500, 'Failed to update: ' + error.message);

  return { success: true };
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

async function getItemLedger(branchCode) {
  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('*')
    .eq('branch_code', branchCode)
    .order('item_name', { ascending: true })
    .limit(5000);
  if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
  return data || [];
}

async function getAllItemLedger() {
  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('*')
    .order('branch_code', { ascending: true })
    .order('item_name', { ascending: true })
    .limit(5000);
  if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
  return data || [];
}

async function getHodItemLedger(session) {
  const branchCodes = await _hodBranchCodes(session.userId);
  if (branchCodes.length === 0) return [];

  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('*')
    .in('branch_code', branchCodes)
    .order('branch_code', { ascending: true })
    .order('item_name', { ascending: true })
    .limit(5000);
  if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
  return data || [];
}

// Validates one opening-stock entry into a DB-ready row, or throws with a
// message (prefixed with the CSV line number when called from bulk upload).
function _validateOpeningRow(entry, validBranchCodes, userId, lineLabel) {
  const prefix = lineLabel ? (lineLabel + ': ') : '';
  const branchCode = String(entry.branchCode || '').trim().toUpperCase();
  const itemName = normalizeItemName(entry.itemName);
  const batch = normalizeBatch(entry.batch);
  const quantity = Number(entry.quantity);
  const asOfDate = String(entry.asOfDate || '').trim();

  if (!branchCode || !itemName || !asOfDate) {
    throw httpError(400, prefix + 'Branch, item name, and date are required.');
  }
  if (!validBranchCodes.has(branchCode)) {
    throw httpError(400, prefix + '"' + branchCode + '" is not a recognized branch code.');
  }
  if (isNaN(quantity) || quantity < 0) {
    throw httpError(400, prefix + 'Quantity must be a non-negative number.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || isNaN(new Date(asOfDate).getTime())) {
    throw httpError(400, prefix + 'Date must be in YYYY-MM-DD format (e.g. 2025-09-04).');
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
  getNeedsTaggingRows,
  resolveDestination,
  getItemLedger,
  getAllItemLedger,
  getHodItemLedger,
  upsertOpeningStock,
  bulkUpsertOpeningStock,
  createConversion,
  getConversions
};
