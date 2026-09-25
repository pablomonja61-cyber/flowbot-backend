const jwt = require('jsonwebtoken');
const supabase = require('../models/supabase');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Si esta cuenta es miembro de un equipo (tiene owner_id guardado
    // en la base de datos), req.user.id debe apuntar al DUEÑO — así
    // todas las rutas existentes (conversaciones, flujos, ventas,
    // etc.) funcionan igual para un miembro de equipo, sin tener que
    // tocar nada más en ningún otro archivo.
    const { data: cuenta } = await supabase
      .from('users')
      .select('owner_id, team_role')
      .eq('id', decoded.id)
      .maybeSingle();

    req.user = {
      ...decoded,
      actualId: decoded.id,
      teamRole: cuenta?.team_role || 'owner',
      id: cuenta?.owner_id || decoded.id
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = authMiddleware;
