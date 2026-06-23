const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');
const { enviarBonoManyChat, enviarMensajeManyChat } = require('./manychatService');

const VALOR_BONO_ESPECIAL_DEFAULT = 500000;
const INTENTOS_ESPECIAL_DEFAULT = 30;

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

async function buscarProximoPartido() {
    const { rows } = await pool.query(
        `SELECT * FROM partidos WHERE estado = 'activo' ORDER BY fecha_hora_inicio ASC LIMIT 1`
    );
    return rows[0] || null;
}

async function crearUsuarioEspecial({ nombre, celular, correo }) {
    const celularNorm = normalizarCelular(celular);
    const correoNorm = correo ? correo.trim() : null;

    const { rows: existentes } = await pool.query('SELECT * FROM usuarios WHERE celular = $1', [celularNorm]);
    if (existentes.length > 0) return existentes[0];

    const { rows } = await pool.query(
        'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
        [nombre, correoNorm, celularNorm]
    );
    return rows[0];
}

async function crearTransaccionEspecial({ usuarioId, partidoId, valorBono, intentos }) {
    const { rows } = await pool.query(
        `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_especial)
         VALUES ($1, $2, 'Especial', $3, $4, $5, 'APROBADO', TRUE)
         RETURNING *`,
        [usuarioId, partidoId, valorBono, valorBono, intentos]
    );
    return rows[0];
}

/**
 * Crea cuentas + Bonos Especiales (es_especial = TRUE) para creadores de
 * contenido/influenciadores: reciben cupos para predecir y probar la app, y
 * un bono de servicios real (válido para redimir en tienda), pero quedan
 * excluidos del ranking de premios y del Bono Colombia (ver filtros
 * `es_especial = FALSE` en rankingService.js y admin.js).
 * @param {{ personas: Array<{nombre: string, celular: string, correo?: string}>, valorBono?: number, intentos?: number }} datos
 */
