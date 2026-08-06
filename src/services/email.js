const axios = require('axios');

// ── Envío de correos transaccionales con Resend ─────────────────
// Gratis hasta 3,000 correos al mes. Necesita RESEND_API_KEY en las
// variables de entorno de Railway.
//
// IMPORTANTE sobre el remitente ("from"): mientras no verifiques tu
// propio dominio en Resend (Dashboard → Domains), solo vas a poder
// usar la dirección de prueba "onboarding@resend.dev", que tiene
// límites (puede que solo entregue a tu propio correo de cuenta, no
// a cualquier usuario real). Para producción de verdad, verifica tu
// dominio en Resend y cambia RESEND_FROM_EMAIL a algo como
// "AriaBot <noreply@tudominio.com>".
async function enviarCorreoVerificacion(email, codigo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Email] RESEND_API_KEY no configurada — no se pudo enviar el correo de verificación');
    return false;
  }

  const from = process.env.RESEND_FROM_EMAIL || 'AriaBot <onboarding@resend.dev>';

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from,
        to: email,
        subject: 'Verifica tu correo - AriaBot',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
            <h2>¡Bienvenido a AriaBot! 🤖</h2>
            <p>Para activar tu cuenta, usa este código de verificación:</p>
            <div style="background: #f0f4ff; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2563eb;">${codigo}</span>
            </div>
            <p>Este código vence en 15 minutos.</p>
            <p style="color: #888; font-size: 13px;">Si no creaste una cuenta en AriaBot, puedes ignorar este correo.</p>
          </div>
        `
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return true;
  } catch (err) {
    console.error('[Email] Error enviando correo de verificación:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { enviarCorreoVerificacion };
