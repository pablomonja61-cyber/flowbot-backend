const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');
const { enviarCorreoVerificacion, enviarCorreoRecuperacion } = require('../services/email');

const MAX_CUENTAS_POR_IP = 5;
const CODIGO_VALIDO_MINUTOS = 15;

function generarCodigo() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
}

// Saca la IP real del que hace la petición — funciona bien detrás del
// proxy de Railway siempre que index.js tenga app.set('trust proxy', true).
function obtenerIP(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'desconocida';
}

// ── POST /api/auth/register ──────────────────────────────────
// Paso 1: valida todo, crea la cuenta SIN activar, manda el código
// de verificación por correo. Todavía no se puede iniciar sesión.
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, phone } = req.body;
    if (!email || !password || !name || !phone) {
      return res.status(400).json({ error: 'nombre, correo, teléfono y contraseña son requeridos' });
    }

    const emailNormalizado = email.toLowerCase().trim();
    const ip = obtenerIP(req);

    // 1. Verificar que este correo tenga una compra aprobada en Hotmart
    const { data: compra } = await supabase
      .from('hotmart_purchases')
      .select('status')
      .eq('email', emailNormalizado)
      .maybeSingle();

    if (!compra || compra.status !== 'approved') {
      return res.status(403).json({
        error: 'Este correo no tiene una compra válida de AriaBot. Usa el mismo correo con el que compraste, o adquiere tu acceso primero.'
      });
    }

    // 2. Límite de cuentas por IP — evita que una sola persona cree
    // decenas de cuentas para abusar de pruebas gratis, etc.
    const { count: cuentasDesdeEstaIP } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('registration_ip', ip);

    if ((cuentasDesdeEstaIP || 0) >= MAX_CUENTAS_POR_IP) {
      return res.status(403).json({
        error: `Ya se alcanzó el máximo de ${MAX_CUENTAS_POR_IP} cuentas creadas desde esta conexión. Si crees que esto es un error, contáctanos.`
      });
    }

    // 2.5 Un mismo número de teléfono no puede tener más de una cuenta
    const { data: telefonoExistente } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (telefonoExistente) {
      return res.status(400).json({ error: 'Ya existe una cuenta registrada con ese número de teléfono.' });
    }

    // 3. Crear usuario en Supabase Auth (esto sí guarda la contraseña
    // de forma segura, encriptada — nosotros nunca la vemos en texto plano)
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: emailNormalizado, password
    });
    if (authError) throw { status: 400, message: authError.message };

    // 4. Crear perfil, pero SIN verificar todavía
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .insert({
        id: authData.user.id,
        email: emailNormalizado,
        name,
        phone,
        plan: 'free',
        registration_ip: ip,
        email_verified: false
      })
      .select()
      .single();
    if (profileError) throw profileError;

    // 5. Generar y guardar el código de verificación
    const codigo = generarCodigo();
    const expiresAt = new Date(Date.now() + CODIGO_VALIDO_MINUTOS * 60 * 1000).toISOString();

    const { error: codeInsertError } = await supabase.from('email_verifications').insert({
      id: uuidv4(),
      email: emailNormalizado,
      code: codigo,
      expires_at: expiresAt,
      verified: false
    });
    if (codeInsertError) {
      console.error('[Auth] Error guardando el código de verificación:', codeInsertError.message);
    }

    // 6. Mandar el correo con el código
    const enviado = await enviarCorreoVerificacion(emailNormalizado, codigo);
    if (!enviado) {
      console.error(`[Auth] No se pudo mandar el correo de verificación a ${emailNormalizado} — el código igual quedó guardado: ${codigo}`);
    }

    res.status(201).json({
      message: 'Cuenta creada. Revisa tu correo y verifica tu cuenta con el código que te enviamos.',
      email: emailNormalizado
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/verify-email ──────────────────────────────
// Paso 2: el usuario pone el código que recibió por correo. Si es
// correcto, se activa la cuenta y ahí sí se le entrega su sesión.
router.post('/verify-email', async (req, res, next) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'correo y código son requeridos' });
    }

    const emailNormalizado = email.toLowerCase().trim();

    const { data: verificacion } = await supabase
      .from('email_verifications')
      .select('*')
      .eq('email', emailNormalizado)
      .eq('code', code)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!verificacion) {
      return res.status(400).json({ error: 'Código incorrecto.' });
    }
    if (new Date(verificacion.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Este código ya venció. Pide uno nuevo.' });
    }

    // Marcar el código como usado
    await supabase.from('email_verifications').update({ verified: true }).eq('id', verificacion.id);

    // Activar la cuenta
    const { data: profile, error: updateError } = await supabase
      .from('users')
      .update({ email_verified: true })
      .eq('email', emailNormalizado)
      .select()
      .single();
    if (updateError) throw updateError;

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

// ── POST /api/auth/resend-code ───────────────────────────────
// Por si el código venció o nunca llegó el correo.
router.post('/resend-code', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'correo es requerido' });

    const emailNormalizado = email.toLowerCase().trim();

    const { data: profile } = await supabase
      .from('users')
      .select('email_verified')
      .eq('email', emailNormalizado)
      .single();

    if (!profile) return res.status(404).json({ error: 'No existe una cuenta con ese correo.' });
    if (profile.email_verified) return res.status(400).json({ error: 'Esta cuenta ya está verificada.' });

    const codigo = generarCodigo();
    const expiresAt = new Date(Date.now() + CODIGO_VALIDO_MINUTOS * 60 * 1000).toISOString();

    const { error: codeInsertError } = await supabase.from('email_verifications').insert({
      id: uuidv4(),
      email: emailNormalizado,
      code: codigo,
      expires_at: expiresAt,
      verified: false
    });
    if (codeInsertError) {
      console.error('[Auth] Error guardando el código de verificación (reenvío):', codeInsertError.message);
    }

    await enviarCorreoVerificacion(emailNormalizado, codigo);
    res.json({ message: 'Te mandamos un nuevo código.' });
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

    // No dejar entrar si nunca terminó de verificar su correo
    if (!profile.email_verified) {
      return res.status(403).json({
        error: 'Tu cuenta todavía no está verificada. Revisa tu correo, o pide un código nuevo.',
        needs_verification: true,
        email: profile.email
      });
    }

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

