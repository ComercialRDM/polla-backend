const express = require('express');
const pool = require('../db');
const { calcularRanking, obtenerResumenPublico, obtenerPronosticosPublicos } = require('../services/rankingService');
const { getOrSet } = require('../utils/cache');

const router = express.Router();

// Tiempo de vida de la caché para endpoints muy sondeados por el frontend (polling).
// Reduce la carga sobre la BD sin afectar perceptiblemente el "tiempo real".
const TTL_LISTA_PARTIDOS_MS = 5000;
const TTL_RANKING_MS = 5000;
const TTL_RESUMEN_MS = 8000;
const TTL_PRONOSTICOS_MS = 8000;

// GET /api/partidos - lista de partidos activos (para que el frontend muestre el partido vigente)
router.get('/', async (req, res) => {
    try {
        const partidos = await getOrSet('partidos:lista', TTL_LISTA_PARTIDOS_MS, async () => {
            const { rows } = await pool.query(
                `SELECT id, equipo_local, equipo_visitante, fecha_hora_inicio, estado, goles_local, goles_visitante
                 FROM partidos
                 ORDER BY fecha_hora_inicio ASC`
            );
            return rows;
        });
        return res.json({ success: true, partidos });
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
        const ranking = await getOrSet(`ranking:${id}`, TTL_RANKING_MS, () => calcularRanking(id));
        if (ranking.marcador === null) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        return res.json({ success: true, ...ranking });
    } catch (err) {
        console.error('Error en /partidos/:id/ranking:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/partidos/:id/resumen-publico - contador de participantes y top parcial, sin necesidad de login
router.get('/:id/resumen-publico', async (req, res) => {
    const { id } = req.params;

    try {
        const resumen = await getOrSet(`resumen:${id}`, TTL_RESUMEN_MS, () => obtenerResumenPublico(id));
        if (!resumen) {
            return res.status(404).json({ success: false, error: 'Partido no encontrado' });
        }
        return res.json({ success: true, ...resumen });
    } catch (err) {
        console.error('Error en /partidos/:id/resumen-publico:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/partidos/:id/pronosticos-publicos - listado de pronósticos registrados (nombres enmascarados), para generar FOMO
router.get('/:id/pronosticos-publicos', async (req, res) => {
    const { id } = req.params;

    try {
        const pronosticos = await getOrSet(`pronosticos:${id}`, TTL_PRONOSTICOS_MS, () => obtenerPronosticosPublicos(id));
        return res.json({ success: true, pronosticos });
    } catch (err) {
        console.error('Error en /partidos/:id/pronosticos-publicos:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
