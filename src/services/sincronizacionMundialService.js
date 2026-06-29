const pool = require('../db');
const { obtenerPartidosMundial } = require('./footballDataService');
const { nombreEspanol } = require('./equiposMap');
const { invalidate } = require('../utils/cache');

// football-data.org (plan gratuito) permite 10 solicitudes por minuto. El
// calendario/llaves del Mundial casi nunca cambia, así que no hace falta
// revisarlo tan seguido como el marcador en vivo (marcadoresService.js, 30s).
const INTERVALO_MS = 30 * 60 * 1000; // 30 minutos

// Mapa de fase de football-data.org -> fase local (ver CHECK de partidos.fase
// en server.js). THIRD_PLACE no tiene fase propia en el sistema; por decisión
// del negocio se puntúa igual que una semifinal (600/300 puntos).
const FASE_POR_STAGE = {
    GROUP_STAGE: 'grupos',
    LAST_32: 'dieciseisavos',
    LAST_16: 'octavos',
    QUARTER_FINALS: 'cuartos',
    SEMI_FINALS: 'semifinal',
    THIRD_PLACE: 'semifinal',
    FINAL: 'final',
};

/**
 * Trae el calendario oficial del Mundial desde football-data.org y crea/actualiza
 * los partidos en nuestra tabla `partidos` por su external_id. Solo toca
 * equipo_local, equipo_visitante, fecha_hora_inicio y fase — nunca estado ni
 * marcador, eso lo maneja exclusivamente marcadoresService.js para no pisar
 * un cierre manual del admin ni un partido ya en curso.
 */
async function sincronizarPartidosMundial() {
    const partidosApi = await obtenerPartidosMundial();

    let creados = 0;
    let actualizados = 0;
    let omitidos = 0;

    for (const m of partidosApi) {
        const fase = FASE_POR_STAGE[m.stage];
        const tieneEquipos = m.homeTeam?.name && m.awayTeam?.name;

        if (!fase || !tieneEquipos) {
            omitidos++;
            continue;
        }

        const equipoLocal = nombreEspanol(m.homeTeam.name);
        const equipoVisitante = nombreEspanol(m.awayTeam.name);

        const { rows } = await pool.query(
            `INSERT INTO partidos (equipo_local, equipo_visitante, fecha_hora_inicio, fase, external_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (external_id) DO UPDATE SET
                equipo_local = EXCLUDED.equipo_local,
                equipo_visitante = EXCLUDED.equipo_visitante,
                fecha_hora_inicio = EXCLUDED.fecha_hora_inicio,
                fase = EXCLUDED.fase
             RETURNING id, (xmax = 0) AS es_nuevo`,
            [equipoLocal, equipoVisitante, m.utcDate, fase, m.id]
        );

        if (rows[0].es_nuevo) creados++;
        else actualizados++;
    }

    if (creados > 0) invalidate('partidos:lista');

    console.log(`sincronizarPartidosMundial: ${creados} creados, ${actualizados} actualizados, ${omitidos} omitidos (sin equipos confirmados o fase sin mapeo)`);
    return { creados, actualizados, omitidos };
}

function iniciarSincronizacionMundial() {
    if (!process.env.FOOTBALL_DATA_TOKEN) {
        console.warn('FOOTBALL_DATA_TOKEN no configurado, el calendario del Mundial no se sincronizará automáticamente');
        return;
    }

    sincronizarPartidosMundial().catch((err) => {
        console.error('Error en la sincronización inicial del calendario del Mundial:', err.response?.status ?? err.code, err.message);
    });

    setInterval(() => {
        sincronizarPartidosMundial().catch((err) => {
            console.error('Error en sincronizarPartidosMundial:', err.response?.status ?? err.code, err.message);
        });
    }, INTERVALO_MS);
}

module.exports = { sincronizarPartidosMundial, iniciarSincronizacionMundial };
