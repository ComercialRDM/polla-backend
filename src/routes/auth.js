const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { enviarMensajeManyChat } = require('../services/manychatService');
const { enviarCorreoOTP } = require('../services/emailService');
const { enviarCodigoTwilio, verificarCodigoTwilio } = require('../services/twilioVerifyService');
const { enviarCorreoResetPassword } = require('../services/emailService');
const adminAuth = require('../middleware/adminAuth');
const { otpLimiter, resetPasswordLimiter, correoOtpLimiter } = require('../middleware/rateLimiters');
const { generarTokenUsuario } = require('../utils/userTokens');
const { obtenerIp } = require('../utils/request');
const { registrarEvento } = require('../services/auditoriaService');

const router = express.Router();

function setCookieSesion(res, token) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('polla_token', token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
    });
}

const RESET_CODE_VIGENCIA_MIN = 10;
const RESET_INTENTOS_MAX = 5;

const TELEFONO_REGISTRO_TOKEN_VIGENCIA_MIN = 10;

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

function generarCodigoOTP() {
    return String(crypto.randomInt(100000, 1000000));
}

// POST /api/auth/telefono/solicitar-codigo - manda el código de verificación por SMS
// vía Twilio Verify, para "Continuar con teléfono" (login/registro sin contraseña)
router.post('/telefono/solicitar-codigo', otpLimiter, async (req, res) => {
    const celularNormalizado = normalizarCelular(req.body.celular);

    if (!celularNormalizado || celularNormalizado.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }

    try {
        await enviarCodigoTwilio(celularNormalizado);
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /auth/telefono/solicitar-codigo:', err.message);
        return res.status(500).json({ success: false, error: 'No se pudo enviar el código por SMS. Intenta de nuevo.' });
    }
});

