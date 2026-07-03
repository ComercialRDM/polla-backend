const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/invitacion/:token - datos públicos de la invitación (sin auth)
router.get('/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const { rows } = await pool.query(
            `SELECT id, nombre_completo, seguidores, tasa_engagement, red_social, estado
             FROM influencers_preseleccionados
             WHERE token_invitacion = $1`,
            [token]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, error: 'Invitación no encontrada' });
        return res.json({ success: true, invitacion: rows[0] });
    } catch (err) {
        console.error('Error en GET /invitacion/:token:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/invitacion/:token/aceptar - acepta la invitación (idempotente)
router.post('/:token/aceptar', async (req, res) => {
    const { token } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            'SELECT * FROM influencers_preseleccionados WHERE token_invitacion = $1',
            [token]
        );
        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: 'Invitación no encontrada' });
        }

        const inv = rows[0];

        // Idempotente: ya aceptó antes
        if (inv.estado === 'aceptado') {
            await client.query('ROLLBACK');
            return res.json({ success: true, token_acceso: inv.token_acceso, ya_aceptado: true });
        }

        // Activar como influencer (crea fila en influencers → es_influencer = TRUE)
        await client.query(
            `INSERT INTO influencers (usuario_id, codigo_afiliado, porcentaje_comision)
             VALUES ($1, $2, 10.00)
             ON CONFLICT (usuario_id) DO NOTHING`,
            [inv.usuario_id, inv.codigo_afiliado]
        );

        await client.query(
            `UPDATE influencers_preseleccionados SET estado = 'aceptado' WHERE id = $1`,
            [inv.id]
        );

        await client.query('COMMIT');
        return res.json({ success: true, token_acceso: inv.token_acceso });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error en POST /invitacion/:token/aceptar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    } finally {
        client.release();
    }
});

module.exports = router;
