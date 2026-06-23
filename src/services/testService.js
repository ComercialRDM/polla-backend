const pool = require('../db');
const { generarImagenBono } = require('./bonoService');
const { enviarCorreoBono } = require('./emailService');
const { enviarBonoManyChat } = require('./manychatService');

const VALOR_PAGADO_TEST = 50000;
const SALDO_BONO_TEST = 50000;
const INTENTOS_TEST = 1;

// Normaliza al formato local de 10 dígitos (sin "+57"/"57"), igual que el
// resto de la app guarda el celular, para que "+573012786234" y "3012786234"
// se reconozcan como el mismo usuario en vez de crear cuentas duplicadas.
function normalizarCelular(celular) {
    const limpio = String(celular || '').replace(/\D/g, '');
    if (limpio.length === 12 && limpio.startsWith('57')) {
        return limpio.slice(2);
    }
    return limpio;
}

async function buscarPartido(equipoA, equipoB) {
    const { rows } = await pool.query(
        `SELECT * FROM partidos
         WHERE (equipo_local ILIKE $1 AND equipo_visitante ILIKE $2)
            OR (equipo_local ILIKE $2 AND equipo_visitante ILIKE $1)
         ORDER BY fecha_hora_inicio DESC
         LIMIT 1`,
        [`%${equipoA}%`, `%${equipoB}%`]
    );
    return rows[0] || null;
}

async function crearUsuarioTest({ nombre, celular, correo }) {
    const celularNorm = normalizarCelular(celular);
    const correoNorm = correo ? correo.trim() : null;

    const { rows: existentes } = await pool.query(
        'SELECT * FROM usuarios WHERE celular = $1 OR ($2::text IS NOT NULL AND correo = $2)',
        [celularNorm, correoNorm]
    );
    if (existentes.length > 0) return existentes[0];

    const { rows } = await pool.query(
        'INSERT INTO usuarios (nombre, correo, celular) VALUES ($1, $2, $3) RETURNING *',
        [nombre, correoNorm, celularNorm]
    );
    return rows[0];
}

async function crearTransaccionTest({ usuarioId, partidoId }) {
    const { rows } = await pool.query(
        `INSERT INTO transacciones (usuario_id, partido_id, metodo, valor_pagado, saldo_bono, intentos_totales, estado_pago, es_test)
         VALUES ($1, $2, 'TEST', $3, $4, $5, 'APROBADO', TRUE)
         RETURNING *`,
        [usuarioId, partidoId, VALOR_PAGADO_TEST, SALDO_BONO_TEST, INTENTOS_TEST]
    );
    return rows[0];
}

/**
 * Crea cuentas + transacciones de PRUEBA (es_test = TRUE, saldo virtual, sin
 * cobro real) para un grupo de amigos, con 1 cupo de pronóstico cada uno para
 * el partido indicado. Envía el bono por correo y WhatsApp marcado como
 * "PRUEBA". No afecta reportes ni rankings públicos (se filtran por es_test).
 * @param {{ amigos: Array<{nombre: string, celular: string, correo?: string}>, equipoA: string, equipoB: string }} datos
 */
async function crearTransaccionesPrueba({ amigos, equipoA, equipoB }) {
    const partido = await buscarPartido(equipoA, equipoB);
    if (!partido) {
        throw new Error(`No se encontró ningún partido entre "${equipoA}" y "${equipoB}"`);
    }

    const resultados = [];

    for (const amigo of amigos) {
        const resultado = { nombre: amigo.nombre, celular: amigo.celular, correo: amigo.correo || null };
        try {
            const usuario = await crearUsuarioTest(amigo);
            const transaccion = await crearTransaccionTest({ usuarioId: usuario.id, partidoId: partido.id });
            const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${transaccion.token_acceso}`;
            resultado.link = linkPolla;

            if (usuario.correo) {
                try {
                    const bonoBuffer = await generarImagenBono({
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        tokenAcceso: transaccion.token_acceso,
                        esTest: true,
                    });
                    await enviarCorreoBono({
                        destinatario: usuario.correo,
                        nombre: usuario.nombre,
                        saldoBono: transaccion.saldo_bono,
                        intentos: transaccion.intentos_totales,
                        tokenAcceso: transaccion.token_acceso,
                        bonoBuffer,
                        esTest: true,
                    });
                    resultado.correoEnviado = true;
                } catch (err) {
                    resultado.correoEnviado = false;
                    resultado.errorCorreo = err.message;
                }
            }

            try {
                const mensaje = `🧪 PRUEBA — ${usuario.nombre}, este es un bono de PRUEBA (no es dinero real, no se puede redimir).\n\n`
                    + `Tienes $${transaccion.saldo_bono.toLocaleString('es-CO')} de saldo de prueba y ${transaccion.intentos_totales} intento(s) para predecir el marcador de ${partido.equipo_local} vs ${partido.equipo_visitante}.\n\n`
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

/**
 * Elimina todas las transacciones y pronósticos de prueba (es_test = TRUE).
 * No elimina los usuarios de prueba (pueden quedar para futuras pruebas).
 */
async function limpiarTransaccionesPrueba() {
    const { rows: transacciones } = await pool.query('SELECT id FROM transacciones WHERE es_test = TRUE');
    const ids = transacciones.map((t) => t.id);

    if (ids.length === 0) {
        return { transaccionesEliminadas: 0, pronosticosEliminados: 0 };
    }

    const { rowCount: pronosticosEliminados } = await pool.query(
        'DELETE FROM pronosticos WHERE transaccion_id = ANY($1::int[])',
        [ids]
    );
    const { rowCount: transaccionesEliminadas } = await pool.query(
        'DELETE FROM transacciones WHERE id = ANY($1::int[])',
        [ids]
    );

    return { transaccionesEliminadas, pronosticosEliminados };
}

module.exports = { crearTransaccionesPrueba, limpiarTransaccionesPrueba };
