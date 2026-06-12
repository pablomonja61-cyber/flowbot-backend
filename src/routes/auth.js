const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const supabase = require('../models/supabase');

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password y name son requeridos' });
    }

    // Crear usuario en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email, password
    });
    if (authError) throw { status: 400, message: authError.message };

    // Crear perfil en tabla users
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .insert({ id: authData.user.id, email, name, plan: 'free' })
      .select()
      .single();
    if (profileError) throw profileError;

    const token = jwt.sign(
      { id: profile.id, email: profile.email, plan: profile.plan },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, user: profile });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son requeridos' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    const token = jwt.sign(
      { id: profile.id, email: profile.email, plan: profile.plan },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ token, user: profile });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
const authMiddleware = require('../middleware/auth');
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
