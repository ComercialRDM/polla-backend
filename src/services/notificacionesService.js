const pool = require('../db');
const { enviarMensajeManyChat } = require('./manychatService');

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
                `SELECT DISTINCT u.nombre, u.celular
                 FROM transacciones t
                 JOIN usuarios u ON u.id = t.usuario_id
                 WHERE t.partido_id = $1 AND t.estado_pago = 'APROBADO'`,
                [partido.id]
            );

            const mensaje = `⚽ ¡Ya comenzó ${partido.equipo_local} vs ${partido.equipo_visitante}! `
                + `Sigue el marcador y revisa tu pronóstico en la Polla Mundialista de La Retoucherie. ¡Mucha suerte! 🇨🇴`;

            for (const participante of participantes) {
                try {
                    await enviarMensajeManyChat({ celular: participante.celular, mensaje });
                } catch (err) {
                    console.error(`Error notificando inicio de partido a ${participante.celular}:`, err.response?.data || err.message);
                }
            }

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

module.exports = { iniciarMonitorPartidos };
