// Genera el feed de calendario (.ics) con los partidos de los equipos
// favoritos de un usuario, para que pueda suscribirse desde Apple/Google/
// Outlook Calendar y reciba automáticamente los partidos de fases futuras
// (octavos, cuartos, semifinal, final) en cuanto el admin los cree.

const DOS_HORAS_MS = 2 * 60 * 60 * 1000;

function formatearFechaUTC(fecha) {
    return fecha.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escaparTexto(texto) {
    return String(texto)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

/**
 * @param {{ equiposFavoritos: string[], partidos: Array<{ id: number, equipo_local: string, equipo_visitante: string, fecha_hora_inicio: string|Date }> }} datos
 * @returns {string} contenido del archivo .ics
 */
function generarICS({ equiposFavoritos, partidos }) {
    const favoritosLower = (equiposFavoritos || []).map((e) => e.toLowerCase());

    const partidosFiltrados = (partidos || []).filter(
        (p) =>
            favoritosLower.includes(p.equipo_local.toLowerCase()) ||
            favoritosLower.includes(p.equipo_visitante.toLowerCase())
    );

    const lineas = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//La Retoucherie de Manuela//Polla Mundialista//ES',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Mis partidos - GanaConRetoucherie',
        'X-PUBLISHED-TTL:PT12H',
        'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    ];

    for (const partido of partidosFiltrados) {
        const inicio = new Date(partido.fecha_hora_inicio);
        const fin = new Date(inicio.getTime() + DOS_HORAS_MS);
        const ahora = new Date();
        const resumen = `⚽ ${partido.equipo_local} vs ${partido.equipo_visitante} — La Retoucherie te recuerda este partido`;
        const descripcion = '🎉 ¡Vive el Mundial con La Retoucherie de Manuela! GanaConRetoucherie 🇨🇴 www.ganaconretoucherie.com';

        lineas.push(
            'BEGIN:VEVENT',
            `UID:partido-${partido.id}@ganaconretoucherie.com`,
            `DTSTAMP:${formatearFechaUTC(ahora)}`,
            `DTSTART:${formatearFechaUTC(inicio)}`,
            `DTEND:${formatearFechaUTC(fin)}`,
            `SUMMARY:${escaparTexto(resumen)}`,
            `DESCRIPTION:${escaparTexto(descripcion)}`,
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'TRIGGER:-PT30M',
            `DESCRIPTION:${escaparTexto(resumen)}`,
            'END:VALARM',
            'END:VEVENT'
        );
    }

    lineas.push('END:VCALENDAR');

    return lineas.join('\r\n');
}

module.exports = { generarICS };
