const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { verificarToken } = require('../utils/adminTokens');
const { enviarCorreoRecuperacionAcceso, diagnosticarCorreo } = require('../services/emailService');

// Cuenta de los usuarios del panel (admin_usuarios, todos los roles: ADMIN,
// RIFA y los que se agreguen): verificación en dos pasos, cambio de contraseña
// y recuperación de acceso.
//
// Regla del negocio: el enlace de recuperación SIEMPRE se envía al correo de la
// empresa (no al de la persona), para que el dueño controle todo acceso.
const CORREO_RECUPERACION = process.env.CORREO_RECUPERACION_ACCESO || 'comercial@retoucherie.com.co';
const SITIO = process.env.FRONTEND_URL || 'https://www.ganaconretoucherie.com';
const VIGENCIA_MIN = 30;

pool.query(`
    CREATE TABLE IF NOT EXISTS admin_reset_tokens (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES admin_usuarios(id),
        token_hash CHAR(64) NOT NULL UNIQUE,
        expira_en TIMESTAMPTZ NOT NULL,
        usado_en TIMESTAMPTZ,
        ip VARCHAR(64),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`).catch((err) => console.error('[cuenta] Error migrando:', err.message));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function validarNueva(p) {
    const s = String(p || '');
    if (s.length < 12) return 'La contraseña debe tener al menos 12 caracteres.';
    if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'La contraseña debe combinar letras y números.';
    return null;
}

// Sesión de cualquier rol del panel. NO exige 2FA (aquí es donde se configura).
async function cuentaAuth(req, res, next) {
    const [tipo, token] = (req.headers.authorization || '').split(' ');
    const sesion = tipo === 'Bearer' ? verificarToken(token) : null;
    if (!sesion || !['ADMIN', 'RIFA'].includes(sesion.role)) return res.status(401).json({ success: false, error: 'No autorizado' });
    const { rows } = await pool.query('SELECT token_version FROM admin_usuarios WHERE id = $1 AND activo = TRUE', [sesion.id]);
    if (!rows.length || rows[0].token_version !== sesion.tv) {
        return res.status(401).json({ success: false, error: 'Sesión inválida. Vuelve a iniciar sesión.' });
    }
    req.admin = sesion;
    return next();
}

const router = express.Router();
const limiteRecuperar = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos. Espera 15 minutos.' } });
const limiteGeneral = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos. Espera unos minutos.' } });

// ── Con sesión ───────────────────────────────────────────────────────────────
router.get('/2fa/estado', limiteGeneral, cuentaAuth, async (req, res) => {
    const { rows } = await pool.query('SELECT totp_enabled FROM admin_usuarios WHERE id = $1', [req.admin.id]);
    return res.json({ success: true, totp_enabled: !!rows[0]?.totp_enabled, usuario: req.admin.usuario, rol: req.admin.role });
});

router.post('/2fa/setup', limiteGeneral, cuentaAuth, async (req, res) => {
    const { rows } = await pool.query('SELECT usuario, totp_enabled FROM admin_usuarios WHERE id = $1', [req.admin.id]);
    if (rows[0].totp_enabled) return res.status(409).json({ success: false, error: 'La verificación en dos pasos ya está activa.' });
    const secreto = speakeasy.generateSecret({ length: 20, name: `GanaConRetoucherie:${rows[0].usuario}`, issuer: 'La Retoucherie' });
    await pool.query('UPDATE admin_usuarios SET totp_secret = $1 WHERE id = $2', [secreto.base32, req.admin.id]);
    return res.json({ success: true, qrDataUrl: await QRCode.toDataURL(secreto.otpauth_url), clave: secreto.base32 });
});

router.post('/2fa/confirmar', limiteGeneral, cuentaAuth, async (req, res) => {
    const code = String(req.body?.code || '').replace(/\s/g, '');
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM admin_usuarios WHERE id = $1', [req.admin.id]);
    if (rows[0].totp_enabled) return res.status(409).json({ success: false, error: 'La verificación en dos pasos ya está activa.' });
    if (!rows[0].totp_secret) return res.status(400).json({ success: false, error: 'Primero genera el código QR.' });
    if (!speakeasy.totp.verify({ secret: rows[0].totp_secret, encoding: 'base32', token: code, window: 1 })) {
        return res.status(401).json({ success: false, error: 'Código incorrecto. Revisa que la hora del celular esté bien.' });
    }
    await pool.query('UPDATE admin_usuarios SET totp_enabled = TRUE WHERE id = $1', [req.admin.id]);
    return res.json({ success: true });
});