// POST /api/auth/telefono/verificar-codigo - valida el código contra Twilio Verify; si
// ya existe cuenta con ese celular, inicia sesión directamente; si no, genera un
// registro_token de un solo uso para crear la cuenta en /telefono/completar.
router.post('/telefono/verificar-codigo', async (req, res) => {
    const celularNormalizado = normalizarCelular(req.body.celular);
    const { codigo } = req.body;

    if (!celularNormalizado || !codigo) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    try {
        const valido = await verificarCodigoTwilio(celularNormalizado, codigo);
        if (!valido) {
            return res.status(400).json({ success: false, error: 'Código incorrecto o vencido.' });
        }

        // Twilio Verify no guarda nada en nuestra BD una vez usado el código (ver
        // twilioVerifyService.js); este es el único rastro propio de "este celular
        // quedó verificado en este momento" que le queda al sistema.
        await registrarEvento({
            tabla: 'codigos_telefono',
            registroId: celularNormalizado,
            accion: 'telefono_verificado',
            ip: obtenerIp(req),
            userAgent: req.headers['user-agent'],
        });

        const { rows: usuarioRows } = await pool.query(
            'SELECT id, nombre, celular, correo, tipo_documento, documento, equipos_favoritos, calendario_token FROM usuarios WHERE celular = $1',
            [celularNormalizado]
        );

        if (usuarioRows.length > 0) {
            await registrarEvento({
                tabla: 'usuarios',
                registroId: usuarioRows[0].id,
                accion: 'login_telefono',
                actor: String(usuarioRows[0].id),
                ip: obtenerIp(req),
                userAgent: req.headers['user-agent'],
            });
            const tokenUsuario = generarTokenUsuario(usuarioRows[0]);
            setCookieSesion(res, tokenUsuario);
            const { rows: tokenRows } = await pool.query(
                `SELECT token_acceso FROM transacciones
                 WHERE usuario_id = $1 AND estado_pago = 'APROBADO'
                 ORDER BY fecha_pago DESC NULLS LAST LIMIT 1`,
                [usuarioRows[0].id]
            );
            return res.json({
                success: true,
                usuario: usuarioRows[0],
                token: tokenUsuario,
                token_acceso: tokenRows[0]?.token_acceso || null,
            });
        }

        const registroToken = crypto.randomUUID();
        await pool.query(
            `INSERT INTO codigos_telefono (celular, codigo, expira, intentos, registro_token)
             VALUES ($1, '', now() + interval '${TELEFONO_REGISTRO_TOKEN_VIGENCIA_MIN} minutes', 0, $2)
             ON CONFLICT (celular) DO UPDATE SET
                expira = EXCLUDED.expira, registro_token = EXCLUDED.registro_token`,
            [celularNormalizado, registroToken]
        );
        return res.json({ success: true, nuevo: true, registro_token: registroToken });
    } catch (err) {
        console.error('Error en /auth/telefono/verificar-codigo:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/auth/telefono/completar - crea la cuenta (sin contraseña ni correo) para un
// celular ya verificado por OTP. El registro_token es de un solo uso (se borra al usarlo).
router.post('/telefono/completar', async (req, res) => {
    const celularNormalizado = normalizarCelular(req.body.celular);
    const { registro_token, equipos_favoritos } = req.body;
    const nombreLimpio = String(req.body.nombre || '').trim();

    if (!celularNormalizado || !registro_token) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }
    if (!nombreLimpio) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }

    const equipos = Array.isArray(equipos_favoritos) ? equipos_favoritos.slice(0, 5) : [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT * FROM codigos_telefono WHERE celular = $1 AND registro_token = $2 FOR UPDATE',
            [celularNormalizado, registro_token]
        );

        if (rows.length === 0 || new Date(rows[0].expira) < new Date()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, error: 'La verificación venció. Solicita un nuevo código.' });
        }

        await client.query('DELETE FROM codigos_telefono WHERE celular = $1', [celularNormalizado]);

        const { rows: nuevoUsuario } = await client.query(
            `INSERT INTO usuarios (nombre, celular, equipos_favoritos) VALUES ($1, $2, $3)
             RETURNING id, nombre, celular, equipos_favoritos, calendario_token`,
            [nombreLimpio, celularNormalizado, equipos]
        );

        await client.query('COMMIT');

        await registrarEvento({
            tabla: 'usuarios',
            registroId: nuevoUsuario[0].id,
            accion: 'registro_telefono',
            actor: String(nuevoUsuario[0].id),
            ip: obtenerIp(req),
            userAgent: req.headers['user-agent'],
        });

        const tokenUsuario = generarTokenUsuario(nuevoUsuario[0]);
        setCookieSesion(res, tokenUsuario);
        return res.json({ success: true, usuario: nuevoUsuario[0], token: tokenUsuario });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en /auth/telefono/completar:', err.message);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este celular.' });
        }
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

// POST /api/auth/correo/solicitar-codigo - envía código OTP al correo para login sin contraseña
router.post('/correo/solicitar-codigo', correoOtpLimiter, async (req, res) => {
    const correo = String(req.body.correo || '').toLowerCase().trim();
    if (!correo || !correo.includes('@')) {
        return res.status(400).json({ success: false, error: 'Ingresa un correo electrónico válido' });
    }
    const codigo = generarCodigoOTP();
    try {
        await pool.query(
            `INSERT INTO codigos_correo (correo, codigo, expira, intentos)
             VALUES ($1, $2, now() + interval '10 minutes', 0)
             ON CONFLICT (correo) DO UPDATE SET
                codigo = EXCLUDED.codigo, expira = EXCLUDED.expira, intentos = 0`,
            [correo, codigo]
        );
        await enviarCorreoOTP({ destinatario: correo, codigo });
        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /auth/correo/solicitar-codigo:', err.message);
        return res.status(500).json({ success: false, error: 'No se pudo enviar el código. Intenta de nuevo.' });
    }
});

