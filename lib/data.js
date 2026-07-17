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

async function getItemLedger(branchCode) {
  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('*')
    .eq('branch_code', branchCode)
    .order('item_code', { ascending: true })
    .limit(5000);
  if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
  return data || [];
}

async function getAllItemLedger() {
  const { data, error } = await supabase
    .from('item_stock_ledger')
    .select('*')
    .order('branch_code', { ascending: true })
    .order('item_code', { ascending: true })
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
    .order('item_code', { ascending: true })
    .limit(5000);
  if (error) throw httpError(500, 'Failed to load stock ledger: ' + error.message);
  return data || [];
}

async function upsertOpeningStock(session, entry) {
  entry = entry || {};
  const branchCode = entry.branchCode;
  const itemCode = (entry.itemCode || '').trim();
  const batch = (entry.batch || '').trim();
  const quantity = Number(entry.quantity);
  const asOfDate = entry.asOfDate;

  if (!branchCode || !itemCode || !asOfDate) {
    throw httpError(400, 'Branch, item code, and date are required.');
  }
  if (isNaN(quantity) || quantity < 0) {
    throw httpError(400, 'Quantity must be a non-negative number.');
  }

  const { data: validBranch } = await supabase
    .from('branches')
    .select('code')
    .eq('code', branchCode)
    .limit(1);
  if (!validBranch || validBranch.length === 0) {
    throw httpError(400, 'Not a recognized branch code.');
  }

  const { error } = await supabase
    .from('opening_stock')
    .upsert({
      branch_code: branchCode,
      item_code: itemCode,
      batch: batch,
      quantity: quantity,
      as_of_date: asOfDate,
      updated_by: session.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: 'branch_code,item_code,batch' });
  if (error) throw httpError(500, 'Failed to save opening stock: ' + error.message);

  return { success: true };
}

async function createConversion(session, entry) {
  entry = entry || {};
  const branchCode = entry.branchCode;
  const fromItemCode = (entry.fromItemCode || '').trim();
  const fromBatch = (entry.fromBatch || '').trim();
  const fromQuantity = Number(entry.fromQuantity);
  const toItemCode = (entry.toItemCode || '').trim();
  const toBatch = (entry.toBatch || '').trim();
  const toQuantity = Number(entry.toQuantity);
  const notes = entry.notes || null;

  if (session.role === 'BRANCH' && branchCode !== session.branchCode) {
    throw httpError(403, 'You can only record conversions for your own branch.');
  }
  if (!branchCode || !fromItemCode || !toItemCode) {
    throw httpError(400, 'Branch, source item, and output item are required.');
  }
  if (!(fromQuantity > 0) || !(toQuantity > 0)) {
    throw httpError(400, 'Quantities must be greater than zero.');
  }

  const ledger = await getItemLedger(branchCode);
  const sourceRow = ledger.find(function (r) { return r.item_code === fromItemCode && r.batch === fromBatch; });
  const available = sourceRow ? Number(sourceRow.closing_qty) : 0;
  if (fromQuantity > available) {
    throw httpError(400, 'Only ' + available + ' available in ' + fromItemCode + (fromBatch ? ('-' + fromBatch) : '') + ' — cannot consume ' + fromQuantity + '.');
  }

  const { error } = await supabase.from('stock_conversions').insert({
    branch_code: branchCode,
    from_item_code: fromItemCode,
    from_batch: fromBatch,
    from_quantity: fromQuantity,
    to_item_code: toItemCode,
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
    .select('id,branch_code,from_item_code,from_batch,from_quantity,to_item_code,to_batch,to_quantity,notes,created_at')
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
  createConversion,
  getConversions
};
