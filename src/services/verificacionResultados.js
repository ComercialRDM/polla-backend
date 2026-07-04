const axios = require('axios');
const pool = require('../db');

// Fuente 2: TheSportsDB (gratuita, sin auth)
// Busca un evento por nombres de equipo y filtra por temporada 2026
async function verificarConTheSportsDB(equipoLocal, equipoVisitante, fechaISO) {
    try {
        const query = `${equipoLocal} vs ${equipoVisitante}`;
        const { data } = await axios.get(
            'https://www.thesportsdb.com/api/v1/json/3/searchevents.php',
            { params: { e: query, s: '2026' }, timeout: 12000 }
        );
        if (!data?.event?.length) return null;

        const fecha = new Date(fechaISO);
        const evento = data.event.find((e) => {
            if (!e.dateEvent) return false;
            const diff = Math.abs(new Date(e.dateEvent) - fecha);
            return diff < 2 * 24 * 3600 * 1000; // mismo dia ±1
        });
        if (!evento) return null;
        if (evento.strStatus !== 'Match Finished' && evento.intHomeScore === null) return null;

        const local = parseInt(evento.intHomeScore, 10);
        const visitante = parseInt(evento.intAwayScore, 10);
        if (isNaN(local) || isNaN(visitante)) return null;

        return { fuente: 'TheSportsDB', goles_local: local, goles_visitante: visitante };
    } catch (err) {
        console.warn('[verificacion] TheSportsDB error:', err.message);
        return null;
    }
}

// Fuente 3: ESPN API pública (sin auth)
// Usa el scoreboard de la fecha del partido para encontrar el marcador
async function verificarConESPN(equipoLocal, equipoVisitante, fechaISO) {
    try {
        const fecha = new Date(fechaISO);
        const yyyymmdd = fecha.toISOString().slice(0, 10).replace(/-/g, '');
        const { data } = await axios.get(
            'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
            { params: { dates: yyyymmdd }, timeout: 12000 }
        );
        const eventos = data?.events ?? [];

        const localNorm = equipoLocal.toLowerCase();
        const visitanteNorm = equipoVisitante.toLowerCase();

        const evento = eventos.find((e) => {
            const comps = e.competitions?.[0]?.competitors ?? [];
            if (comps.length < 2) return false;
            const nombres = comps.map((c) => c.team?.displayName?.toLowerCase() ?? '');
            const encuentraLocal = nombres.some((n) => n.includes(localNorm) || localNorm.includes(n.split(' ')[0]));
            const encuentraVisitante = nombres.some((n) => n.includes(visitanteNorm) || visitanteNorm.includes(n.split(' ')[0]));
            return encuentraLocal && encuentraVisitante;
        });
        if (!evento) return null;

        const finalizado = evento.status?.type?.completed === true;
        if (!finalizado) return null;

        const comps = evento.competitions[0].competitors;
        const homeComp = comps.find((c) => c.homeAway === 'home');
        const awayComp = comps.find((c) => c.homeAway === 'away');
        if (!homeComp || !awayComp) return null;

        const homeNombre = homeComp.team?.displayName?.toLowerCase() ?? '';
        const localEsHome = homeNombre.includes(localNorm) || localNorm.includes(homeNombre.split(' ')[0]);

        const scoreHome = parseInt(homeComp.score, 10);
        const scoreAway = parseInt(awayComp.score, 10);
        if (isNaN(scoreHome) || isNaN(scoreAway)) return null;

        return {
            fuente: 'ESPN',
            goles_local: localEsHome ? scoreHome : scoreAway,
            goles_visitante: localEsHome ? scoreAway : scoreHome,
        };
    } catch (err) {
        console.warn('[verificacion] ESPN error:', err.message);
        return null;
    }
}

/**
 * Verifica un resultado contra TheSportsDB y ESPN.
 * Retorna { consenso, fuentes, alertar } donde:
 *   consenso  true  = todas las fuentes disponibles coinciden (o ninguna secundaria respondió)
 *   alertar   true  = al menos una fuente secundaria respondió con un score DIFERENTE → NO cerrar automáticamente
 */
async function verificarResultadoMultiFuente(partido, golesLocal, golesVisitante) {
    const fuente1 = { fuente: 'football-data.org', goles_local: golesLocal, goles_visitante: golesVisitante };
    const [f2, f3] = await Promise.all([
        verificarConTheSportsDB(partido.equipo_local, partido.equipo_visitante, partido.fecha_hora_inicio),
        verificarConESPN(partido.equipo_local, partido.equipo_visitante, partido.fecha_hora_inicio),
    ]);

    const fuentesDisponibles = [fuente1];
    if (f2) fuentesDisponibles.push(f2);
    if (f3) fuentesDisponibles.push(f3);

    const discrepantes = fuentesDisponibles.filter(
        (f) => f.goles_local !== golesLocal || f.goles_visitante !== golesVisitante
    );

    const alertar = discrepantes.length > 0;

    return {
        consenso: !alertar,
        alertar,
        fuentes: fuentesDisponibles,
        fuentesParciales: { f1: fuente1, f2: f2 ?? null, f3: f3 ?? null },
    };
}

// Asegura que la tabla de auditoría existe (se llama al inicio del servidor)
async function crearTablaAuditoria() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS resultado_verificacion (
            id          SERIAL PRIMARY KEY,
            partido_id  INT,
            goles_local INT,
            goles_visitante INT,
            fuentes     JSONB,
            consenso    BOOLEAN,
            alertar     BOOLEAN DEFAULT FALSE,
            accion      TEXT,
            admin_id    INT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_rv_partido ON resultado_verificacion(partido_id)`
    );
}

// Registra una verificación/corrección en la tabla de auditoría
async function registrarVerificacion({ partido_id, goles_local, goles_visitante, fuentes, consenso, alertar = false, accion, admin_id = null }) {
    try {
        await pool.query(
            `INSERT INTO resultado_verificacion
             (partido_id, goles_local, goles_visitante, fuentes, consenso, alertar, accion, admin_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [partido_id, goles_local, goles_visitante, JSON.stringify(fuentes), consenso, alertar, accion, admin_id]
        );
    } catch (err) {
        console.error('[verificacion] Error registrando auditoría:', err.message);
    }
}

module.exports = {
    verificarResultadoMultiFuente,
    registrarVerificacion,
    crearTablaAuditoria,
};
