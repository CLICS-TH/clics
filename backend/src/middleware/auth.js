const { supabase } = require('../lib/supabase');

async function verifyJwt(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = header.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid token' });

  const { data: prof, error: profErr } = await supabase
    .from('professionals')
    .select('role, full_name_th, full_name_en')
    .eq('id', data.user.id)
    .single();

  if (profErr || !prof) return res.status(403).json({ error: 'User not in professionals table' });

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