async function crearBonosEspeciales({ personas, valorBono = VALOR_BONO_ESPECIAL_DEFAULT, intentos = INTENTOS_ESPECIAL_DEFAULT }) {
    const partido = await buscarProximoPartido();
    if (!partido) {
        throw new Error('No hay ningún partido activo para asociar el Bono Especial.');
    }

    const resultados = [];

    for (const persona of personas) {
        const resultado = { nombre: persona.nombre, celular: persona.celular, correo: persona.correo || null };
        try {
            const usuario = await crearUsuarioEspecial(persona);
            const transaccion = await crearTransaccionEspecial({ usuarioId: usuario.id, partidoId: partido.id, valorBono, intentos });
            const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${transaccion.token_acceso}`;
            resultado.transaccion_id = transaccion.id;
            resultado.token_acceso = transaccion.token_acceso;
            resultado.link = linkPolla;

            if (usuario.correo) {
                try {
                    const bonoBuffer = await generarImagenBono({
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        tokenAcceso: transaccion.token_acceso,
                        esEspecial: true,
                    });
                    await enviarCorreoBono({
                        destinatario: usuario.correo,
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        intentos: transaccion.intentos_totales,
                        tokenAcceso: transaccion.token_acceso,
                        bonoBuffer,
                        esEspecial: true,
                    });
                    resultado.correoEnviado = true;
                } catch (err) {
                    resultado.correoEnviado = false;
                    resultado.errorCorreo = err.message;
                }
            }

            try {
                const mensaje = `🎖️ ¡Hola ${usuario.nombre}! Ya tienes tu BONO ESPECIAL de creador de contenido.\n\n`
                    + `Tienes $${transaccion.saldo_bono.toLocaleString('es-CO')} de bono real en La Retoucherie de Manuela (válido para redimir en tienda) y ${transaccion.intentos_totales} intentos para predecir marcadores y probar la app.\n\n`
                    + `Ingresa aquí: ${linkPolla}`;

                const { subscriberId } = await enviarBonoManyChat({
                    celular: usuario.celular,
                    mensaje,
                    imagenUrl: `${process.env.BACKEND_URL}/api/polla/bono/${transaccion.token_acceso}`,
                    subscriberId: usuario.manychat_subscriber_id,
                });

                if (subscriberId && !usuario.manychat_subscriber_id) {
                    await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), usuario.id]);
                }

                resultado.whatsappEnviado = true;
            } catch (err) {
                resultado.whatsappEnviado = false;
                resultado.errorWhatsapp = err.response?.data || err.message;
            }
        } catch (err) {
            resultado.error = err.message;
        }

        resultados.push(resultado);
    }

    return {
        partido: { id: partido.id, equipo_local: partido.equipo_local, equipo_visitante: partido.equipo_visitante },
        resultados,
    };
}

async function listarBonosEspeciales() {
    const { rows } = await pool.query(
        `SELECT t.id AS transaccion_id, t.token_acceso, t.saldo_bono, t.intentos_totales, t.intentos_usados,
                t.fecha_creacion, u.id AS usuario_id, u.nombre, u.celular, u.correo
         FROM transacciones t
         JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.es_especial = TRUE
         ORDER BY t.fecha_creacion DESC`
    );
    return rows;
}

/**
 * Envía por WhatsApp el "kit de difusión" para que el creador de contenido
 * sepa qué decirle a sus seguidores: pasos para participar, beneficios de
 * La Retoucherie y su link personal de referido (el mismo token_acceso del
 * Bono Especial, reutilizando el sistema de referidos ya existente).
 */
async function enviarInvitacionDifusion(transaccionId) {
    const { rows } = await pool.query(
        `SELECT t.token_acceso, t.saldo_bono, u.nombre, u.celular, u.manychat_subscriber_id
         FROM transacciones t
         JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.id = $1 AND t.es_especial = TRUE`,
        [transaccionId]
    );
    if (rows.length === 0) {
        throw new Error('Bono Especial no encontrado');
    }
    const { token_acceso, saldo_bono, nombre, celular, manychat_subscriber_id } = rows[0];
    const linkReferido = `${process.env.FRONTEND_URL}/?ref=${token_acceso}`;

    const mensaje = `🇨🇴⚽ ¡Hola ${nombre}! Aquí tienes todo para contarle a tus seguidores cómo participar en la Polla Mundialista de La Retoucherie de Manuela:\n\n`
        + `1️⃣ Entran a ${linkReferido}\n`
        + `2️⃣ Predicen el marcador del próximo partido de Colombia\n`
        + `3️⃣ Compran su Bono Digital (desde $10.000): incluye crédito real en La Retoucherie para arreglos y transformaciones de ropa + cupos para predecir\n`
        + `4️⃣ ¡Pueden ganar hasta $1.000.000 en el Bono Colombia si aciertan el marcador exacto!\n\n`
        + `✂️ La Retoucherie de Manuela arregla y transforma ropa a la medida (dobladillos, ajustes, transformaciones) en Barranquilla y Cartagena.\n\n`
        + `🎁 Como creador de contenido ya tienes tu Bono Especial de $${saldo_bono.toLocaleString('es-CO')} en arreglos de ropa, ¡totalmente real y listo para usar en tienda!\n\n`
        + `👉 Tu link personal (para que rastreemos a quienes invites): ${linkReferido}`;

    const { subscriberId } = await enviarMensajeManyChat({ celular, mensaje, subscriberId: manychat_subscriber_id });

    if (subscriberId && !manychat_subscriber_id) {
        await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = (SELECT usuario_id FROM transacciones WHERE id = $2)', [String(subscriberId), transaccionId]);
    }

    return { enviado: true };
}

module.exports = {
    crearBonosEspeciales,
    listarBonosEspeciales,
    enviarInvitacionDifusion,
    VALOR_BONO_ESPECIAL_DEFAULT,
    INTENTOS_ESPECIAL_DEFAULT,
};
