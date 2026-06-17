const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db');
const { enviarMensajeManyChat } = require('../services/manychatService');

const router = express.Router();

const RESET_CODE_VIGENCIA_MIN = 10;
const RESET_INTENTOS_MAX = 5;

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
    const correoLimpio = String(correo || '').trim().toLowerCase() || null;

    if (!celularNormalizado || celularNormalizado.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!nombreLimpio) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }
    if (!password || password.length < 8) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener mayúscula, minúscula y número' });
    }

    const equipos = Array.isArray(equipos_favoritos) ? equipos_favoritos.slice(0, 5) : [];

    try {
        const { rows: existentes } = await pool.query(
            `SELECT id, password_hash FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1`,
            [celularNormalizado]
        );

        const passwordHash = await bcrypt.hash(password, 10);
        let usuario;

        if (existentes.length > 0) {
            if (existentes[0].password_hash) {
                return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este celular. Inicia sesión.' });
            }

            const { rows } = await pool.query(
                `UPDATE usuarios SET nombre = $1, password_hash = $2, correo = $3, equipos_favoritos = $4 WHERE id = $5
                 RETURNING id, nombre, celular, correo, equipos_favoritos, calendario_token`,
                [nombreLimpio, passwordHash, correoLimpio, equipos, existentes[0].id]
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

        return res.json({ success: true, usuario });
    } catch (err) {
        console.error('Error en /auth/registro:', err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este celular. Inicia sesión.' });
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
        return res.json({ success: true, usuario });
    } catch (err) {
        console.error('Error en /auth/login:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/auth/solicitar-reset - genera un código OTP y lo envía por WhatsApp (ManyChat)
router.post('/solicitar-reset', async (req, res) => {
    const { celular } = req.body;
    const celularNormalizado = normalizarCelular(celular);

    if (!celularNormalizado) {
        return res.status(400).json({ success: false, error: 'Ingresa tu número de celular' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, celular, manychat_subscriber_id FROM usuarios WHERE regexp_replace(celular, '[^0-9+]', '', 'g') = $1 AND password_hash IS NOT NULL`,
            [celularNormalizado]
        );

        // Respuesta genérica siempre, exista o no la cuenta, para evitar enumeración de usuarios.
        // El mensaje de WhatsApp solo se envía si la cuenta existe.
        if (rows.length > 0) {
            const codigo = generarCodigoOTP();
            await pool.query(
                `UPDATE usuarios SET reset_code = $1, reset_code_expira = now() + interval '${RESET_CODE_VIGENCIA_MIN} minutes', reset_intentos = 0 WHERE id = $2`,
                [codigo, rows[0].id]
            );

            const { subscriberId } = await enviarMensajeManyChat({
                celular: rows[0].celular,
                mensaje: `🔐 Tu código para reestablecer tu contraseña de la Polla Mundialista es: ${codigo}\n\nEste código vence en ${RESET_CODE_VIGENCIA_MIN} minutos.`,
                subscriberId: rows[0].manychat_subscriber_id,
            });

            if (subscriberId && !rows[0].manychat_subscriber_id) {
                await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), rows[0].id]);
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
router.get('/google/diagnostico', (req, res) => {
    const id = process.env.GOOGLE_CLIENT_ID || '';
    res.json({ configurado: !!id, prefijo: id ? id.substring(0, 25) + '...' : '(vacío)' });
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
            return res.json({ success: true, usuario: porGoogleId[0] });
        }

        // Si ya existe una cuenta con ese correo verificado, se vincula a la cuenta de Google
        if (correo && payload.email_verified) {
            const { rows: porCorreo } = await pool.query(
                'SELECT id, nombre, celular, equipos_favoritos, calendario_token FROM usuarios WHERE correo = $1',
                [correo]
            );
            if (porCorreo.length > 0) {
                await pool.query('UPDATE usuarios SET google_id = $1 WHERE id = $2', [googleId, porCorreo[0].id]);
                return res.json({ success: true, usuario: porCorreo[0] });
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

        return res.json({ success: true, usuario });
    } catch (err) {
        console.error('Error en /auth/google/completar:', err);
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'Ya existe una cuenta con este celular o correo.' });
        }
        return res.status(401).json({ success: false, error: 'Token de Google inválido' });
    }
});

module.exports = router;
