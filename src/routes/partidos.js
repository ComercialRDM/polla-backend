const express = require('express');
const pool = require('../db');
const { calcularRanking } = require('../services/rankingService');

const router = express.Router();

// GET /api/partidos - lista de partidos activos (para que el frontend muestre el partido vigente)
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, equipo_local, equipo_visitante, fecha_hora_inicio, estado, goles_local, goles_visitante
             FROM partidos
             ORDER BY fecha_hora_inicio ASC`
        );
        return res.json({ success: true, partidos: rows });
    } catch (err) {
        console.error('Error en /partidos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/partidos/:id/ranking - ranking dinámico de ganadores según el marcador en vivo,
// desempatado por orden de registro del pronóstico (fecha_registro ASC)
router.get('/:id/ranking', async (req, res) => {
    const { id } = req.params;

    try {
        const ranking = await calcularRanking(id);
        if (ranking.marcador === null) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        return res.json({ success: true, ...ranking });
    } catch (err) {
        console.error('Error en /partidos/:id/ranking:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
