const express = require('express');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const pool = require('../db');

const router = express.Router();

const RP_NAME = 'Polla Mundialista La Retoucherie';
const RP_ID   = process.env.WEBAUTHN_RP_ID    || 'ganaconretoucherie.com';
const ORIGIN  = process.env.WEBAUTHN_ORIGIN   || 'https://www.ganaconretoucherie.com';

// Challenges en memoria: { key -> { challenge, expires } }
const pendientes = new Map();

function guardar(key, challenge) {
    pendientes.set(key, { challenge, expires: Date.now() + 120_000 });
}
function consumir(key) {
    const e = pendientes.get(key);
    if (!e) return null;
    pendientes.delete(key);
    if (Date.now() > e.expires) return null;
    return e.challenge;
}

// ── REGISTRO ────────────────────────────────────────────────────────────────

// GET /api/passkey/registro-opciones?usuario_id=
router.get('/registro-opciones', async (req, res) => {
    const uid = parseInt(req.query.usuario_id);
    if (!uid) return res.status(400).json({ error: 'Falta usuario_id' });

    try {
        const { rows } = await pool.query(
            'SELECT id, nombre, celular FROM usuarios WHERE id = $1', [uid]
        );
        if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
        const u = rows[0];

        const { rows: existing } = await pool.query(
            'SELECT credential_id, transports FROM passkeys WHERE usuario_id = $1', [uid]
        );

        const options = await generateRegistrationOptions({
            rpName:          RP_NAME,
            rpID:            RP_ID,
            userID:          Buffer.from(String(u.id)),
            userName:        u.celular,
            userDisplayName: u.nombre,
            excludeCredentials: existing.map(p => ({
                id: p.credential_id,
                transports: p.transports || [],
            })),
            authenticatorSelection: {
                residentKey:      'preferred',
                userVerification: 'preferred',
            },
        });

        guardar(`reg:${uid}`, options.challenge);
        return res.json(options);
    } catch (err) {
        console.error('registro-opciones:', err.message);
        return res.status(500).json({ error: 'Error interno' });
    }
});

// POST /api/passkey/registro-verificar
router.post('/registro-verificar', async (req, res) => {
    const { usuario_id, response } = req.body;
    if (!usuario_id || !response) return res.status(400).json({ error: 'Faltan datos' });

    const challenge = consumir(`reg:${usuario_id}`);
    if (!challenge) return res.status(400).json({ error: 'Challenge expirado. Intenta de nuevo.' });

    try {
        const verification = await verifyRegistrationResponse({
            response,
            expectedChallenge: challenge,
            expectedOrigin:    ORIGIN,
            expectedRPID:      RP_ID,
            requireUserVerification: false,
        });

        if (!verification.verified) return res.status(400).json({ error: 'Verificación fallida' });

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        await pool.query(
            `INSERT INTO passkeys (usuario_id, credential_id, public_key, counter, device_type, backed_up, transports)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (credential_id) DO UPDATE SET counter = EXCLUDED.counter`,
            [
                usuario_id,
                credential.id,
                Buffer.from(credential.publicKey).toString('base64'),
                credential.counter,
                credentialDeviceType,
                credentialBackedUp,
                response.response?.transports || [],
            ]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('registro-verificar:', err.message);
        return res.status(400).json({ error: err.message });
    }
});

// ── AUTENTICACIÓN ────────────────────────────────────────────────────────────

// POST /api/passkey/login-opciones  (body: { celular? })
router.post('/login-opciones', async (req, res) => {
    const { celular } = req.body || {};
    let allowCredentials = [];
    let key = 'anon';

    try {
        if (celular) {
            const limpio = String(celular).replace(/[^0-9+]/g, '');
            const { rows } = await pool.query(
                `SELECT p.credential_id, p.transports, u.id
                 FROM passkeys p
                 JOIN usuarios u ON u.id = p.usuario_id
                 WHERE regexp_replace(u.celular,'[^0-9+]','','g') = $1`,
                [limpio]
            );
            if (rows.length) {
                key = `auth:${rows[0].id}`;
                allowCredentials = rows.map(r => ({
                    id: r.credential_id,
                    transports: r.transports || [],
                }));
            }
        }

        const options = await generateAuthenticationOptions({
            rpID: RP_ID,
            allowCredentials,
            userVerification: 'preferred',
        });

        guardar(key, options.challenge);
        return res.json({ ...options, _key: key });
    } catch (err) {
        console.error('login-opciones:', err.message);
        return res.status(500).json({ error: 'Error interno' });
    }
});

// POST /api/passkey/login-verificar
router.post('/login-verificar', async (req, res) => {
    const { response, _key } = req.body;
    if (!response) return res.status(400).json({ error: 'Faltan datos' });

    const challenge = consumir(_key || 'anon');
    if (!challenge) return res.status(400).json({ error: 'Challenge expirado. Intenta de nuevo.' });

    try {
        const { rows } = await pool.query(
            `SELECT pk.*, u.id AS uid, u.nombre, u.celular, u.correo,
                    u.equipos_favoritos, u.calendario_token
             FROM passkeys pk
             JOIN usuarios u ON u.id = pk.usuario_id
             WHERE pk.credential_id = $1`,
            [response.id]
        );

        if (!rows.length) return res.status(404).json({ error: 'Passkey no reconocida en este dispositivo' });
        const pk = rows[0];

        const verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge:   challenge,
            expectedOrigin:      ORIGIN,
            expectedRPID:        RP_ID,
            requireUserVerification: false,
            credential: {
                id:         pk.credential_id,
                publicKey:  new Uint8Array(Buffer.from(pk.public_key, 'base64')),
                counter:    pk.counter,
                transports: pk.transports || [],
            },
        });

        if (!verification.verified) return res.status(401).json({ error: 'Verificación biométrica fallida' });

        await pool.query(
            'UPDATE passkeys SET counter = $1 WHERE credential_id = $2',
            [verification.authenticationInfo.newCounter, pk.credential_id]
        );

        return res.json({
            success: true,
            usuario: {
                id: pk.uid, nombre: pk.nombre, celular: pk.celular,
                correo: pk.correo, equipos_favoritos: pk.equipos_favoritos,
                calendario_token: pk.calendario_token,
            },
        });
    } catch (err) {
        console.error('login-verificar:', err.message);
        return res.status(400).json({ error: err.message });
    }
});

module.exports = router;
