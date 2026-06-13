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

/**
 * Resumen público para mostrar en el Home sin necesidad de login:
 * cuántas personas ya compraron su bono para el partido y un top parcial
 * de quienes van adivinando el marcador, con el nombre enmascarado.
 * @param {number} partidoId
 * @returns {Promise<{ totalParticipantes: number, top: Array } | null>}
 */
async function obtenerResumenPublico(partidoId) {
    const { rows: partidoRows } = await pool.query(
        'SELECT goles_local, goles_visitante FROM partidos WHERE id = $1',
        [partidoId]
    );
    if (partidoRows.length === 0) return null;

    const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM transacciones WHERE partido_id = $1 AND estado_pago = 'APROBADO'`,
        [partidoId]
    );

    const { goles_local, goles_visitante } = partidoRows[0];
    const { rows: topRows } = await pool.query(
        `SELECT u.nombre, p.fecha_registro
         FROM pronosticos p
         JOIN usuarios u ON u.id = p.usuario_id
         WHERE p.partido_id = $1 AND p.goles_local = $2 AND p.goles_visitante = $3
         ORDER BY p.fecha_registro ASC
         LIMIT 3`,
        [partidoId, goles_local, goles_visitante]
    );

    return {
        totalParticipantes: totalRows[0].total,
        marcador: { goles_local, goles_visitante },
        top: topRows.map((r, i) => ({ posicion: i + 1, nombre: enmascararNombre(r.nombre) })),
    };
}

function enmascararNombre(nombreCompleto) {
    const partes = nombreCompleto.trim().split(/\s+/);
    const nombre = partes[0];
    const inicialApellido = partes.length > 1 ? `${partes[1][0]}.` : '';
    return `${nombre} ${inicialApellido}`.trim();
}

module.exports = { calcularRanking, obtenerResumenPublico };
