'use strict';

// One-off bootstrap for the first account (typically a SUPER_ADMIN), before
// any UI exists to create users. Usage:
//
//   npm run create-user -- <username> <password> "<full name>" <role> [branchCode]
//
// Examples:
//   npm run create-user -- admin "S3cret!" "Head Office" SUPER_ADMIN
//   npm run create-user -- hyd_ops "pw" "Hyderabad Ops" BRANCH HYDERABAD-BRANCH
//
// role must be one of: SUPER_ADMIN | ADMIN | BRANCH | HOD
// branchCode is required only for BRANCH.

require('dotenv/config');

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'BRANCH', 'HOD'];

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const username = args[0];
  const password = args[1];
  const fullName = args[2];
  const role = args[3];
  const branchCode = args[4] || null;

  if (!username || !password || !fullName || !role) {
    console.error('Usage: npm run create-user -- <username> <password> "<full name>" <role> [branchCode]');
    process.exit(1);
  }
  if (ROLES.indexOf(role) === -1) {
    console.error('Invalid role "' + role + '". Must be one of: ' + ROLES.join(', '));
    process.exit(1);
  }
  if (role === 'BRANCH' && !branchCode) {
    console.error('BRANCH accounts require a branchCode as the 5th argument.');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.example).');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });

  const payload = {
    username: username.trim().toLowerCase(),
    password_hash: hashPassword(password),
    full_name: fullName,
    role: role,
    branch_code: role === 'BRANCH' ? branchCode : null,
    active: true
  };

  const { data, error } = await supabase.from('user_profiles').insert(payload).select();
  if (error) {
    console.error('Failed to create user:', error.message);
    process.exit(1);
  }
  console.log('Created user:', data[0].username, '(' + data[0].role + ')');
}

main();
