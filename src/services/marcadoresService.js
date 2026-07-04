const pool = require('../db');
const { obtenerPartidosMundial } = require('./footballDataService');
const { coincideEquipo } = require('./equiposMap');
const { enviarCorreosResultadoPartido } = require('./notificacionesService');
const { invalidate } = require('../utils/cache');
const { notificar } = require('../utils/sse');
const { verificarResultadoMultiFuente, registrarVerificacion } = require('./verificacionResultados');

// football-data.org (plan gratuito) permite 10 solicitudes por minuto.
// 30s = 2 solicitudes/minuto, más estable y menor tasa de errores de red.
const INTERVALO_MS = 30 * 1000;

// Número de polls consecutivos con el mismo marcador FINISHED antes de cerrar.
// 2 polls × 30s = 60 segundos mínimo de estabilidad antes del cierre definitivo.
const MIN_POLLS_ESTABLES = 2;

// Tracker en memoria: partido_id -> { local, visitante, polls }
// Se resetea si el marcador cambia o si el proceso se reinicia.
const scoreEstable = new Map();

// Cierra partidos cuya hora de inicio fue hace más de 3 horas y siguen 'activo'
// (cubre el caso en que el nombre del equipo no coincide con football-data.org).
async function cerrarPartidosVencidos() {
    const { rowCount } = await pool.query(
        `UPDATE partidos SET estado = 'cerrado'
         WHERE estado = 'activo' AND fecha_hora_inicio + interval '3 hours' <= now()`
    );
    if (rowCount > 0) {
        invalidate('partidos:lista');
        console.warn(`Auto-cierre de seguridad: ${rowCount} partido(s) cerrado(s) por vencimiento. Revisar scores en el admin.`);
    }
}

