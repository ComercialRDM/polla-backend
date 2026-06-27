const pool = require('../db');
const { enviarMensajeManyChat } = require('./manychatService');
const { ejecutarConConcurrencia } = require('../utils/concurrencia');

// Tope de envíos simultáneos a la API de ManyChat: lo suficientemente alto para
// no tardar minutos en avisar a miles de participantes (antes era secuencial,
// uno por uno), pero acotado para no disparar el propio rate limit de ManyChat.
const CONCURRENCIA_MANYCHAT = 20;

const INTERVALO_MS = 60 * 1000;

/**
 * Revisa los partidos activos que ya alcanzaron su hora de inicio y, la primera vez,
 * avisa por WhatsApp a todos los participantes con bono aprobado para ese partido.
 */
async function revisarInicioPartidos() {
    const { rows: partidos } = await pool.query(
        `SELECT * FROM partidos
         WHERE estado = 'activo' AND notificado_inicio = FALSE AND fecha_hora_inicio <= now()`
    );

    for (const partido of partidos) {
        try {
            const { rows: participantes } = await pool.query(
                `SELECT DISTINCT u.id, u.nombre, u.celular, u.manychat_subscriber_id
                 FROM transacciones t
                 JOIN usuarios u ON u.id = t.usuario_id
                 WHERE t.partido_id = $1 AND t.estado_pago = 'APROBADO'`,
                [partido.id]
            );

            const mensaje = `⚽ ¡Ya comenzó ${partido.equipo_local} vs ${partido.equipo_visitante}! `
                + `Sigue el marcador y revisa tu pronóstico en la Polla Mundialista de La Retoucherie. ¡Mucha suerte! 🇨🇴`;

            await ejecutarConConcurrencia(participantes, async (participante) => {
                try {
                    const { subscriberId } = await enviarMensajeManyChat({
                        celular: participante.celular,
                        mensaje,
                        subscriberId: participante.manychat_subscriber_id,
                    });
                    if (subscriberId && !participante.manychat_subscriber_id) {
                        await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), participante.id]);
                    }
                } catch (err) {
                    console.error(`Error notificando inicio de partido a ${participante.celular}:`, err.response?.data || err.message);
                }
            }, CONCURRENCIA_MANYCHAT);

            await pool.query('UPDATE partidos SET notificado_inicio = TRUE WHERE id = $1', [partido.id]);
        } catch (err) {
            console.error(`Error procesando notificación de inicio para partido ${partido.id}:`, err.message);
        }
    }
}

/**
 * Inicia la revisión periódica de partidos que están por comenzar.
 */
function iniciarMonitorPartidos() {
    setInterval(() => {
        revisarInicioPartidos().catch((err) => console.error('Error en revisarInicioPartidos:', err.message));
    }, INTERVALO_MS);
}

/**
 * Envía por ManyChat la notificación de gol a los usuarios que están acertando el marcador actual.
 */
async function notificarGanadoresDelGol({ ganadores, golesLocalNuevo, golesVisitanteNuevo }) {
    const mensaje = `⚽ ¡GOL! El partido va ${golesLocalNuevo}-${golesVisitanteNuevo}. ¡Estás ganando en la Polla Retoucherie! Mantén los dedos cruzados 🤞🇨🇴`;

    await ejecutarConConcurrencia(ganadores, async (ganador) => {
        try {
            const { subscriberId } = await enviarMensajeManyChat({
                celular: ganador.celular,
                mensaje,
                subscriberId: ganador.manychat_subscriber_id,
            });
            if (subscriberId && !ganador.manychat_subscriber_id) {
                await pool.query('UPDATE usuarios SET manychat_subscriber_id = $1 WHERE id = $2', [String(subscriberId), ganador.usuario_id]);
            }
        } catch (err) {
            console.error(`Error enviando notificación ManyChat a ${ganador.celular}:`, err.message);
        }
    }, CONCURRENCIA_MANYCHAT);
}

module.exports = { iniciarMonitorPartidos, notificarGanadoresDelGol };
