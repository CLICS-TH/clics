// Helpers for the multi-account system: role slot pools + stable pseudonyms.
//
// Capacity model after the multi-council update:
//   physician  → UNCAPPED (Google self-signup at ~80K; the global role_slots row is display-only).
//   superadmin → global singleton (the DB unique index is the real guard).
//   admin/auditor → governed PER COUNCIL via the council_slots table.
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

// { role, capacity, used, remaining } for one role (global).
async function slotUsage(role) {
  const [capacity, used] = await Promise.all([capacityOf(role), usedCount(role)]);
  return { role, capacity, used, remaining: Math.max(0, capacity - used) };
}

// Usage for every role (for the superadmin global slot panel).
async function allSlotUsage() {
  return Promise.all(ROLES.map(slotUsage));
}

// ---- Per-council pools (admin/auditor) -----------------------------------
async function councilCapacityOf(councilId, role) {
  const { data } = await supabase
    .from('council_slots').select('capacity')
    .eq('council_id', councilId).eq('role', role).maybeSingle();
  return data?.capacity ?? DEFAULT_CAPACITY[role] ?? 0;
}

async function councilUsedCount(councilId, role) {
  const { count } = await supabase
    .from('professionals')
    .select('id', { count: 'exact', head: true })
    .eq('role', role)
    .eq('council_id', councilId)
    .eq('status', 'active');
  return count ?? 0;
}

// { role, council_id, capacity, used, remaining } for one admin/auditor pool in one council.
async function councilSlotUsage(councilId, role) {
  const [capacity, used] = await Promise.all([
    councilCapacityOf(councilId, role),
    councilUsedCount(councilId, role),
  ]);
  return { role, council_id: councilId, capacity, used, remaining: Math.max(0, capacity - used) };
}

// Both governed pools for one council (for the per-council slot panel).
async function allCouncilSlotUsage(councilId) {
  return Promise.all(['admin', 'auditor'].map(r => councilSlotUsage(councilId, r)));
}

// Returns { ok: true } or { ok: false, error, usage } if the relevant pool is full.
//   physician → always ok (uncapped).
//   superadmin → global pool.
//   admin/auditor → per-council pool (councilId required).
async function assertSlotAvailable(role, councilId) {
  if (role === 'physician') return { ok: true };

  if (role === 'superadmin') {
    const usage = await slotUsage('superadmin');
    if (usage.remaining <= 0) {
      return { ok: false, usage, error: `Role "superadmin" is full (${usage.used}/${usage.capacity}).` };
    }
    return { ok: true, usage };
  }

  // admin / auditor — per council.
  if (!councilId) {
    return { ok: false, error: `A council is required to assign the "${role}" role.` };
  }
  const usage = await councilSlotUsage(councilId, role);
  if (usage.remaining <= 0) {
    return {
      ok: false,
      usage,
      error: `Role "${role}" is full for this council (${usage.used}/${usage.capacity} slots used). Increase capacity or deactivate a member first.`,
    };
  }
  return { ok: true, usage };
}

// Next pseudonym in the P-NNN series. Uses the O(1) `next_pseudonym()` sequence
// (db/migration-scale.sql) — critical at 80K. Falls back to the legacy O(N) scan only if the
// RPC isn't present yet (migration not applied in this environment), so deploy order is safe.
async function nextPseudonym() {
  const { data, error } = await supabase.rpc('next_pseudonym');
  if (!error && typeof data === 'string') return data;

  // Fallback (pre-migration only): scan for the max P-NNN.
  const { data: rows } = await supabase
    .from('professionals').select('pseudonym').not('pseudonym', 'is', null);
  let max = 0;
  for (const row of rows ?? []) {
    const m = /^P-(\d+)$/.exec(row.pseudonym || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `P-${String(max + 1).padStart(3, '0')}`;
}

// Next expert-auditor code in the EXP-NNN series (CLICS §9.2). Mirrors nextPseudonym: O(1) RPC
// with a pre-migration fallback scan, so deploy order is safe.
async function nextExpCode() {
  const { data, error } = await supabase.rpc('next_exp_code');
  if (!error && typeof data === 'string') return data;

  const { data: rows } = await supabase
    .from('professionals').select('exp_code').not('exp_code', 'is', null);
  let max = 0;
  for (const row of rows ?? []) {
    const mm = /^EXP-(\d+)$/.exec(row.exp_code || '');
    if (mm) max = Math.max(max, parseInt(mm[1], 10));
  }
  return `EXP-${String(max + 1).padStart(3, '0')}`;
}

module.exports = {
  ROLES, DEFAULT_CAPACITY,
  slotUsage, allSlotUsage, assertSlotAvailable, nextPseudonym, nextExpCode,
  councilSlotUsage, allCouncilSlotUsage,
};
