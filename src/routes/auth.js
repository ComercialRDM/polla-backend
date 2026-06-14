const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

// POST /api/auth/registro - crea la cuenta (celular + contraseña + nombre) o reclama una cuenta existente
router.post('/registro', async (req, res) => {
    const { celular, password, nombre, equipos_favoritos } = req.body;

    const celularNormalizado = normalizarCelular(celular);
    const nombreLimpio = String(nombre || '').trim();

    if (!celularNormalizado || celularNormalizado.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!nombreLimpio) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres' });
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
                `UPDATE usuarios SET nombre = $1, password_hash = $2, equipos_favoritos = $3 WHERE id = $4
                 RETURNING id, nombre, celular, equipos_favoritos`,
                [nombreLimpio, passwordHash, equipos, existentes[0].id]
            );
            usuario = rows[0];
        } else {
            const { rows } = await pool.query(
                `INSERT INTO usuarios (nombre, celular, password_hash, equipos_favoritos) VALUES ($1, $2, $3, $4)
                 RETURNING id, nombre, celular, equipos_favoritos`,
                [nombreLimpio, celularNormalizado, passwordHash, equipos]
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
            `SELECT id, nombre, celular, equipos_favoritos, password_hash FROM usuarios
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

module.exports = router;