async function actualizarMarcadores() {
    const { rows: partidos } = await pool.query(
        `SELECT * FROM partidos WHERE estado = 'activo' AND fecha_hora_inicio <= now()`
    );

    if (partidos.length === 0) {
        await cerrarPartidosVencidos();
        return;
    }

    const partidosApi = await obtenerPartidosMundial();

    for (const partido of partidos) {
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

        const marcadorCambio = golesLocal !== partido.goles_local || golesVisitante !== partido.goles_visitante;

        if (finalizado) {
            // ── Estabilidad: exigir el mismo marcador FINISHED por MIN_POLLS_ESTABLES polls ──
            const key = partido.id;
            const prev = scoreEstable.get(key);
            const mismoMarcador = prev && prev.local === golesLocal && prev.visitante === golesVisitante;

            if (mismoMarcador) {
                prev.polls++;
            } else {
                // Primer poll o marcador cambió — reiniciar contador
                scoreEstable.set(key, { local: golesLocal, visitante: golesVisitante, polls: 1 });
                // Actualizar marcador en DB aunque aún no sea el momento de cerrar
                if (marcadorCambio) {
                    await pool.query(
                        'UPDATE partidos SET goles_local = $1, goles_visitante = $2 WHERE id = $3',
                        [golesLocal, golesVisitante, partido.id]
                    );
                    invalidate('partidos:lista');
                    invalidate(`ranking:${partido.id}`);
                    notificar(partido.id);
                    console.log(`Marcador actualizado (pendiente cierre): ${partido.equipo_local} ${golesLocal}-${golesVisitante} ${partido.equipo_visitante} [poll 1/${MIN_POLLS_ESTABLES}]`);
                }
                continue; // Esperar más polls para confirmar
            }

            if (prev.polls < MIN_POLLS_ESTABLES) {
                console.log(`Marcador estable [poll ${prev.polls}/${MIN_POLLS_ESTABLES}]: ${partido.equipo_local} ${golesLocal}-${golesVisitante} ${partido.equipo_visitante}`);
                continue; // Aún no es suficiente — esperar
            }

            // ── Verificación multi-fuente (TheSportsDB + ESPN) ──
            const verificacion = await verificarResultadoMultiFuente(partido, golesLocal, golesVisitante);

            if (verificacion.alertar) {
                // Al menos una fuente reporta un marcador diferente — NO cerrar automáticamente
                console.error(
                    `[VERIFICACION_ALERTA] ${partido.equipo_local} vs ${partido.equipo_visitante}: ` +
                    `football-data.org dice ${golesLocal}-${golesVisitante} pero otra fuente discrepa. ` +
                    `Fuentes: ${JSON.stringify(verificacion.fuentes)}. ` +
                    `Revisar en panel admin y corregir manualmente con /api/admin/partidos/${partido.id}/recorregir`
                );
                await registrarVerificacion({
                    partido_id: partido.id,
                    goles_local: golesLocal,
                    goles_visitante: golesVisitante,
                    fuentes: verificacion.fuentes,
                    consenso: false,
                    alertar: true,
                    accion: 'auto_discrepancia',
                });
                // Limpiar tracker para que el próximo ciclo reintente la verificación
                scoreEstable.delete(key);
                continue;
            }

            // ── Consenso logrado — cerrar el partido ──
            scoreEstable.delete(key);

            await pool.query(
                'UPDATE partidos SET goles_local = $1, goles_visitante = $2, estado = $3 WHERE id = $4',
                [golesLocal, golesVisitante, 'cerrado', partido.id]
            );
            console.log(`Partido cerrado (consenso ${verificacion.fuentes.length} fuente(s)): ${partido.equipo_local} ${golesLocal}-${golesVisitante} ${partido.equipo_visitante}`);

            await registrarVerificacion({
                partido_id: partido.id,
                goles_local: golesLocal,
                goles_visitante: golesVisitante,
                fuentes: verificacion.fuentes,
                consenso: true,
                alertar: false,
                accion: 'auto_cerrado',
            });

            invalidate('partidos:lista');
            invalidate(`ranking:${partido.id}`);
            invalidate(`resumen:${partido.id}`);
            notificar(partido.id);

            enviarCorreosResultadoPartido({
                id: partido.id,
                equipo_local: partido.equipo_local,
                equipo_visitante: partido.equipo_visitante,
                fase: partido.fase,
                goles_local: golesLocal,
                goles_visitante: golesVisitante,
            }).catch((err) => console.error('Error enviando correos de resultado:', err.message));

            continue;
        }

        // Partido todavía en curso — actualizar marcador si cambió
        if (!marcadorCambio) continue;

        await pool.query(
            'UPDATE partidos SET goles_local = $1, goles_visitante = $2, estado = $3 WHERE id = $4',
            [golesLocal, golesVisitante, 'activo', partido.id]
        );
        console.log(`Marcador en vivo: ${partido.equipo_local} ${golesLocal}-${golesVisitante} ${partido.equipo_visitante} (activo)`);

        invalidate('partidos:lista');
        invalidate(`ranking:${partido.id}`);
        invalidate(`resumen:${partido.id}`);
        notificar(partido.id);
    }

    // Safety fallback: cerrar cualquier partido 'activo' > 3h después de su inicio
    await cerrarPartidosVencidos();
}

const PAUSA_TRAS_429_MS = 60 * 1000;
let pausadoHasta = 0;

function iniciarMonitorMarcadores() {
    if (!process.env.FOOTBALL_DATA_TOKEN) {
        console.warn('FOOTBALL_DATA_TOKEN no configurado, los marcadores no se actualizarán automáticamente');
        return;
    }

    setInterval(() => {
        if (Date.now() < pausadoHasta) return;

        actualizarMarcadores().catch((err) => {
            if (err.response?.status === 429) {
                pausadoHasta = Date.now() + PAUSA_TRAS_429_MS;
                console.warn(`football-data.org respondió 429, pausando monitoreo ${PAUSA_TRAS_429_MS / 1000}s`);
                return;
            }
            const esErrorRed = err.code === 'ECONNRESET' || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
            if (esErrorRed) {
                console.warn(`actualizarMarcadores: error de red transitorio (${err.code}), reintentará en ${INTERVALO_MS / 1000}s`);
                return;
            }
            if (err.response?.status >= 500) {
                console.warn(`actualizarMarcadores: error transitorio HTTP ${err.response.status} de football-data.org, reintentará`);
                return;
            }
            console.error('Error en actualizarMarcadores:', err.response?.status ?? err.code, err.message);
        });
    }, INTERVALO_MS);
}

module.exports = { iniciarMonitorMarcadores };
