const axios = require('axios');

// Tolerancia en minutos: dos fuentes "coinciden" si difieren menos de este valor.
// Se usa 5 minutos por si hay diferencias menores de redondeo entre APIs.
const TOLERANCIA_MINUTOS = 5;

function diffMinutos(utcA, utcB) {
    return Math.abs(new Date(utcA).getTime() - new Date(utcB).getTime()) / 60000;
}

// Convierte cualquier timestamp a ISO UTC string para comparación uniforme.
function toUTC(val) {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

// Devuelve la hora Colombia (UTC-5) de un timestamp UTC como string legible.
function horaColumbia(utcISO) {
    if (!utcISO) return 'N/A';
    return new Date(utcISO).toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

// ── Fuente 2: TheSportsDB ──────────────────────────────────────────────────────
// Devuelve el utcDate confirmado por TheSportsDB o null si no lo tiene.
async function verificarCalendarioTheSportsDB(equipoLocal, equipoVisitante, utcDateEsperado) {
    try {
        const query = `${equipoLocal} vs ${equipoVisitante}`;
        const { data } = await axios.get(
            'https://www.thesportsdb.com/api/v1/json/3/searchevents.php',
            { params: { e: query, s: '2026' }, timeout: 12000 }
        );
        if (!data?.event?.length) return null;

        const fechaEsperada = new Date(utcDateEsperado);
        const evento = data.event.find((e) => {
            if (!e.dateEvent) return false;
            const diff = Math.abs(new Date(e.dateEvent) - fechaEsperada);
            return diff < 3 * 24 * 3600 * 1000; // ±3 días (para partidos de eliminatoria con fechas flexibles)
        });
        if (!evento) return null;

        // Si strTime es 00:00:00 y no hay strTimestamp confiable, la hora no está confirmada
        if (evento.strTime === '00:00:00' && !evento.strTimestamp) return null;

        // Reconstruir UTC desde dateEvent + strTime (asumiendo UTC)
        const utcStr = evento.strTimestamp
            ? toUTC(evento.strTimestamp)
            : toUTC(`${evento.dateEvent}T${evento.strTime}Z`);

        if (!utcStr) return null;

        return {
            fuente: 'TheSportsDB',
            utcDate: utcStr,
            horaColumbia: horaColumbia(utcStr),
            equipoLocal: evento.strHomeTeam,
            equipoVisitante: evento.strAwayTeam,
        };
    } catch (err) {
        console.warn('[verif-calendario] TheSportsDB error:', err.message);
        return null;
    }
}

// ── Fuente 3: ESPN ────────────────────────────────────────────────────────────
async function verificarCalendarioESPN(equipoLocal, equipoVisitante, utcDateEsperado) {
    try {
        const fechaUTC = new Date(utcDateEsperado);
        // ESPN usa la fecha en UTC para el endpoint scoreboard, probar ±1 día
        const fechas = [
            fechaUTC.toISOString().slice(0, 10).replace(/-/g, ''),
            new Date(fechaUTC.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, ''),
            new Date(fechaUTC.getTime() + 86400000).toISOString().slice(0, 10).replace(/-/g, ''),
        ];

        const localNorm = equipoLocal.toLowerCase();
        const visitanteNorm = equipoVisitante.toLowerCase();

        for (const fecha of fechas) {
            const { data } = await axios.get(
                'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
                { params: { dates: fecha }, timeout: 12000 }
            );
            const eventos = data?.events ?? [];

            const evento = eventos.find((e) => {
                const comps = e.competitions?.[0]?.competitors ?? [];
                const nombres = comps.map((c) => (c.team?.displayName || '').toLowerCase());
                const enc1 = nombres.some((n) => n.includes(localNorm) || localNorm.includes(n.split(' ')[0]));
                const enc2 = nombres.some((n) => n.includes(visitanteNorm) || visitanteNorm.includes(n.split(' ')[0]));
                return enc1 && enc2;
            });

            if (evento?.date) {
                const utcDate = toUTC(evento.date);
                return {
                    fuente: 'ESPN',
                    utcDate,
                    horaColumbia: horaColumbia(utcDate),
                    equipoLocal: evento.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
                    equipoVisitante: evento.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
                };
            }
        }
        return null;
    } catch (err) {
        console.warn('[verif-calendario] ESPN error:', err.message);
        return null;
    }
}

// ── Fuente 4: API-Football ────────────────────────────────────────────────────
async function verificarCalendarioAPIFootball(equipoLocal, equipoVisitante, utcDateEsperado) {
    const key = process.env.API_FOOTBALL_KEY;
    if (!key) return null;
    try {
        const fecha = new Date(utcDateEsperado).toISOString().slice(0, 10);
        const { data } = await axios.get(
            'https://v3.football.api-sports.io/fixtures',
            {
                params: { date: fecha, league: 1, season: 2026 },
                headers: { 'x-apisports-key': key },
                timeout: 12000,
            }
        );
        const fixtures = data?.response ?? [];
        if (!fixtures.length) return null;

        const localNorm = equipoLocal.toLowerCase();
        const visitanteNorm = equipoVisitante.toLowerCase();

        const fixture = fixtures.find((f) => {
            const home = (f.teams?.home?.name || '').toLowerCase();
            const away = (f.teams?.away?.name || '').toLowerCase();
            return (home.includes(localNorm) || localNorm.includes(home.split(' ')[0]))
                && (away.includes(visitanteNorm) || visitanteNorm.includes(away.split(' ')[0]));
        });
        if (!fixture?.fixture?.date) return null;

        const utcDate = toUTC(fixture.fixture.date);
        return {
            fuente: 'API-Football',
            utcDate,
            horaColumbia: horaColumbia(utcDate),
            equipoLocal: fixture.teams?.home?.name,
            equipoVisitante: fixture.teams?.away?.name,
        };
    } catch (err) {
        console.warn('[verif-calendario] API-Football error:', err.message);
        return null;
    }
}

/**
 * Verifica la fecha/hora de un partido contra las 4 fuentes.
 * La fuente 1 (football-data.org) ya viene como parámetro utcDateFuente1.
 *
 * Retorna:
 *   consenso      true  = todas las fuentes disponibles coinciden con fuente1 (dentro de tolerancia)
 *   alertar       true  = al menos una fuente reporta una hora diferente → NO actualizar automáticamente
 *   fuentes       array con el resultado de cada fuente que respondió
 *   horaColumbia  la hora Colombia de la fuente 1 (la que viene de football-data.org)
 */
async function verificarFechaPartido(equipoLocal, equipoVisitante, utcDateFuente1) {
    const fuente1 = {
        fuente: 'football-data.org',
        utcDate: utcDateFuente1,
        horaColumbia: horaColumbia(utcDateFuente1),
    };

    const [f2, f3, f4] = await Promise.all([
        verificarCalendarioTheSportsDB(equipoLocal, equipoVisitante, utcDateFuente1),
        verificarCalendarioESPN(equipoLocal, equipoVisitante, utcDateFuente1),
        verificarCalendarioAPIFootball(equipoLocal, equipoVisitante, utcDateFuente1),
    ]);

    const fuentesDisponibles = [fuente1];
    if (f2) fuentesDisponibles.push(f2);
    if (f3) fuentesDisponibles.push(f3);
    if (f4) fuentesDisponibles.push(f4);

    const discrepantes = fuentesDisponibles
        .slice(1) // excluir fuente1 de la comparación contra sí misma
        .filter((f) => diffMinutos(f.utcDate, utcDateFuente1) > TOLERANCIA_MINUTOS);

    const alertar = discrepantes.length > 0;

    if (alertar) {
        console.error(
            `[VERIF-CALENDARIO] ${equipoLocal} vs ${equipoVisitante}: ` +
            `football-data.org dice ${horaColumbia(utcDateFuente1)} (Colombia) ` +
            `pero otra fuente discrepa. Fuentes: ${JSON.stringify(fuentesDisponibles)}`
        );
    } else {
        const numFuentes = fuentesDisponibles.length;
        console.log(
            `[verif-calendario] ${equipoLocal} vs ${equipoVisitante}: ` +
            `${horaColumbia(utcDateFuente1)} (Colombia) · consenso de ${numFuentes} fuente(s)`
        );
    }

    return {
        consenso: !alertar,
        alertar,
        fuentes: fuentesDisponibles,
        fuentesParciales: { f1: fuente1, f2: f2 ?? null, f3: f3 ?? null, f4: f4 ?? null },
        horaColumbia: horaColumbia(utcDateFuente1),
    };
}

module.exports = { verificarFechaPartido, horaColumbia };
