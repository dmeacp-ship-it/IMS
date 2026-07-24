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

// Password hashing.
//
// New hashes use salted scrypt (a slow, memory-hard KDF built into Node — no
// extra dependency, works on Vercel out of the box) stored as
// "scrypt$<saltHex>$<hashHex>". Legacy values are bare 64-char SHA-256 hex from
// the original Apps Script app; verifyPassword still accepts them so existing
// logins keep working, and login() transparently upgrades them to scrypt on the
// next successful sign-in (see maybeUpgradeHash).
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}

// Legacy unsalted SHA-256 hex (what old rows still contain).
function _sha256Hex(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('hex');
}

function isLegacyHash(stored) {
  return typeof stored === 'string' && /^[a-f0-9]{64}$/i.test(stored);
}

// Constant-time comparison. Returns true iff `password` matches the stored hash,
// whether that hash is scrypt or a legacy SHA-256 hex.
function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string' || !stored) return false;
    if (stored.indexOf('scrypt$') === 0) {
      const parts = stored.split('$');
      if (parts.length !== 3) return false;
      const salt = Buffer.from(parts[1], 'hex');
      const expected = Buffer.from(parts[2], 'hex');
      const derived = crypto.scryptSync(String(password), salt, expected.length || SCRYPT_KEYLEN);
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    }
    if (isLegacyHash(stored)) {
      const computed = Buffer.from(_sha256Hex(password), 'hex');
      const expected = Buffer.from(stored, 'hex');
      return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
    }
    return false;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------------------
   Rate limiting. Primary store is the login_attempts table (supabase/patch_026)
   so lockout survives serverless cold starts and holds across instances. If that
   table is missing or the DB call fails, we fall back to the in-memory map (the
   old best-effort behavior) — and isLockedOut fails OPEN, so a limiter fault can
   never lock a legitimate user out; worst case rate-limiting is just weaker.
   ------------------------------------------------------------------------- */
const attempts = new Map();

function _memIsLockedOut(username) {
  const rec = attempts.get(username);
  return !!rec && rec.count >= MAX_LOGIN_ATTEMPTS && (Date.now() - rec.last) < LOCKOUT_MS;
}
function _memRecordFailure(username) {
  const rec = attempts.get(username) || { count: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  attempts.set(username, rec);
}
function _memClearFailures(username) {
  attempts.delete(username);
}

async function isLockedOut(username) {
  try {
    const { data, error } = await supabase
      .from('login_attempts')
      .select('attempts, last_attempt')
      .eq('username', username)
      .limit(1)
      .maybeSingle();
    if (error) return _memIsLockedOut(username); // table missing / DB error → fallback
    if (!data) return false;
    return data.attempts >= MAX_LOGIN_ATTEMPTS
      && (Date.now() - new Date(data.last_attempt).getTime()) < LOCKOUT_MS;
  } catch (e) {
    return _memIsLockedOut(username);
  }
}

async function recordFailure(username) {
  try {
    const { data } = await supabase
      .from('login_attempts')
      .select('attempts, last_attempt')
      .eq('username', username)
      .limit(1)
      .maybeSingle();
    // Reset the counter if the previous lockout window has already elapsed.
    const stale = data && (Date.now() - new Date(data.last_attempt).getTime()) >= LOCKOUT_MS;
    const nextCount = (data && !stale ? data.attempts : 0) + 1;
    const { error } = await supabase
      .from('login_attempts')
      .upsert({ username: username, attempts: nextCount, last_attempt: new Date().toISOString() },
              { onConflict: 'username' });
    if (error) _memRecordFailure(username);
  } catch (e) {
    _memRecordFailure(username);
  }
}

async function clearFailures(username) {
  _memClearFailures(username);
  try {
    await supabase.from('login_attempts').delete().eq('username', username);
  } catch (e) { /* best-effort */ }
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

// Stateless JWTs can't be revoked, so a deactivated user's 8-hour token would
// otherwise keep working until it expires. We re-check `active` (and the current
// role) against the DB, cached briefly to avoid a read on every request. On any
// DB error we fail OPEN (allow) so a transient outage never locks everyone out.
const ACTIVE_CACHE_TTL_MS = 60 * 1000;
const _activeCache = new Map(); // userId -> { active, role, ts }

async function _liveUserState(userId) {
  const cached = _activeCache.get(userId);
  if (cached && (Date.now() - cached.ts) < ACTIVE_CACHE_TTL_MS) return cached;
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('active, role')
      .eq('id', userId)
      .limit(1)
      .single();
    if (error || !data) return null; // unknown → caller fails open
    const state = { active: data.active, role: data.role, ts: Date.now() };
    _activeCache.set(userId, state);
    return state;
  } catch (e) {
    return null;
  }
}

// Express middleware factory. requireRole() with no args = any valid session.
function requireRole(...roles) {
  return async function (req, res, next) {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'Session expired. Please log in again.' });

    // Re-verify against live account state (deactivation / role change).
    const live = await _liveUserState(s.userId);
    if (live && live.active === false) {
      return res.status(401).json({ error: 'Your account has been deactivated. Please contact an administrator.' });
    }
    const effectiveRole = (live && live.role) || s.role;
    if (roles.length && roles.indexOf(effectiveRole) === -1) {
      return res.status(403).json({ error: 'Not authorized for this action.' });
    }
    s.role = effectiveRole; // trust live role over the (possibly stale) token
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
  if (await isLockedOut(username)) {
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

  const user = data && data[0];
  // Always run a verification so response time doesn't reveal whether the
  // username exists (the dummy hash is a non-matching scrypt record).
  const targetHash = user ? user.password_hash : 'scrypt$00$00';
  const isMatch = verifyPassword(password, targetHash);

  if (!user || !user.active || !isMatch) {
    await recordFailure(username);
    return { success: false, message: 'Incorrect username or password.' };
  }

  await clearFailures(username);
  await maybeUpgradeHash(user, password);
  return { success: true, role: user.role, token: signSession(user) };
}

// After a successful login, if the stored hash is still legacy SHA-256, rehash
// the (now known-correct) plaintext to salted scrypt and persist it. Best-effort:
// any failure is swallowed so it can never block a valid login.
async function maybeUpgradeHash(user, plaintextPassword) {
  if (!user || !isLegacyHash(user.password_hash)) return;
  try {
    await supabase
      .from('user_profiles')
      .update({ password_hash: hashPassword(plaintextPassword) })
      .eq('id', user.id);
  } catch (e) {
    console.error('Password hash upgrade failed for user ' + user.id + ': ' + e.message);
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SEC,
  hashPassword,
  verifyPassword,
  isLegacyHash,
  login,
  getSession,
  requireRole,
  cookieOptions,
  signSession,
  verifySession
};
