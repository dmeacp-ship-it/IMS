'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase } = require('./supabase');

const SESSION_TTL_SEC = 8 * 60 * 60;     // 8 hours
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;       // 15 minutes
const COOKIE_NAME = 'ims_session';

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set. Add it to your environment variables.');
  return s;
}

// SHA-256 hex — kept identical to the original Apps Script implementation so
// existing password_hash values in user_profiles remain valid. (See README
// for the note on upgrading to a salted hash.)
function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('hex');
}

/* ---------------------------------------------------------------------------
   Rate limiting — best-effort, in-memory. Persists only while a serverless
   instance stays warm, so lockout is not guaranteed across cold starts /
   parallel instances. See README for a durable (Supabase/Upstash) option.
   ------------------------------------------------------------------------- */
const attempts = new Map();

function isLockedOut(username) {
  const rec = attempts.get(username);
  return !!rec && rec.count >= MAX_LOGIN_ATTEMPTS && (Date.now() - rec.last) < LOCKOUT_MS;
}
function recordFailure(username) {
  const rec = attempts.get(username) || { count: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  attempts.set(username, rec);
}
function clearFailures(username) {
  attempts.delete(username);
}

/* ---------------------------------------------------------------------------
   Sessions — stateless JWT in an httpOnly cookie (replaces the GAS
   ScriptProperties session store; works across serverless instances).
   ------------------------------------------------------------------------- */
function signSession(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      branchCode: user.branch_code
    },
    secret(),
    { expiresIn: SESSION_TTL_SEC }
  );
}

function verifySession(token) {
  try {
    return jwt.verify(token, secret());
  } catch (e) {
    return null;
  }
}

function getSession(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySession(token);
}

// Express middleware factory. requireRole() with no args = any valid session.
function requireRole(...roles) {
  return function (req, res, next) {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    if (roles.length && roles.indexOf(s.role) === -1) {
      return res.status(403).json({ error: 'Not authorized for this action.' });
    }
    req.session = s;
    next();
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // https on Vercel; http locally
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC * 1000
  };
}

async function login(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username || !password) {
    return { success: false, message: 'Username and password are required.' };
  }
  if (isLockedOut(username)) {
    return { success: false, message: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('username', username)
    .limit(1);

  if (error) {
    return { success: false, message: 'Login temporarily unavailable. Try again shortly.' };
  }

  const computedHash = hashPassword(password);
  const user = data && data[0];
  const targetHash = user ? user.password_hash : 'dummy_nonexistent_hash_to_prevent_timing_attacks';
  const isMatch = (computedHash === targetHash);

  if (!user || !user.active || !isMatch) {
    recordFailure(username);
    return { success: false, message: 'Incorrect username or password.' };
  }

  clearFailures(username);
  return { success: true, role: user.role, token: signSession(user) };
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SEC,
  hashPassword,
  login,
  getSession,
  requireRole,
  cookieOptions,
  signSession,
  verifySession
};
