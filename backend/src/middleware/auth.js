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

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = { verifyJwt, requireRole };