// POST /cambiar-password — body: { actual, nueva }. Cierra todas las sesiones.
router.post('/cambiar-password', limiteGeneral, cuentaAuth, async (req, res) => {
    const error = validarNueva(req.body?.nueva);
    if (error) return res.status(400).json({ success: false, error });
    const { rows } = await pool.query('SELECT password_hash FROM admin_usuarios WHERE id = $1', [req.admin.id]);
    if (!(await bcrypt.compare(String(req.body?.actual || ''), rows[0].password_hash))) {
        return res.status(401).json({ success: false, error: 'La contraseña actual no es correcta.' });
    }
    await pool.query('UPDATE admin_usuarios SET password_hash = $2, token_version = token_version + 1 WHERE id = $1',
        [req.admin.id, await bcrypt.hash(String(req.body.nueva), 12)]);
    return res.json({ success: true });
});

// POST /diagnostico-correo — body: { enviar: true } para mandar una prueba al
// correo de recuperación. Solo cuentas del panel.
router.post('/diagnostico-correo', limiteGeneral, cuentaAuth, async (req, res) => {
    const r = await diagnosticarCorreo({ enviarA: req.body?.enviar ? CORREO_RECUPERACION : null });
    return res.json({ success: true, destino: CORREO_RECUPERACION, ...r });
});

// ── Sin sesión: recuperación ─────────────────────────────────────────────────
// POST /recuperar — body: { usuario }. Responde siempre igual (no revela si el
// usuario existe). El enlace va al correo de la empresa.
router.post('/recuperar', limiteRecuperar, async (req, res) => {
    const usuario = String(req.body?.usuario || '').trim();
    const generico = { success: true, mensaje: `Si el usuario existe, enviamos un enlace de recuperación a ${CORREO_RECUPERACION.replace(/^(.{3}).*(@.*)$/, '$1•••$2')}.` };
    if (!usuario) return res.json(generico);
    try {
        const { rows } = await pool.query('SELECT id, usuario FROM admin_usuarios WHERE usuario = $1 AND activo = TRUE', [usuario]);
        if (rows.length) {
            const token = crypto.randomBytes(32).toString('hex');
            await pool.query(
                `INSERT INTO admin_reset_tokens (admin_id, token_hash, expira_en, ip) VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)`,
                [rows[0].id, sha256(token), String(VIGENCIA_MIN), String(req.ip || '').slice(0, 64)]
            );
            await enviarCorreoRecuperacionAcceso({
                destinatario: CORREO_RECUPERACION,
                usuario: rows[0].usuario,
                enlace: `${SITIO}/acceso/restablecer?t=${token}`,
                vigenciaMin: VIGENCIA_MIN,
                ip: req.ip,
            });
        }
    } catch (err) {
        console.error('[cuenta] recuperar (correo no enviado):', err.code, err.message);
    }
    return res.json(generico);
});

// POST /restablecer — body: { token, nueva }. Un solo uso, vence en 30 min.
router.post('/restablecer', limiteRecuperar, async (req, res) => {
    const error = validarNueva(req.body?.nueva);
    if (error) return res.status(400).json({ success: false, error });
    const token = String(req.body?.token || '');
    if (!/^[0-9a-f]{64}$/.test(token)) return res.status(400).json({ success: false, error: 'Enlace inválido.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, admin_id FROM admin_reset_tokens
             WHERE token_hash = $1 AND usado_en IS NULL AND expira_en > NOW() FOR UPDATE`,
            [sha256(token)]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'El enlace venció o ya fue usado. Solicita uno nuevo.' });
        }
        await client.query('UPDATE admin_reset_tokens SET usado_en = NOW() WHERE id = $1', [rows[0].id]);
        // Invalida los demás enlaces pendientes de la misma cuenta.
        await client.query('UPDATE admin_reset_tokens SET usado_en = NOW() WHERE admin_id = $1 AND usado_en IS NULL', [rows[0].admin_id]);
        const { rows: [u] } = await client.query(
            `UPDATE admin_usuarios SET password_hash = $2, token_version = token_version + 1 WHERE id = $1 RETURNING usuario`,
            [rows[0].admin_id, await bcrypt.hash(String(req.body.nueva), 12)]
        );
        await client.query('COMMIT');
        return res.json({ success: true, usuario: u.usuario });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[cuenta] restablecer:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
