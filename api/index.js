'use strict';

require('dotenv/config');

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const auth = require('../lib/auth');
const data = require('../lib/data');

const app = express();
app.use(express.json());
app.use(cookieParser());

/* Wrap an async (req) => result handler into an Express handler with uniform
   error → JSON mapping. */
function handle(fn) {
  return async function (req, res) {
    try {
      const out = await fn(req);
      res.json(out);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Server error' });
    }
  };
}

/* ------------------------------- AUTH ----------------------------------- */

app.post('/api/login', async function (req, res) {
  try {
    const body = req.body || {};
    const result = await auth.login(body.username, body.password);
    if (!result.success) {
      return res.status(401).json({ error: result.message });
    }
    res.cookie(auth.COOKIE_NAME, result.token, auth.cookieOptions());
    res.json({ success: true, role: result.role });
  } catch (e) {
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/logout', function (req, res) {
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

/* ------------------------------- ADMIN ---------------------------------- */

app.get('/api/admin/dashboard',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAdminDashboard(); }));

app.get('/api/admin/users',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAllUsers(); }));

app.get('/api/admin/branches',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getAllBranches(); }));

app.post('/api/admin/users',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.createUserByAdmin(req.session, req.body); }));

app.post('/api/admin/users/active',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.setUserActive(req.session, req.body.userId, req.body.active); }));

app.get('/api/admin/needs-tagging',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function () { return data.getNeedsTaggingRows(); }));

app.post('/api/admin/resolve-destination',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.resolveDestination(req.body.transactionId, req.body.branchCode); }));

app.get('/api/admin/hod-assignments',
  auth.requireRole('SUPER_ADMIN', 'ADMIN'),
  handle(function (req) { return data.getHodBranchAssignments(req.query.userId); }));

// Managing HOD → branch assignments is Super Admin only (matches original design).
app.post('/api/admin/hod-assignments',
  auth.requireRole('SUPER_ADMIN'),
  handle(function (req) { return data.assignHodBranches(req.body.hodUserId, req.body.branchCodes); }));

/* -------------------------------- HOD ----------------------------------- */

app.get('/api/hod/dashboard',
  auth.requireRole('HOD'),
  handle(function (req) { return data.getHodDashboard(req.session); }));

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

module.exports = app;
