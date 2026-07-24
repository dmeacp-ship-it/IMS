'use strict';

require('dotenv/config');

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const auth = require('../lib/auth');
const data = require('../lib/data');

const app = express();
app.use(compression());
app.use(express.json({ limit: '5mb' })); // bulk opening-stock uploads can be large
app.use(cookieParser());

app.use(function (req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  
  const supabaseUrl = process.env.SUPABASE_URL || '';
  // Fonts + icons are now self-hosted, so no third-party origins are needed —
  // everything but the Supabase API endpoint is locked to same-origin.
  res.setHeader('Content-Security-Policy', `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ${supabaseUrl};`);
  next();
});

/* ------------------------------- SSE REALTIME ---------------------------- */
const clients = new Set();
app.get('/api/stream', function (req, res) {
  // We use standard SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  // Only authenticated clients should be here (though we could enforce via auth.getSession)
  const session = auth.getSession(req);
  if (!session) {
    res.status(401).end();
    return;
  }
  
  const client = { id: Date.now(), res, role: session.role, branchCode: session.branchCode };
  clients.add(client);
  
  req.on('close', () => {
    clients.delete(client);
  });
});

// Broadcast events from Supabase to SSE clients
function broadcastRealtimeEvent(payload) {
  const dataString = JSON.stringify(payload);
  for (const client of clients) {
    // Optionally filter by branchCode if applicable, but for now broadcast to all
    client.res.write(`data: ${dataString}\n\n`);
  }
}

// Subscribe to Supabase Realtime (assuming lib/supabase exports the client)
const { supabase } = require('../lib/supabase');
if (supabase) {
  supabase
    .channel('public-tables')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'branch_transfers' }, (payload) => {
      broadcastRealtimeEvent({ type: 'transfer_update', payload });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'item_transactions' }, (payload) => {
      broadcastRealtimeEvent({ type: 'transaction_update', payload });
    })
    .subscribe();
}


/* Wrap an async (req) => result handler into an Express handler with uniform
   error → JSON mapping. */
function handle(fn, cacheHeader) {
  return async function (req, res) {
    try {
      if (cacheHeader) {
        res.setHeader('Cache-Control', cacheHeader);
      }
      const out = await fn(req);
      res.json(out);
    } catch (e) {
      let status = e.status || 500;
      let msg = e.message || 'Server error';
      if (msg.indexOf('Concurrency Lock:') !== -1) {
        status = 400;
        msg = msg.replace(/^.*?Concurrency Lock:/, 'Concurrency Lock:');
      }
      res.status(status).json({ error: msg });
    }
  };
}

/* ------------------------------- AUTH ----------------------------------- */

app.post('/api/login', async function (req, res) {
  try {
    const body = req.body || {};
    const result = await auth.login(body.username, body.password);
    if (!result.success) {
      await data.logActivity(body.username, 'Login Failed', result.message);
      return res.status(401).json({ error: result.message });
    }
    res.cookie(auth.COOKIE_NAME, result.token, auth.cookieOptions());
    await data.logActivity(body.username, 'Login Success', 'Role: ' + result.role);
    res.json({ success: true, role: result.role });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/logout', async function (req, res) {
  const s = auth.getSession(req);
  if (s) {
    await data.logActivity(s.username, 'Logout', 'User logged out');
  }
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ success: true });
});

app.get('/api/session', function (req, res) {
  const s = auth.getSession(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    userId: s.userId,
    username: s.username,
    fullName: s.fullName,
    role: s.role,
    branchCode: s.branchCode
  });
});

/* ------------------------------ BRANCH ---------------------------------- */

app.get('/api/branch/dashboard',
  auth.requireRole('BRANCH'),
  handle(function (req) { return data.getBranchDashboard(req.session); }));

app.post('/api/branch/mark-received',
  auth.requireRole('BRANCH'),
  handle(function (req) { return data.markReceived(req.session, req.body.transactionId); }));

app.get('/api/branch/ledger',
  auth.requireRole('BRANCH'),
  handle(function (req) { return data.getItemLedger(req.session.branchCode); }));

app.post('/api/branch/conversion',
  auth.requireRole('BRANCH'),
  handle(function (req) {
    return data.createConversion(req.session, Object.assign({}, req.body, { branchCode: req.session.branchCode }));
  }));

app.get('/api/branch/conversions',
  auth.requireRole('BRANCH'),
  handle(function (req) { return data.getConversions(req.session.branchCode); }));

/* ------------------------------- ADMIN ---------------------------------- */

app.get('/api/admin/dashboard',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAdminDashboard(); }));

app.get('/api/admin/users',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAllUsers(); }));

app.get('/api/admin/branches',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAllBranches(); }, 's-maxage=60, stale-while-revalidate=300'));

