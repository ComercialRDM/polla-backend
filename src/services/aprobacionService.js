const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');
const { enviarBonoPorPlantilla } = require('./manychatService');
const { registrarEvento } = require('./auditoriaService');
const { registrarBonoEnSheets } = require('./sheetsService');

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
        // Además el referidor gana 20 puntos bonus en el ranking de la polla (mismo valor y
        // tope que "Comparte en Instagram", ver polla.js /registrar-compartida)
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

        await registrarEvento({
            tabla: 'transacciones',
            registroId: transaccion.id,
            accion: 'aprobar_transaccion',
            despues: { estado_pago: 'APROBADO', valor_pagado: transaccion.valor_pagado, influencer_id: transaccion.influencer_id },
        });

        // Comisión por venta atribuida a un influencer: idempotente por la
        // UNIQUE(transaccion_id) en `comisiones` (ON CONFLICT DO NOTHING).
        // Se calcula fuera de la transacción de aprobación a propósito: un
        // problema aquí no debe revertir una venta que el cliente ya pagó.
        let _influencer = null; // se usa abajo para Sheets

        if (transaccion.influencer_id && !transaccion.es_especial && !transaccion.es_test) {
            try {
                const { rows: infRows } = await pool.query(
                    `SELECT i.porcentaje_comision, i.codigo_afiliado, u.nombre
                     FROM influencers i
                     JOIN usuarios u ON u.id = i.usuario_id
                     WHERE i.id = $1 AND i.activo = TRUE`,
                    [transaccion.influencer_id]
                );
                if (infRows.length > 0) {
                    _influencer = infRows[0];
                    const porcentaje = Number(infRows[0].porcentaje_comision);
                    const montoComision = Math.round(transaccion.valor_pagado * (porcentaje / 100));

                    const { rows: comisionRows } = await pool.query(
                        `INSERT INTO comisiones (transaccion_id, influencer_id, monto_venta, porcentaje, monto_comision)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (transaccion_id) DO NOTHING
                         RETURNING id`,
                        [transaccion.id, transaccion.influencer_id, transaccion.valor_pagado, porcentaje, montoComision]
                    );
                    if (comisionRows.length > 0) {
                        await registrarEvento({
                            tabla: 'comisiones',
                            registroId: comisionRows[0].id,
                            accion: 'crear_comision',
                            despues: { transaccion_id: transaccion.id, influencer_id: transaccion.influencer_id, monto_comision: montoComision },
                        });
                    }
                }
            } catch (errComision) {
                console.error('Error calculando comisión de influencer:', errComision.message);
            }
        }

        // Recalcular pozo de premios con la nueva facturación (fuera de la TX: no bloquea si falla).
        // Los Bonos Especiales (influencers) y las transacciones de prueba no son
        // ingresos reales, así que no deben inflar el pozo (igual que ya se excluyen
        // de las comisiones, ver el if de arriba).
        if (!transaccion.es_especial && !transaccion.es_test) {
            try {
                await pool.query(`
                    UPDATE pozo_premios SET
                        total_fact  = total_fact + $1,
                        primero     = LEAST(2000000 + GREATEST((total_fact + $1) - 10000000, 0) * 0.10 * 0.50, 5000000)::bigint,
                        segundo     = LEAST(1000000 + GREATEST((total_fact + $1) - 10000000, 0) * 0.10 * 0.30, 2000000)::bigint,
                        tercero     = LEAST( 500000 + GREATEST((total_fact + $1) - 10000000, 0) * 0.10 * 0.20, 1000000)::bigint,
                        actualizado = now()
                    WHERE id = 1
                `, [transaccion.valor_pagado]);
            } catch (errPozo) {
                console.error('Error actualizando pozo_premios:', errPozo.message);
            }
        }

        // Registrar en Google Sheets (auditoría en vivo). Fire-and-forget: un
        // error aquí nunca revierte la aprobación ni bloquea al comprador.
        if (!transaccion.es_especial && !transaccion.es_test) {
            registrarBonoEnSheets({ transaccion, usuario, influencerNombre: _influencer?.nombre || '' })
                .catch(() => {});
        }

        // A partir de aquí la transacción ya quedó APROBADA en la base de datos.
        // Cualquier error al generar el bono o notificar se loguea, pero no revierte la aprobación.
        try {
            const bonoBuffer = await generarImagenBono({
                nombre: usuario.nombre,
                saldoBono: transaccion.saldo_bono,
                valorPagado: transaccion.valor_pagado,
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

            const { subscriberId } = await enviarBonoPorPlantilla({
                celular: usuario.celular,
                subscriberId: usuario.manychat_subscriber_id,
                nombre: usuario.nombre,
                monto: `$${transaccion.saldo_bono.toLocaleString('es-CO')}`,
                codigo: transaccion.token_acceso,
                partido: `${partido.equipo_local} vs ${partido.equipo_visitante}`,
                intentos: transaccion.intentos_totales,
                link: linkPolla,
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
