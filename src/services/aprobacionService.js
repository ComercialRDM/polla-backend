const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');

/**
 * Aprueba una transacción de forma idempotente: solo actualiza si está PENDIENTE.
 * Asigna intentos/saldo, genera el bono y envía el correo.
 * @param {{ transaccionId: number, pasarelaTransaccionId?: string }} datos
 * @returns {Promise<{ ok: boolean, motivo?: string }>}
 */
async function aprobarTransaccion({ transaccionId, pasarelaTransaccionId }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows } = await client.query(
            `UPDATE transacciones
             SET estado_pago = 'APROBADO',
                 pasarela_transaccion_id = COALESCE($2, pasarela_transaccion_id)
             WHERE id = $1 AND estado_pago = 'PENDIENTE'
             RETURNING *`,
            [transaccionId, pasarelaTransaccionId || null]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, motivo: 'transaccion_no_pendiente' };
        }

        let transaccion = rows[0];

        // Recompensa por referido: si esta compra vino de un link de referido, ambos ganan 1 intento extra
        if (transaccion.referido_por_token && !transaccion.referido_bono_otorgado) {
            const { rows: referidorRows } = await client.query(
                `UPDATE transacciones SET intentos_totales = intentos_totales + 1
                 WHERE token_acceso = $1 AND estado_pago = 'APROBADO'
                 RETURNING id`,
                [transaccion.referido_por_token]
            );

            if (referidorRows.length > 0) {
                const { rows: actualizada } = await client.query(
                    `UPDATE transacciones SET intentos_totales = intentos_totales + 1, referido_bono_otorgado = TRUE
                     WHERE id = $1
                     RETURNING *`,
                    [transaccion.id]
                );
                transaccion = actualizada[0];
            }
        }

        const { rows: usuarioRows } = await client.query('SELECT * FROM usuarios WHERE id = $1', [transaccion.usuario_id]);
        const usuario = usuarioRows[0];

        await client.query('COMMIT');

        // Generar bono y enviar correo (fuera de la transacción SQL)
        const bonoBuffer = await generarImagenBono({
            nombre: usuario.nombre,
            saldoBono: transaccion.saldo_bono,
        });

        await enviarCorreoBono({
            destinatario: usuario.correo,
            nombre: usuario.nombre,
            saldoBono: transaccion.saldo_bono,
            intentos: transaccion.intentos_totales,
            tokenAcceso: transaccion.token_acceso,
            bonoBuffer,
        });

        return { ok: true };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Marca una transacción como RECHAZADA (idempotente, solo si está PENDIENTE).
 */
async function rechazarTransaccion({ transaccionId }) {
    const { rowCount } = await pool.query(
        `UPDATE transacciones
         SET estado_pago = 'RECHAZADO'
         WHERE id = $1 AND estado_pago = 'PENDIENTE'`,
        [transaccionId]
    );
    return { ok: rowCount > 0 };
}

module.exports = { aprobarTransaccion, rechazarTransaccion };
