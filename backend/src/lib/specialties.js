// Specialty (the layer under council) + position-ladder helpers, shared across routes so the
// validation/enrichment rules live in one place (mirrors lib/accounts + lib/dual-role).
const { supabase } = require('./supabase');

// Medical training level (the seniority ladder, formerly labelled "position/ตำแหน่ง"). The DB column
// is still `position` (no migration). 'gp' = General Practitioner is kept for admin-created accounts
// but is NOT offered in self-signup onboarding (which collects only the 5 training levels below).
const POSITIONS = ['extern', 'intern', 'resident', 'fellowship', 'staff', 'gp'];
// The 5 training levels a new-comer chooses during self-signup (gp excluded — it's a practice status,
// not a training level, so it stays admin-only).
const TRAINING_LEVELS = ['extern', 'intern', 'resident', 'fellowship', 'staff'];
const POSITION_LABELS = {
  extern:     { th: 'เอกซ์เทิร์น',           en: 'Extern' },
  intern:     { th: 'แพทย์อินเทิร์น',        en: 'Intern' },
  resident:   { th: 'แพทย์ประจำบ้าน',        en: 'Resident' },
  fellowship: { th: 'แพทย์ประจำบ้านต่อยอด',  en: 'Fellow' },
  staff:      { th: 'อาจารย์แพทย์',          en: 'Staff' },
  gp:         { th: 'แพทย์ทั่วไป',            en: 'General Practitioner' },
};

// Roles pinned to ONE council — and therefore to ONE specialty. The global oversight roles
// (superadmin/analyst/ethics) span all and carry no specialty.
const COUNCIL_SCOPED_ROLES = ['admin', 'physician', 'auditor'];

// Does this council have any active specialties? Used to make the specialty requirement
// conditional — non-medical test councils (PHARM/DENT/ENG) have none, so they stay usable.
async function councilHasSpecialties(councilId) {
  if (!councilId) return false;
  const { count } = await supabase.from('specialties')
    .select('id', { count: 'exact', head: true }).eq('council_id', councilId).eq('active', true);
  return (count ?? 0) > 0;
}

// A specialty must belong to (and be active in) the chosen council.
async function specialtyInCouncil(specialtyId, councilId) {
  if (!specialtyId || !councilId) return false;
  const { data } = await supabase.from('specialties')
    .select('id').eq('id', specialtyId).eq('council_id', councilId).eq('active', true).maybeSingle();
  return !!data;
}

// Validate a (role, council, specialty) triple for create/edit. Council-scoped roles need a
// specialty whenever the council has any; global roles ignore specialty entirely.
async function checkSpecialty(role, councilId, specialtyId) {
  if (!COUNCIL_SCOPED_ROLES.includes(role)) return { ok: true };
  if (specialtyId) {
    if (!(await specialtyInCouncil(specialtyId, councilId))) {
      return { ok: false, error: 'Specialty does not belong to the selected council.' };
    }
    return { ok: true };
  }
  if (await councilHasSpecialties(councilId)) {
    return { ok: false, error: 'Specialty is required for this role.' };
  }
  return { ok: true };
}

// Display names for a specialty id (null-safe).
async function specialtyName(specialtyId) {
  if (!specialtyId) return { name_th: null, name_en: null };
  const { data } = await supabase.from('specialties')
    .select('name_th, name_en').eq('id', specialtyId).maybeSingle();
  return { name_th: data?.name_th ?? null, name_en: data?.name_en ?? null };
}

// Attach flat specialty_name_th/en to a user object — the front-ends render these under the
// name in the nav bar without needing a second request.
async function attachSpecialty(user) {
  const s = await specialtyName(user?.specialty_id);
  return { ...user, specialty_name_th: s.name_th, specialty_name_en: s.name_en };
}

// Linked external identity providers for a professional (e.g. ['google']). Powers the
// physician-ui "Link Google" affordance — shown only when 'google' is absent.
async function linkedProviders(professionalId) {
  const { data } = await supabase.from('oauth_identities')
    .select('provider').eq('professional_id', professionalId);
  return [...new Set((data ?? []).map(r => r.provider).filter(Boolean))];
}

module.exports = {
  POSITIONS, TRAINING_LEVELS, POSITION_LABELS, COUNCIL_SCOPED_ROLES,
  councilHasSpecialties, specialtyInCouncil, checkSpecialty,
  specialtyName, attachSpecialty, linkedProviders,
};
