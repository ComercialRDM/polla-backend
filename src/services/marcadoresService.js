const pool = require('../db');
const { obtenerPartidosMundial } = require('./footballDataService');
const { coincideEquipo } = require('./equiposMap');
const { calcularRanking } = require('./rankingService');
const { notificarGanadoresDelGol } = require('./notificacionesService');

// football-data.org (plan gratuito) permite 10 solicitudes por minuto.
// 20s = 3 solicitudes/minuto, deja margen amplio para no llegar al límite.
const INTERVALO_MS = 20 * 1000;

/**
 * Consulta football-data.org y actualiza el marcador y estado de los
 * partidos activos cuya hora de inicio ya llegó.
 */
async function actualizarMarcadores() {
    const { rows: partidos } = await pool.query(
        `SELECT * FROM partidos WHERE estado = 'activo' AND fecha_hora_inicio <= now()`
    );
    if (partidos.length === 0) return;

    const partidosApi = await obtenerPartidosMundial();

    for (const partido of partidos) {
        // El orden local/visitante de nuestra BD puede no coincidir con el
        // orden home/away de football-data.org, así que se busca en ambos sentidos.
        const match = partidosApi.find((m) => {
            const mismoOrden = coincideEquipo(partido.equipo_local, m.homeTeam?.name)
                && coincideEquipo(partido.equipo_visitante, m.awayTeam?.name);
            const ordenInvertido = coincideEquipo(partido.equipo_visitante, m.homeTeam?.name)
                && coincideEquipo(partido.equipo_local, m.awayTeam?.name);
            return mismoOrden || ordenInvertido;
        });

        if (!match) {
            console.warn(`Sin datos en football-data.org para: ${partido.equipo_local} vs ${partido.equipo_visitante}`);
            continue;
        }

        const localEsHome = coincideEquipo(partido.equipo_local, match.homeTeam?.name);
        const golesHome = match.score?.fullTime?.home ?? match.score?.halfTime?.home ?? 0;
        const golesAway = match.score?.fullTime?.away ?? match.score?.halfTime?.away ?? 0;
        const golesLocal = localEsHome ? golesHome : golesAway;
        const golesVisitante = localEsHome ? golesAway : golesHome;
        const finalizado = match.status === 'FINISHED' || match.status === 'AWARDED';
        const nuevoEstado = finalizado ? 'cerrado' : 'activo';

        const marcadorCambio = golesLocal !== partido.goles_local || golesVisitante !== partido.goles_visitante;
        const estadoCambio = nuevoEstado !== partido.estado;

        if (!marcadorCambio && !estadoCambio) continue;

        await pool.query(
            'UPDATE partidos SET goles_local = $1, goles_visitante = $2, estado = $3 WHERE id = $4',
            [golesLocal, golesVisitante, nuevoEstado, partido.id]
        );
        console.log(`Marcador actualizado: ${partido.equipo_local} ${golesLocal} - ${golesVisitante} ${partido.equipo_visitante} (${nuevoEstado})`);

        if (marcadorCambio) {
            const ranking = await calcularRanking(partido.id);
            notificarGanadoresDelGol({ ganadores: ranking.ganadores, golesLocalNuevo: golesLocal, golesVisitanteNuevo: golesVisitante })
                .catch((err) => console.error('Error notificando ganadores del gol:', err.message));
        }
    }
}

/**
 * Inicia el monitoreo periódico de marcadores en vivo.
 */
function iniciarMonitorMarcadores() {
    if (!process.env.FOOTBALL_DATA_TOKEN) {
        console.warn('FOOTBALL_DATA_TOKEN no configurado, los marcadores no se actualizarán automáticamente');
        return;
    }

    setInterval(() => {
        actualizarMarcadores().catch((err) => console.error('Error en actualizarMarcadores:', err.response?.status, err.message));
    }, INTERVALO_MS);
}

module.exports = { iniciarMonitorMarcadores };
