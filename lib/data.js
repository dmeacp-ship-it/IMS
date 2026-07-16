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

  const { data: ledgerRows, error: ledgerErr } = await supabase
    .from('stock_ledger')
    .select('*')
    .eq('branch_code', branchCode)
    .limit(1);
  if (ledgerErr) throw httpError(500, 'Failed to load stock balance.');
  const ledger = (ledgerRows && ledgerRows[0]) || null;

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
    ledger: ledger,
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
  const { data: branches } = await supabase
    .from('stock_ledger')
    .select('*')
    .order('branch_code', { ascending: true });

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
    branches: branches || [],
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
  const { data: assignments } = await supabase
    .from('hod_branch_assignments')
    .select('branch_code')
    .eq('hod_user_id', session.userId);

  const branchCodes = (assignments || []).map(function (a) { return a.branch_code; });
  if (branchCodes.length === 0) {
    return { branches: [], transfers: [], noAssignments: true };
  }

  const { data: branches } = await supabase
    .from('stock_ledger')
    .select('*')
    .in('branch_code', branchCodes)
    .order('branch_code', { ascending: true });

  const inList = branchCodes.join(',');
  const { data: transfers } = await supabase
    .from('sales_transactions')
    .select('id,docnum,item_code,item_description,quantity,source_branch_code,destination_branch_code,status,doc_date')
    .eq('order_type', 'BRANCH-TRANSFER')
    .or('source_branch_code.in.(' + inList + '),destination_branch_code.in.(' + inList + ')')
    .order('doc_date', { ascending: false })
    .limit(200);

  return {
    branches: branches || [],
    transfers: transfers || [],
    noAssignments: false
  };
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
  resolveDestination
};
