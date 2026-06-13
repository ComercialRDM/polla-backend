const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/partidos - lista de partidos activos (para que el frontend muestre el partido vigente)
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, equipo_local, equipo_visitante, fecha_hora_inicio, estado
             FROM partidos
             ORDER BY fecha_hora_inicio ASC`
        );
        return res.json({ success: true, partidos: rows });
    } catch (err) {
        console.error('Error en /partidos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
