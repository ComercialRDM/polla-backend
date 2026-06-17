const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');
const { enviarBonoManyChat } = require('./manychatService');

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
        // Además el referidor gana 5 puntos bonus en el ranking de la polla
        if (transaccion.referido_por_token && !transaccion.referido_bono_otorgado) {
            const { rows: referidorRows } = await client.query(
                `UPDATE transacciones SET intentos_totales = intentos_totales + 1
                 WHERE token_acceso = $1 AND estado_pago = 'APROBADO'
                 RETURNING id, usuario_id`,
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

                // 20 puntos bonus al referidor (tope: 500)
                await client.query(
                    'UPDATE usuarios SET puntos_bonus = LEAST(puntos_bonus + 20, 500) WHERE id = $1',
                    [referidorRows[0].usuario_id]
                );
            }
        }

        const { rows: usuarioRows } = await client.query('SELECT * FROM usuarios WHERE id = $1', [transaccion.usuario_id]);
        const usuario = usuarioRows[0];

        const { rows: partidoRows } = await client.query('SELECT * FROM partidos WHERE id = $1', [transaccion.partido_id]);
        const partido = partidoRows[0];

        await client.query('COMMIT');

        // A partir de aquí la transacción ya quedó APROBADA en la base de datos.
        // Cualquier error al generar el bono o notificar se loguea, pero no revierte la aprobación.
        try {
            const bonoBuffer = await generarImagenBono({
                nombre: usuario.nombre,
                saldoBono: transaccion.saldo_bono,
                tokenAcceso: transaccion.token_acceso,
            });

            await enviarCorreoBono({
                destinatario: usuario.correo,
                nombre: usuario.nombre,
                saldoBono: transaccion.saldo_bono,
                intentos: transaccion.intentos_totales,
                tokenAcceso: transaccion.token_acceso,
                bonoBuffer,
            });
        } catch (errCorreo) {
            console.error('Error enviando correo del bono:', errCorreo.message);
        }

        // Enviar el bono y el acceso a la polla por WhatsApp
        try {
            const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${transaccion.token_acceso}`;
            const mensaje = `¡Gracias por tu compra, ${usuario.nombre}! 🇨🇴\n\n`
                + `Aquí está tu Bono Digital de $${transaccion.saldo_bono.toLocaleString('es-CO')} para servicios de La Retoucherie.\n\n`
                + `Ya quedaste inscrito en la Polla Mundialista para ${partido.equipo_local} vs ${partido.equipo_visitante} con ${transaccion.intentos_totales} intento(s).\n\n`
                + `Ingresa aquí para registrar tu pronóstico: ${linkPolla}`;

            const { subscriberId } = await enviarBonoManyChat({
                celular: usuario.celular,
                mensaje,
                imagenUrl: `${process.env.BACKEND_URL}/api/polla/bono/${transaccion.token_acceso}`,
                subscriberId: usuario.manychat_subscriber_id,
            });

            if (subscriberId && !usuario.manychat_subscriber_id) {
                await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), usuario.id]);
            }
        } catch (errWhatsapp) {
            console.error('Error enviando bono por WhatsApp:', errWhatsapp.response?.data || errWhatsapp.message);
        }

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
