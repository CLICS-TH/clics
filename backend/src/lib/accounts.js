// Helpers for the multi-account system: role slot pools + stable pseudonyms.
const { supabase } = require('./supabase');

const ROLES = ['superadmin', 'admin', 'physician', 'auditor'];
const DEFAULT_CAPACITY = { superadmin: 1, admin: 5, physician: 100, auditor: 20 };

// Count ACTIVE members in a role (deactivated members don't consume a slot).
async function usedCount(role) {
  const { count } = await supabase
    .from('professionals')
    .select('id', { count: 'exact', head: true })
    .eq('role', role)
    .eq('status', 'active');
  return count ?? 0;
}

async function capacityOf(role) {
  const { data } = await supabase.from('role_slots').select('capacity').eq('role', role).single();
  return data?.capacity ?? DEFAULT_CAPACITY[role] ?? 0;
}

// { role, capacity, used, remaining } for one role.
async function slotUsage(role) {
  const [capacity, used] = await Promise.all([capacityOf(role), usedCount(role)]);
  return { role, capacity, used, remaining: Math.max(0, capacity - used) };
}

// Usage for every role (for the superadmin slot panel).
async function allSlotUsage() {
  return Promise.all(ROLES.map(slotUsage));
}

// Returns { ok: true } or { ok: false, error, usage } if the role pool is full.
async function assertSlotAvailable(role) {
  const usage = await slotUsage(role);
  if (usage.remaining <= 0) {
    return {
      ok: false,
      usage,
      error: `Role "${role}" is full (${usage.used}/${usage.capacity} slots used). Increase capacity or deactivate a member first.`,
    };
  }
  return { ok: true, usage };
}

// Next free pseudonym in the P-NNN series (zero-padded to 3 digits).
async function nextPseudonym() {
  const { data } = await supabase
    .from('professionals')
    .select('pseudonym')
    .not('pseudonym', 'is', null);
  let max = 0;
  for (const row of data ?? []) {
    const m = /^P-(\d+)$/.exec(row.pseudonym || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `P-${String(max + 1).padStart(3, '0')}`;
}

module.exports = { ROLES, DEFAULT_CAPACITY, slotUsage, allSlotUsage, assertSlotAvailable, nextPseudonym };
