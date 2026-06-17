const pool = require('../db');
const { CUPO_VALOR } = require('../config/planes');

/**
 * Calcula el monedero de cupos de un usuario a partir de sus transacciones
 * aprobadas y los pronósticos que ya ha registrado.
 * 1 cupo = $50.000 recargados = 1 pronóstico en un partido distinto.
 * @param {number} usuarioId
 * @returns {Promise<{ cuposTotales: number, cuposUsados: number, cuposDisponibles: number, dineroRecargado: number, dineroDisponible: number }>}
 */
async function obtenerSaldoUsuario(usuarioId) {
    const { rows: recargaRows } = await pool.query(
        `SELECT
            COALESCE(SUM(FLOOR(valor_pagado / $2)), 0)::int AS cupos_totales,
            COALESCE(SUM(valor_pagado), 0)::int AS dinero_recargado
         FROM transacciones
         WHERE usuario_id = $1 AND estado_pago = 'APROBADO'`,
        [usuarioId, CUPO_VALOR]
    );

    const { rows: usadosRows } = await pool.query(
        'SELECT COALESCE(SUM(cupos_costo), 0)::int AS cupos_usados FROM pronosticos WHERE usuario_id = $1',
        [usuarioId]
    );

    const cuposTotales = recargaRows[0].cupos_totales;
    const dineroRecargado = recargaRows[0].dinero_recargado;
    const cuposUsados = usadosRows[0].cupos_usados;

    const cuposDisponibles = Math.max(cuposTotales - cuposUsados, 0);
    const dineroDisponible = Math.max(dineroRecargado - cuposUsados * CUPO_VALOR, 0);

    return { cuposTotales, cuposUsados, cuposDisponibles, dineroRecargado, dineroDisponible };
}

module.exports = { obtenerSaldoUsuario };
