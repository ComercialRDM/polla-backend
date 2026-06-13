const pool = require('../db');

/**
 * Calcula el ranking de ganadores de un partido según el marcador actual.
 * Regla de desempate: el pronóstico registrado primero (fecha_registro ASC) ocupa la posición más alta.
 * @param {number} partidoId
 * @param {number} limit
 * @returns {Promise<{ marcador: {goles_local: number, goles_visitante: number} | null, ganadores: Array }>}
 */
async function calcularRanking(partidoId, limit = 10) {
    const { rows: partidoRows } = await pool.query(
        'SELECT goles_local, goles_visitante FROM partidos WHERE id = $1',
        [partidoId]
    );

    if (partidoRows.length === 0) {
        return { marcador: null, ganadores: [] };
    }

    const { goles_local, goles_visitante } = partidoRows[0];

    const { rows } = await pool.query(
        `SELECT u.id AS usuario_id, u.nombre, u.celular, p.fecha_registro
         FROM pronosticos p
         JOIN usuarios u ON u.id = p.usuario_id
         WHERE p.partido_id = $1 AND p.goles_local = $2 AND p.goles_visitante = $3
         ORDER BY p.fecha_registro ASC
         LIMIT $4`,
        [partidoId, goles_local, goles_visitante, limit]
    );

    return {
        marcador: { goles_local, goles_visitante },
        ganadores: rows.map((r, i) => ({
            posicion: i + 1,
            usuario_id: r.usuario_id,
            nombre: r.nombre,
            celular: r.celular,
            fecha_registro: r.fecha_registro,
        })),
    };
}

module.exports = { calcularRanking };