// ── GET /api/auth/detect-country ─────────────────────────────
// Detecta el país del visitante por su IP, para preseleccionar el
// código de país (+51, +52, etc.) en el formulario de registro.
router.get('/detect-country', async (req, res) => {
  try {
    const ip = obtenerIP(req);
    const { data } = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 5000 });
    res.json({
      country_code: data?.country_code || null, // ej. "PE"
      calling_code: data?.country_calling_code || null // ej. "+51"
    });
  } catch (err) {
    // Si falla la detección, no es grave — el frontend simplemente
    // deja el selector de país en un valor por defecto.
    res.json({ country_code: null, calling_code: null });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────
// Paso 1: la persona pone su correo, le mandamos un código.
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'correo es requerido' });

    const emailNormalizado = email.toLowerCase().trim();

    const { data: profile } = await supabase
      .from('users')
      .select('id')
      .eq('email', emailNormalizado)
      .maybeSingle();

    // Por seguridad, respondemos igual exista o no la cuenta — así
    // nadie puede usar este formulario para "adivinar" qué correos
    // están registrados en AriaBot.
    if (!profile) {
      return res.json({ message: 'Si ese correo tiene una cuenta, te mandamos un código para restablecer la contraseña.' });
    }

    const codigo = generarCodigo();
    const expiresAt = new Date(Date.now() + CODIGO_VALIDO_MINUTOS * 60 * 1000).toISOString();

    const { error: insertError } = await supabase.from('password_resets').insert({
      id: uuidv4(),
      email: emailNormalizado,
      code: codigo,
      expires_at: expiresAt,
      verified: false
    });
    if (insertError) console.error('[Auth] Error guardando código de recuperación:', insertError.message);

    await enviarCorreoRecuperacion(emailNormalizado, codigo);

    res.json({ message: 'Si ese correo tiene una cuenta, te mandamos un código para restablecer la contraseña.' });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/reset-password ────────────────────────────
// Paso 2: la persona pone el código + su contraseña nueva.
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) {
      return res.status(400).json({ error: 'correo, código y nueva contraseña son requeridos' });
    }

    const emailNormalizado = email.toLowerCase().trim();

    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('email', emailNormalizado)
      .eq('code', code)
      .eq('verified', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!reset) return res.status(400).json({ error: 'Código incorrecto.' });
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Este código ya venció. Pide uno nuevo.' });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('id')
      .eq('email', emailNormalizado)
      .single();
    if (!profile) return res.status(404).json({ error: 'No existe una cuenta con ese correo.' });

    // Cambiar la contraseña de verdad, usando el acceso de administrador
    const { error: updateError } = await supabase.auth.admin.updateUserById(profile.id, { password: new_password });
    if (updateError) throw updateError;

    await supabase.from('password_resets').update({ verified: true }).eq('id', reset.id);

    res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión con tu nueva contraseña.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
