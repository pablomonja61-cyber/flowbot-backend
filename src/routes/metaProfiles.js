// routes/metaProfiles.js
// Conectar perfiles de Meta pegando un token (sin necesitar el permiso
// de "Iniciar sesión con Facebook"). Cada usuario puede tener varios.
// Móntala en index.js con: app.use('/api/meta-profiles', require('./routes/metaProfiles'));

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const svc = require('../services/metaProfiles');

router.use(auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Nunca se devuelve el token, solo datos para mostrar.
const publico = p => ({
  id: p.id, name: p.name, fb_id: p.fb_id, status: p.status,
  last_error: p.last_error, last_checked_at: p.last_checked_at, created_at: p.created_at
});

// ── GET /api/meta-profiles ───────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('meta_profiles').select('id, name, fb_id, status, last_error, last_checked_at, created_at')
      .eq('user_id', req.user.id).order('created_at', { ascending: true });
    if (error) throw error;
    const { data: accs } = await supabase
      .from('meta_profile_accounts').select('profile_id').eq('user_id', req.user.id);
    const counts = {};
    (accs || []).forEach(a => { counts[a.profile_id] = (counts[a.profile_id] || 0) + 1; });
    res.json((data || []).map(p => ({ ...publico(p), accounts_count: counts[p.id] || 0 })));
  } catch (err) { next(err); }
});

// ── POST /api/meta-profiles  { token, name? } ────────────────
// Valida el token contra Meta ANTES de guardarlo.
router.post('/', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (token.length < 20) return res.status(400).json({ error: 'Pega el token completo.' });

    let info;
    try { info = await svc.fetchProfileFromMeta(token); }
    catch (err) { return res.status(400).json({ error: svc.metaError(err).message }); }

    const name = String(req.body?.name || '').trim().slice(0, 80) || info.name;
    const { data: profile, error } = await supabase
      .from('meta_profiles')
      .upsert({
        user_id: req.user.id, fb_id: info.fb_id, name,
        token_encrypted: svc.encrypt(token), status: 'active', last_error: null,
        last_checked_at: new Date().toISOString()
      }, { onConflict: 'user_id,fb_id' })
      .select().single();
    if (error) throw error;

    await svc.saveAccounts(profile.id, req.user.id, info.accounts);
    res.status(201).json({ ...publico(profile), accounts_count: info.accounts.length });
  } catch (err) { next(err); }
});

// ── POST /api/meta-profiles/:id/refresh ──────────────────────
// Vuelve a consultar Meta (por si se agregaron cuentas nuevas o el token venció).
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const { data: p } = await supabase
      .from('meta_profiles').select('*').eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!p) return res.status(404).json({ error: 'Perfil no encontrado.' });
    try {
      const info = await svc.fetchProfileFromMeta(svc.decrypt(p.token_encrypted));
      await supabase.from('meta_profiles')
        .update({ status: 'active', last_error: null, last_checked_at: new Date().toISOString() }).eq('id', p.id);
      await svc.saveAccounts(p.id, req.user.id, info.accounts);
      res.json({ success: true, accounts_count: info.accounts.length });
    } catch (err) {
      const m = svc.metaError(err);
      if (m.code === 190) await svc.markExpired(p.id, m.message);
      res.status(400).json({ error: m.message });
    }
  } catch (err) { next(err); }
});

// ── PATCH /api/meta-profiles/:id  { name } ───────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Escribe un nombre.' });
    const { error } = await supabase.from('meta_profiles').update({ name }).eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/meta-profiles/:id ────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase.from('meta_profiles').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
