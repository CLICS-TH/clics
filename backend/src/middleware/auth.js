const { supabase, authSupabase } = require('../lib/supabase');

async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = header.slice(7);
  // Use isolated authSupabase so session pollution never contaminates db queries
  const { data, error } = await authSupabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });

  const { data: prof, error: profErr } = await supabase
    .from('professionals')
    .select('*') // includes consented_at once the migration is applied; resilient if not yet
    .eq('id', data.user.id)
    .single();

  // No professionals row = the account hasn't been approved into a role yet
  // (self-service / OAuth requests live in access_requests until a superadmin/admin approves).
  if (profErr || !prof) {
    return res.status(403).json({ error: 'Account pending approval', code: 'pending' });
  }
  if (prof.status === 'deactivated') {
    return res.status(403).json({ error: 'Account deactivated. Contact an administrator.', code: 'deactivated' });
  }

  req.user = { id: data.user.id, email: data.user.email, ...prof };
  next();
}

// Role gate. The "special" dual role (manager, 2026-06-10) is a physician with can_audit=true —
// they pass any gate that accepts 'auditor' (the auditor console/queue/scoring), while their
// primary role stays 'physician' (slots, pseudonym, physician routes all unchanged).
function requireRole(...roles) {
  return (req, res, next) => {
    const ok = roles.includes(req.user?.role) || (roles.includes('auditor') && req.user?.can_audit === true);
    if (!ok) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { verifyJwt, requireRole };