app.post('/api/admin/users',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.createUserByAdmin(req.session, req.body); }));

app.post('/api/admin/users/active',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.setUserActive(req.session, req.body.userId, req.body.active); }));

app.get('/api/admin/transfers/export',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getBranchTransfersForExport(); }));

app.post('/api/admin/transfers/bulk-status',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.bulkUpdateTransferStatus(req.session, req.body.rows); }));

app.get('/api/admin/hod-assignments',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.getHodBranchAssignments(req.query.userId); }));

// Managing HOD → branch assignments is Super Admin only (matches original design).
app.post('/api/admin/hod-assignments',
  auth.requireRole('SUPER_ADMIN'),
  handle(function (req) { return data.assignHodBranches(req.session, req.body.hodUserId, req.body.branchCodes); }));

app.get('/api/admin/ledger',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAllItemLedger(); }, 's-maxage=10, stale-while-revalidate=60'));

app.post('/api/admin/ledger/refresh',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.refreshLedgerSnapshot(req.session); }));

/* ------------------------------ ORDER PLANNING -------------------------- */

app.get('/api/order-planning',
  auth.requireRole(),
  handle(function (req) { return data.getOrderPlanning(req.session); }, 's-maxage=10, stale-while-revalidate=60'));

app.post('/api/admin/order-planning/refresh',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.refreshOrderPlanning(req.session); }));

app.post('/api/admin/order-planning/line',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.saveOrderPlanLine(req.session, req.body); }));

app.post('/api/admin/opening-stock',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.upsertOpeningStock(req.session, req.body); }));

app.post('/api/admin/opening-stock/bulk',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.bulkUpsertOpeningStock(req.session, req.body.rows); }));

app.post('/api/admin/conversion',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.createConversion(req.session, req.body); }));

app.get('/api/admin/conversions',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.getConversions(req.query.branchCode); }));

app.get('/api/admin/settings',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAdminSettings(); }));

app.post('/api/admin/settings',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.saveAdminSettings(req.session, req.body); }));

app.post('/api/admin/sync',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.syncGoogleSheet((req.session ? req.session.username : 'SYSTEM'), req.body.mode); }));

app.get('/api/cron/sync', async function (req, res) {
  try {
    // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the
    // CRON_SECRET env var is set. The old `x-vercel-cron` header check was
    // spoofable — any caller can set an arbitrary request header — so we
    // verify a shared secret instead. Requires CRON_SECRET in the environment
    // (both locally and in the Vercel project settings).
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
    }
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== 'Bearer ' + secret) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const result = await data.syncGoogleSheet('SYSTEM (Auto Sync)');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/activity-logs',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getActivityLogs(); }));

app.get('/api/admin/sync-logs',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getSyncLogs(); }));

app.post('/api/admin/clear-database-data',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.clearAllDatabaseData(req.session, req.body.password); }));

app.post('/api/user/change-password',
  auth.requireRole(),
  handle(function (req) {
    return data.changeUserPassword(req.session, req.body.currentPassword, req.body.newPassword);
  }));

app.post('/api/reconciliation',
  auth.requireRole(),
  handle(function (req) {
    return data.submitReconciliation(req.session, req.body);
  }));

app.get('/api/reconciliations',
  auth.requireRole(),
  handle(function (req) {
    return data.getReconciliations(req.session);
  }));

app.post('/api/reconciliations/bulk',
  auth.requireRole(),
  handle(function (req) {
    return data.submitBulkReconciliations(req.session, req.body.rows);
  }));

app.get('/api/variance-report',
  auth.requireRole(),
  handle(function (req) {
    return data.getVarianceReport(req.session);
  }));

app.post('/api/variance/apply',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) {
    return data.applyStockAdjustment(req.session, req.body);
  }));

app.post('/api/variance/apply-all',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) {
    return data.applyAllAdjustments(req.session, req.body);
  }));

/* -------------------------------- HOD ----------------------------------- */

app.get('/api/hod/dashboard',
  auth.requireRole('HOD'),
  handle(function (req) { return data.getHodDashboard(req.session); }));

app.get('/api/hod/ledger',
  auth.requireRole('HOD'),
  handle(function (req) { return data.getHodItemLedger(req.session); }));

/* Unmatched API routes → JSON 404 (so they never fall through to the SPA). */
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'Not found' });
});

/* Static assets + SPA fallback. On Vercel, /public is served by the platform
   and only /api/* reaches this function; these lines make `npm run dev` behave
   the same locally. */
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', function (req, res) {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Scheduled daily synchronization is handled by Vercel Cron hitting
// /api/cron/sync (see vercel.json "crons"). A setInterval here would not run
// reliably on serverless (instances aren't long-lived) and could double-fire
// alongside the cron job on a warm instance, so it is intentionally omitted.

module.exports = app;
