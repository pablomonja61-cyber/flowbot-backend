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
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #000000; padding: 24px;">
            <div style="background: #0a0a0a; border-radius: 16px; overflow: hidden; border: 1px solid #222;">

              <!-- Encabezado -->
              <div style="background: #000000; padding: 32px 24px; text-align: center; border-bottom: 1px solid #222;">
                <img src="https://ariabot.app/__l5e/assets-v1/32bd803a-8b0a-42ec-9d40-4b7ef5fdb574/ariabot-logo-2026.png" alt="AriaBot" width="64" height="64" style="display: block; margin: 0 auto 12px; border-radius: 12px;" />
                <h1 style="color: #ffffff; margin: 0; font-size: 22px;">¡Bienvenido a AriaBot!</h1>
              </div>

              <!-- Cuerpo -->
              <div style="padding: 32px 28px;">
                <p style="color: #e5e5e5; font-size: 15px; margin: 0 0 20px;">Para activar tu cuenta, usa este código de verificación:</p>

                <div style="background: #111111; border: 1px solid #d11842; border-radius: 12px; padding: 24px; text-align: center; margin: 0 0 20px;">
                  <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #d11842;">${codigo}</span>
                </div>

                <p style="color: #aaa; font-size: 14px; margin: 0 0 4px;">⏱️ Este código vence en <strong style="color: #d11842;">15 minutos</strong>.</p>
                <p style="color: #666; font-size: 12px; margin: 20px 0 0; border-top: 1px solid #222; padding-top: 16px;">
                  Si no creaste una cuenta en AriaBot, puedes ignorar este correo tranquilamente.
                </p>
              </div>

              <!-- Footer -->
              <div style="background: #000000; padding: 16px; text-align: center; border-top: 1px solid #222;">
                <p style="color: #555; font-size: 11px; margin: 0;">AriaBot — Automatiza tu WhatsApp con IA</p>
              </div>

            </div>
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

// ── Correo de "Olvidé mi contraseña" — mismo estilo, mensaje distinto ──
async function enviarCorreoRecuperacion(email, codigo) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Email] RESEND_API_KEY no configurada — no se pudo enviar el correo de recuperación');
    return false;
  }

  const from = process.env.RESEND_FROM_EMAIL || 'AriaBot <onboarding@resend.dev>';

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from,
        to: email,
        subject: 'Recupera tu contraseña - AriaBot',
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #000000; padding: 24px;">
            <div style="background: #0a0a0a; border-radius: 16px; overflow: hidden; border: 1px solid #222;">

              <div style="background: #000000; padding: 32px 24px; text-align: center; border-bottom: 1px solid #222;">
                <img src="https://ariabot.app/__l5e/assets-v1/32bd803a-8b0a-42ec-9d40-4b7ef5fdb574/ariabot-logo-2026.png" alt="AriaBot" width="64" height="64" style="display: block; margin: 0 auto 12px; border-radius: 12px;" />
                <h1 style="color: #ffffff; margin: 0; font-size: 22px;">Recupera tu contraseña</h1>
              </div>

              <div style="padding: 32px 28px;">
                <p style="color: #e5e5e5; font-size: 15px; margin: 0 0 20px;">Recibimos una solicitud para restablecer tu contraseña. Usa este código:</p>

                <div style="background: #111111; border: 1px solid #d11842; border-radius: 12px; padding: 24px; text-align: center; margin: 0 0 20px;">
                  <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #d11842;">${codigo}</span>
                </div>

                <p style="color: #aaa; font-size: 14px; margin: 0 0 4px;">⏱️ Este código vence en <strong style="color: #d11842;">15 minutos</strong>.</p>
                <p style="color: #666; font-size: 12px; margin: 20px 0 0; border-top: 1px solid #222; padding-top: 16px;">
                  Si no pediste cambiar tu contraseña, puedes ignorar este correo — tu cuenta sigue segura.
                </p>
              </div>

              <div style="background: #000000; padding: 16px; text-align: center; border-top: 1px solid #222;">
                <p style="color: #555; font-size: 11px; margin: 0;">AriaBot — Automatiza tu WhatsApp con IA</p>
              </div>

            </div>
          </div>
        `
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    return true;
  } catch (err) {
    console.error('[Email] Error enviando correo de recuperación:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { enviarCorreoVerificacion, enviarCorreoRecuperacion };
