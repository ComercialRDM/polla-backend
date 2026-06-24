const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db');
const { enviarMensajeManyChat } = require('../services/manychatService');
const { enviarCodigoTwilio, verificarCodigoTwilio } = require('../services/twilioVerifyService');
const { enviarCorreoResetPassword } = require('../services/emailService');
const adminAuth = require('../middleware/adminAuth');
const { otpLimiter, resetPasswordLimiter } = require('../middleware/rateLimiters');
const { generarTokenUsuario } = require('../utils/userTokens');

const router = express.Router();

const RESET_CODE_VIGENCIA_MIN = 10;
const RESET_INTENTOS_MAX = 5;

const TELEFONO_REGISTRO_TOKEN_VIGENCIA_MIN = 10;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Verifica el ID token de Google y devuelve su payload (sub, email, name, email_verified)
async function verificarTokenGoogle(credential) {
    const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    return ticket.getPayload();
}

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

function generarCodigoOTP() {
    return String(crypto.randomInt(100000, 1000000));
}

// POST /api/auth/registro - crea la cuenta (celular + contraseña + nombre) o reclama una cuenta existente
router.post('/registro', async (req, res) => {
    const { celular, password, nombre, correo, equipos_favoritos } = req.body;

    const celularNormalizado = normalizarCelular(celular);
    const nombreLimpio = String(nombre || '').trim();
    const correoLimpio = String(correo || '').trim().toLowerCase();

    if (!celularNormalizado || celularNormalizado.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!nombreLimpio) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }
    if (!correoLimpio || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoLimpio)) {
        return res.status(400).json({ success: false, error: 'Ingresa un correo electrónico válido' });
    }
    if (!password || password.length < 8) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener mayúscula, minúscula y número' });
    }

    const equipos = Array.isArray(equipos_favoritos) ? equipos_favoritos.slice(0, 5) : [];

    try {
        const [{ rows: porCelular }, { rows: porCorreo }] = await Promise.all([
            pool.query(
                `SELECT id, password_hash FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
                [celularNormalizado]
            ),
            pool.query(
                `SELECT id FROM usuarios WHERE correo = $1 AND password_hash IS NOT NULL`,
                [correoLimpio]
            ),
        ]);

        const celularTieneCuenta = porCelular.length > 0 && !!porCelular[0].password_hash;
        const correoTieneCuenta = porCorreo.length > 0;

        if (celularTieneCuenta && correoTieneCuenta) {
            return res.status(409).json({ success: false, error: 'Ya hay una cuenta creada con este correo electrónico y número de celular. Inicia sesión.' });
        }
        if (celularTieneCuenta) {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este número de celular. Inicia sesión.' });
        }
        if (correoTieneCuenta) {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este correo electrónico. Inicia sesión.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        let usuario;

        if (porCelular.length > 0) {
            // Usuario de prueba (sin contraseña) — reclamar la cuenta
            const { rows } = await pool.query(
                `UPDATE usuarios SET nombre = $1, password_hash = $2, correo = $3, equipos_favoritos = $4 WHERE id = $5
                 RETURNING id, nombre, celular, correo, equipos_favoritos, calendario_token`,
                [nombreLimpio, passwordHash, correoLimpio, equipos, porCelular[0].id]
            );
            usuario = rows[0];
        } else {
            const { rows } = await pool.query(
                `INSERT INTO usuarios (nombre, celular, correo, password_hash, equipos_favoritos) VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, celular, correo, equipos_favoritos, calendario_token`,
                [nombreLimpio, celularNormalizado, correoLimpio, passwordHash, equipos]
            );
            usuario = rows[0];
        }

        return res.json({ success: true, usuario, token: generarTokenUsuario(usuario) });
    } catch (err) {
        console.error('Error en /auth/registro:', err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con estos datos. Inicia sesión.' });
        }
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/auth/login - inicia sesión con celular + contraseña
router.post('/login', async (req, res) => {
    const { celular, password } = req.body;
    const celularNormalizado = normalizarCelular(celular);

    if (!celularNormalizado || !password) {
        return res.status(400).json({ success: false, error: 'Faltan campos requeridos' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, nombre, celular, equipos_favoritos, calendario_token, password_hash FROM usuarios
             WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celularNormalizado]
        );

        if (rows.length === 0 || !rows[0].password_hash) {
            return res.status(404).json({ success: false, error: 'No encontramos una cuenta con este celular. Regístrate primero.' });
        }

        const valido = await bcrypt.compare(password, rows[0].password_hash);
        if (!valido) {
            return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
        }

        const { password_hash, ...usuario } = rows[0];
        return res.json({ success: true, usuario, token: generarTokenUsuario(usuario) });
    } catch (err) {
        console.error('Error en /auth/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

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

        const { rows: usuarioRows } = await pool.query(
            'SELECT id, nombre, celular, equipos_favoritos, calendario_token FROM usuarios WHERE celular = $1',
            [celularNormalizado]
        );

        if (usuarioRows.length > 0) {
            return res.json({ success: true, usuario: usuarioRows[0], token: generarTokenUsuario(usuarioRows[0]) });
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
        return res.json({ success: true, usuario: nuevoUsuario[0], token: generarTokenUsuario(nuevoUsuario[0]) });
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

// GET /api/auth/google/diagnostico - verifica que GOOGLE_CLIENT_ID esté bien configurado
// Protegido con adminAuth: expone prefijos de credenciales, no debe ser público.
router.get('/google/diagnostico', adminAuth, (req, res) => {
    const id = process.env.GOOGLE_CLIENT_ID || '';
    res.json({ configurado: !!id, prefijo: id ? id.substring(0, 25) + '...' : '(vacío)' });
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

// POST /api/auth/google - inicia sesión (o detecta cuenta nueva) con un ID token de Google
router.post('/google', async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({ success: false, error: 'Falta el token de Google' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(500).json({ success: false, error: 'Login con Google no configurado' });
    }

    try {
        const payload = await verificarTokenGoogle(credential);
        const googleId = payload.sub;
        const correo = payload.email;
        const nombre = payload.name || '';

        const { rows: porGoogleId } = await pool.query(
            'SELECT id, nombre, celular, equipos_favoritos, calendario_token FROM usuarios WHERE google_id = $1',
            [googleId]
        );
        if (porGoogleId.length > 0) {
            return res.json({ success: true, usuario: porGoogleId[0], token: generarTokenUsuario(porGoogleId[0]) });
        }

        // Si ya existe una cuenta con ese correo verificado, se vincula a la cuenta de Google
        if (correo && payload.email_verified) {
            const { rows: porCorreo } = await pool.query(
                'SELECT id, nombre, celular, equipos_favoritos, calendario_token FROM usuarios WHERE correo = $1',
                [correo]
            );
            if (porCorreo.length > 0) {
                await pool.query('UPDATE usuarios SET google_id = $1 WHERE id = $2', [googleId, porCorreo[0].id]);
                return res.json({ success: true, usuario: porCorreo[0], token: generarTokenUsuario(porCorreo[0]) });
            }
        }

        // Cuenta nueva: el frontend debe pedir el celular antes de crearla
        return res.json({
            success: true,
            nuevo: true,
            datos: { nombre, correo: correo || '' },
        });
    } catch (err) {
        console.error('Error en /auth/google:', err.message);
        const detalle = err.message?.includes('audience') ? 'client_id no coincide'
            : err.message?.includes('expired') ? 'token expirado'
            : err.message;
        return res.status(401).json({ success: false, error: 'Token de Google inválido', detalle });
    }
});

// POST /api/auth/google/completar - crea (o vincula) la cuenta de un usuario nuevo de Google con su celular
router.post('/google/completar', async (req, res) => {
    const { credential, celular, equipos_favoritos } = req.body;
    const celularNormalizado = normalizarCelular(celular);

    if (!credential) {
        return res.status(400).json({ success: false, error: 'Falta el token de Google' });
    }
    if (!celularNormalizado || celularNormalizado.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(500).json({ success: false, error: 'Login con Google no configurado' });
    }

    const equipos = Array.isArray(equipos_favoritos) ? equipos_favoritos.slice(0, 5) : [];

    try {
        const payload = await verificarTokenGoogle(credential);
        const googleId = payload.sub;
        const correo = payload.email_verified ? payload.email : null;
        const nombre = payload.name || '';

        const { rows: existentes } = await pool.query(
            `SELECT id, google_id FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celularNormalizado]
        );

        let usuario;
        if (existentes.length > 0) {
            if (existentes[0].google_id && existentes[0].google_id !== googleId) {
                return res.status(409).json({ success: false, error: 'Este celular ya está vinculado a otra cuenta de Google.' });
            }

            const { rows } = await pool.query(
                `UPDATE usuarios SET google_id = $1 WHERE id = $2
                 RETURNING id, nombre, celular, equipos_favoritos, calendario_token`,
                [googleId, existentes[0].id]
            );
            usuario = rows[0];
        } else {
            const { rows } = await pool.query(
                `INSERT INTO usuarios (nombre, correo, celular, google_id, equipos_favoritos) VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, celular, equipos_favoritos, calendario_token`,
                [nombre || 'Usuario', correo, celularNormalizado, googleId, equipos]
            );
            usuario = rows[0];
        }

        return res.json({ success: true, usuario, token: generarTokenUsuario(usuario) });
    } catch (err) {
        console.error('Error en /auth/google/completar:', err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este celular o correo.' });
        }
        return res.status(401).json({ success: false, error: 'Token de Google inválido' });
    }
});

module.exports = router;
