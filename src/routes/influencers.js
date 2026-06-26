const express = require('express');
const pool = require('../db');

const router = express.Router();

const REDES_VALIDAS = ['instagram', 'tiktok', 'ambas'];

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

// POST /api/influencers/registrar - formulario público para creadores de
// contenido. Solo guarda la solicitud; el bono se crea manualmente desde el
// panel admin (sección Influenciadores) reutilizando el flujo de Bonos
// Especiales ya existente.
router.post('/registrar', async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const correo = String(req.body.correo || '').trim().toLowerCase();
    const celular = normalizarCelular(req.body.celular);
    const red_contenido = String(req.body.red_contenido || '').trim().toLowerCase();

    if (!nombre) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }
    if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        return res.status(400).json({ success: false, error: 'Ingresa un correo electrónico válido' });
    }
    if (!celular || celular.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!REDES_VALIDAS.includes(red_contenido)) {
        return res.status(400).json({ success: false, error: 'Selecciona en qué red creas contenido' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO influencer_registros (nombre, correo, celular, red_contenido)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [nombre, correo, celular, red_contenido]
        );
        return res.json({ success: true, id: rows[0].id });
    } catch (err) {
        console.error('Error en /influencers/registrar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
