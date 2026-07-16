'use strict';

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  // Fail loudly at cold start rather than on the first query.
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the environment.');
}

// service_role key: server-side only. Bypasses RLS — authorization is enforced
// in lib/auth.js (requireRole) + the ownership re-checks in lib/data.js.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

module.exports = { supabase };
