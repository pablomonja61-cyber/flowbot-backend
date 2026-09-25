// routes/team.js
// Invitar miembros al equipo — cada uno inicia sesión con su PROPIO
// correo, pero ve y trabaja sobre los mismos datos que el dueño de
// la cuenta (conversaciones, flujos, ventas, todo).
//
// Requiere que middleware/auth.js exponga, además de req.user.id
// (que este archivo espera que YA venga resuelto al id del DUEÑO —
// ver la nota al final sobre el ajuste necesario en el middleware):
//   req.user.actualId  → el id de quien inició sesión de verdad
//   req.user.teamRole  → 'owner' | 'admin' | 'member'

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

router.use(auth);

function soloDueñoOAdmin(req) {
  const rol = req.user.teamRole || 'owner';
  if (rol !== 'owner' && rol !== 'admin') {
    throw Object.assign(new Error('Solo el dueño o un administrador puede gestionar el equipo.'), { status: 403 });
  }
}

// ── GET /api/team ────────────────────────────────────────────
// Lista al dueño de la cuenta + todos sus miembros de equipo.
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, team_role, created_at')
      .or(`id.eq.${req.user.id},owner_id.eq.${req.user.id}`)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const { data: invitaciones } = await supabase
      .from('team_invitations')
      .select('id, email, role, accepted, expires_at, created_at')
      .eq('owner_id', req.user.id)
      .eq('accepted', false)
      .gte('expires_at', new Date().toISOString());

    res.json({ miembros: data || [], invitaciones_pendientes: invitaciones || [] });
  } catch (err) { next(err); }
});

// ── POST /api/team/invite ────────────────────────────────────
router.post('/invite', async (req, res, next) => {
  try {
    soloDueñoOAdmin(req);
    const email = (req.body?.email || '').trim().toLowerCase();
    const role = ['admin', 'member'].includes(req.body?.role) ? req.body.role : 'member';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Correo inválido.' });

    const { data: yaExiste } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (yaExiste) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

    const token = crypto.randomBytes(32).toString('hex');
    const { data: invitacion, error } = await supabase
      .from('team_invitations')
      .insert({
        owner_id: req.user.id, email, role, token,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      })
      .select().single();
    if (error) throw error;

    const link = `${process.env.FRONTEND_URL || 'https://ariabot.app'}/aceptar-invitacion?token=${token}`;

    // TODO: mandar este link por correo de verdad (falta conectar un
    // servicio de envío de emails — por ahora se devuelve el link
    // aquí mismo para que lo copies y se lo mandes tú manualmente).
    res.status(201).json({ success: true, invite_link: link, expira: invitacion.expires_at });
  } catch (err) { next(err); }
});

// ── POST /api/team/accept ────────────────────────────────────
// SIN autenticación — la usa la persona invitada, que todavía no
// tiene cuenta. Crea su login real.
const publicRouter = express.Router();
publicRouter.post('/accept', async (req, res, next) => {
  try {
    const { token, name, password } = req.body || {};
    if (!token || !name || !password || password.length < 6) {
      return res.status(400).json({ error: 'Faltan datos, o la contraseña debe tener al menos 6 caracteres.' });
    }

    const { data: invitacion } = await supabase
      .from('team_invitations')
      .select('*')
      .eq('token', token)
      .eq('accepted', false)
      .gte('expires_at', new Date().toISOString())
      .maybeSingle();
    if (!invitacion) return res.status(404).json({ error: 'Invitación inválida o vencida.' });

    const password_hash = await bcrypt.hash(password, 10);
    const { data: nuevoUsuario, error } = await supabase
      .from('users')
      .insert({ name, email: invitacion.email, password_hash, owner_id: invitacion.owner_id, team_role: invitacion.role })
      .select('id, name, email, team_role').single();
    if (error) throw error;

    await supabase.from('team_invitations').update({ accepted: true }).eq('id', invitacion.id);

    res.status(201).json({ success: true, user: nuevoUsuario });
  } catch (err) { next(err); }
});

// ── DELETE /api/team/:userId ─────────────────────────────────
router.delete('/:userId', async (req, res, next) => {
  try {
    soloDueñoOAdmin(req);
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo.' });
    const { error } = await supabase.from('users').delete().eq('id', req.params.userId).eq('owner_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = { router, publicRouter };