// POST /api/auth/correo/verificar-codigo - valida el OTP enviado por correo e inicia sesión
router.post('/correo/verificar-codigo', async (req, res) => {
    const correo = String(req.body.correo || '').toLowerCase().trim();
    const { codigo } = req.body;
    if (!correo || !codigo) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }
    try {
        const { rows: otpRows } = await pool.query(
            'SELECT * FROM codigos_correo WHERE correo = $1 FOR UPDATE',
            [correo]
        );
        if (otpRows.length === 0 || new Date(otpRows[0].expira) < new Date()) {
            return res.status(400).json({ success: false, error: 'Código vencido o no solicitado. Pide uno nuevo.' });
        }
        if (otpRows[0].intentos >= 5) {
            await pool.query('DELETE FROM codigos_correo WHERE correo = $1', [correo]);
            return res.status(429).json({ success: false, error: 'Demasiados intentos. Solicita un nuevo código.' });
        }
        if (otpRows[0].codigo !== String(codigo).trim()) {
            await pool.query('UPDATE codigos_correo SET intentos = intentos + 1 WHERE correo = $1', [correo]);
            return res.status(400).json({ success: false, error: 'Código incorrecto.' });
        }
        await pool.query('DELETE FROM codigos_correo WHERE correo = $1', [correo]);

        const { rows: usuarioRows } = await pool.query(
            'SELECT id, nombre, celular, correo, tipo_documento, documento, equipos_favoritos, calendario_token FROM usuarios WHERE correo = $1',
            [correo]
        );
        if (usuarioRows.length > 0) {
            await registrarEvento({
                tabla: 'usuarios',
                registroId: usuarioRows[0].id,
                accion: 'login_correo',
                actor: String(usuarioRows[0].id),
                ip: obtenerIp(req),
                userAgent: req.headers['user-agent'],
            });
            const tokenUsuario = generarTokenUsuario(usuarioRows[0]);
            setCookieSesion(res, tokenUsuario);
            const { rows: tokenRows } = await pool.query(
                `SELECT token_acceso FROM transacciones
                 WHERE usuario_id = $1 AND estado_pago = 'APROBADO'
                 ORDER BY fecha_pago DESC NULLS LAST LIMIT 1`,
                [usuarioRows[0].id]
            );
            return res.json({
                success: true,
                usuario: usuarioRows[0],
                token: tokenUsuario,
                token_acceso: tokenRows[0]?.token_acceso || null,
            });
        }

        const registroToken = crypto.randomUUID();
        await pool.query(
            `INSERT INTO codigos_correo (correo, codigo, expira, intentos, registro_token)
             VALUES ($1, '', now() + interval '10 minutes', 0, $2)
             ON CONFLICT (correo) DO UPDATE SET
                expira = EXCLUDED.expira, registro_token = EXCLUDED.registro_token`,
            [correo, registroToken]
        );
        return res.json({ success: true, nuevo: true, registro_token: registroToken, correo });
    } catch (err) {
        console.error('Error en /auth/correo/verificar-codigo:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/auth/solicitar-reset - genera un código OTP y lo envía por WhatsApp o correo
router.post('/solicitar-reset', resetPasswordLimiter, async (req, res) => {
    const { celular, metodo = 'whatsapp' } = req.body;
    const celularNormalizado = normalizarCelular(celular);

    if (!celularNormalizado) {
        return res.status(400).json({ success: false, error: 'Ingresa tu número de celular' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, nombre, celular, correo, manychat_subscriber_id FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1 AND password_hash IS NOT NULL`,
            [celularNormalizado]
        );

        if (rows.length > 0) {
            const usuario = rows[0];
            const codigo = generarCodigoOTP();
            await pool.query(
                `UPDATE usuarios SET reset_code = $1, reset_code_expira = now() + interval '${RESET_CODE_VIGENCIA_MIN} minutes', reset_intentos = 0 WHERE id = $2`,
                [codigo, usuario.id]
            );

            if (metodo === 'correo') {
                if (!usuario.correo) {
                    return res.status(400).json({ success: false, error: 'Esta cuenta no tiene correo registrado. Usa la opción de WhatsApp.' });
                }
                await enviarCorreoResetPassword({
                    destinatario: usuario.correo,
                    nombre: usuario.nombre,
                    codigo,
                    vigenciaMin: RESET_CODE_VIGENCIA_MIN,
                });
                // Devolver correo enmascarado para que el usuario sepa dónde buscar
                const partes = usuario.correo.split('@');
                const mascara = partes[0].substring(0, 3) + '***@' + partes[1];
                return res.json({ success: true, destino: mascara });
            } else {
                const { subscriberId } = await enviarMensajeManyChat({
                    celular: usuario.celular,
                    mensaje: `🔐 Tu código para reestablecer tu contraseña de la Polla Mundialista es: ${codigo}\n\nEste código vence en ${RESET_CODE_VIGENCIA_MIN} minutos.`,
                    subscriberId: usuario.manychat_subscriber_id,
                });
                if (subscriberId && !usuario.manychat_subscriber_id) {
                    await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), usuario.id]);
                }
            }
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /auth/solicitar-reset:', err);
        return res.status(500).json({ success: false, error: 'No se pudo enviar el código. Intenta de nuevo.' });
    }
});

// POST /api/auth/restablecer-password - valida el código OTP y guarda la nueva contraseña
router.post('/restablecer-password', async (req, res) => {
    const { celular, codigo, nueva_password } = req.body;
    const celularNormalizado = normalizarCelular(celular);

    if (!celularNormalizado || !codigo) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }
    if (!nueva_password || nueva_password.length < 6) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, reset_code, reset_code_expira, reset_intentos FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celularNormalizado]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, error: 'No encontramos una cuenta con este celular.' });
        }

        const usuario = rows[0];

        if (!usuario.reset_code || !usuario.reset_code_expira || new Date(usuario.reset_code_expira) < new Date()) {
            return res.status(400).json({ success: false, error: 'El código venció. Solicita uno nuevo.' });
        }

        if (usuario.reset_intentos >= RESET_INTENTOS_MAX) {
            await pool.query(
                `UPDATE usuarios SET reset_code = NULL, reset_code_expira = NULL, reset_intentos = 0 WHERE id = $1`,
                [usuario.id]
            );
            return res.status(429).json({ success: false, error: 'Demasiados intentos. Solicita un nuevo código.' });
        }

        if (usuario.reset_code !== String(codigo).trim()) {
            await pool.query('UPDATE usuarios SET reset_intentos = reset_intentos + 1 WHERE id = $1', [usuario.id]);
            return res.status(400).json({ success: false, error: 'Código incorrecto.' });
        }

        const passwordHash = await bcrypt.hash(nueva_password, 10);
        await pool.query(
            `UPDATE usuarios SET password_hash = $1, reset_code = NULL, reset_code_expira = NULL, reset_intentos = 0 WHERE id = $2`,
            [passwordHash, usuario.id]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('Error en /auth/restablecer-password:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/auth/manychat/diagnostico - verifica que MANYCHAT_API_KEY esté configurada
router.get('/manychat/diagnostico', adminAuth, (req, res) => {
    const key = process.env.MANYCHAT_API_KEY || '';
    res.json({ configurado: !!key, prefijo: key ? key.substring(0, 10) + '...' : '(vacío)' });
});

// GET /api/auth/smtp/diagnostico - verifica configuración SMTP
router.get('/smtp/diagnostico', adminAuth, (req, res) => {
    res.json({
        SMTP_HOST: process.env.SMTP_HOST || '(vacío)',
        SMTP_PORT: process.env.SMTP_PORT || '(vacío)',
        SMTP_USER: process.env.SMTP_USER ? process.env.SMTP_USER.substring(0, 6) + '...' : '(vacío)',
        SMTP_PASS: process.env.SMTP_PASS ? '✓ configurado' : '(vacío)',
        MAIL_FROM: process.env.MAIL_FROM || '(vacío)',
    });
});

// POST /api/auth/logout - elimina la cookie de sesión del usuario
router.post('/logout', (req, res) => {
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie('polla_token', {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
    });
    res.json({ success: true });
});

module.exports = router;
