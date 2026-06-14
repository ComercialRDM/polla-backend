/**
 * Carga los partidos de la fase de grupos del Mundial 2026 en la base de datos
 * a través de la API admin (POST /api/admin/partidos).
 *
 * Las horas ya están convertidas a hora de Colombia (UTC-5).
 * IMPORTANTE: los horarios fueron tomados de fuentes públicas (Fox Sports) y
 * pueden tener pequeños desajustes. Verifica especialmente los 3 partidos de
 * Colombia (marcados abajo) contra la app oficial de FIFA antes de confiar
 * en ellos para la polla.
 *
 * Los partidos 1-8 (ya jugados al momento de escribir este script) tienen
 * horas aproximadas, ya que su resultado ya quedó definido y solo se cargan
 * para tener el calendario completo.
 *
 * La fase eliminatoria (octavos en adelante) no se incluye porque los
 * equipos todavía no están definidos (dependen de los resultados de grupos).
 *
 * Uso:
 *   ADMIN_API_KEY=xxxx BACKEND_URL=https://polla-backend-cz6u.onrender.com node scripts/cargar-mundial-2026.js
 */

const BACKEND_URL = process.env.BACKEND_URL || 'https://polla-backend-cz6u.onrender.com';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
    console.error('Falta la variable de entorno ADMIN_API_KEY');
    process.exit(1);
}

// fecha_hora_inicio en hora de Colombia (UTC-5)
const partidos = [
    // --- Jun 11 (horas aproximadas, partidos ya jugados) ---
    { equipo_local: 'Mexico', equipo_visitante: 'Sudafrica', fecha_hora_inicio: '2026-06-11T13:00:00-05:00' }, // Grupo A
    { equipo_local: 'Corea del Sur', equipo_visitante: 'Chequia', fecha_hora_inicio: '2026-06-11T19:00:00-05:00' }, // Grupo A

    // --- Jun 12 (horas aproximadas, partidos ya jugados) ---
    { equipo_local: 'Canada', equipo_visitante: 'Bosnia y Herzegovina', fecha_hora_inicio: '2026-06-12T14:00:00-05:00' }, // Grupo B
    { equipo_local: 'Estados Unidos', equipo_visitante: 'Paraguay', fecha_hora_inicio: '2026-06-12T21:00:00-05:00' }, // Grupo D

    // --- Jun 13 (horas aproximadas para 5 y 6, partidos ya jugados) ---
    { equipo_local: 'Catar', equipo_visitante: 'Suiza', fecha_hora_inicio: '2026-06-13T12:00:00-05:00' }, // Grupo B
    { equipo_local: 'Brasil', equipo_visitante: 'Marruecos', fecha_hora_inicio: '2026-06-13T15:00:00-05:00' }, // Grupo C
    { equipo_local: 'Haiti', equipo_visitante: 'Escocia', fecha_hora_inicio: '2026-06-13T20:00:00-05:00' }, // Grupo C
    { equipo_local: 'Australia', equipo_visitante: 'Turquia', fecha_hora_inicio: '2026-06-13T23:00:00-05:00' }, // Grupo D

    // --- Jun 14 ---
    { equipo_local: 'Alemania', equipo_visitante: 'Curazao', fecha_hora_inicio: '2026-06-14T12:00:00-05:00' }, // Grupo E
    { equipo_local: 'Holanda', equipo_visitante: 'Japon', fecha_hora_inicio: '2026-06-14T15:00:00-05:00' }, // Grupo F
    { equipo_local: 'Costa de Marfil', equipo_visitante: 'Ecuador', fecha_hora_inicio: '2026-06-14T18:00:00-05:00' }, // Grupo E
    { equipo_local: 'Tunez', equipo_visitante: 'Suecia', fecha_hora_inicio: '2026-06-14T21:00:00-05:00' }, // Grupo F

    // --- Jun 15 ---
    { equipo_local: 'Espana', equipo_visitante: 'Cabo Verde', fecha_hora_inicio: '2026-06-15T11:00:00-05:00' }, // Grupo H
    { equipo_local: 'Belgica', equipo_visitante: 'Egipto', fecha_hora_inicio: '2026-06-15T14:00:00-05:00' }, // Grupo G
    { equipo_local: 'Arabia Saudita', equipo_visitante: 'Uruguay', fecha_hora_inicio: '2026-06-15T17:00:00-05:00' }, // Grupo H
    { equipo_local: 'Iran', equipo_visitante: 'Nueva Zelanda', fecha_hora_inicio: '2026-06-15T20:00:00-05:00' }, // Grupo G

    // --- Jun 16 ---
    { equipo_local: 'Francia', equipo_visitante: 'Senegal', fecha_hora_inicio: '2026-06-16T14:00:00-05:00' }, // Grupo I
    { equipo_local: 'Irak', equipo_visitante: 'Noruega', fecha_hora_inicio: '2026-06-16T17:00:00-05:00' }, // Grupo I
    { equipo_local: 'Argentina', equipo_visitante: 'Argelia', fecha_hora_inicio: '2026-06-16T20:00:00-05:00' }, // Grupo J
    { equipo_local: 'Austria', equipo_visitante: 'Jordania', fecha_hora_inicio: '2026-06-16T23:00:00-05:00' }, // Grupo J

    // --- Jun 17 ---
    { equipo_local: 'Portugal', equipo_visitante: 'RD Congo', fecha_hora_inicio: '2026-06-17T12:00:00-05:00' }, // Grupo K
    { equipo_local: 'Inglaterra', equipo_visitante: 'Croacia', fecha_hora_inicio: '2026-06-17T15:00:00-05:00' }, // Grupo L
    { equipo_local: 'Ghana', equipo_visitante: 'Panama', fecha_hora_inicio: '2026-06-17T18:00:00-05:00' }, // Grupo L
    { equipo_local: 'Uzbekistan', equipo_visitante: 'Colombia', fecha_hora_inicio: '2026-06-17T21:00:00-05:00' }, // Grupo K - PARTIDO DE COLOMBIA, verificar hora

    // --- Jun 18 ---
    { equipo_local: 'Chequia', equipo_visitante: 'Sudafrica', fecha_hora_inicio: '2026-06-18T11:00:00-05:00' }, // Grupo A
    { equipo_local: 'Suiza', equipo_visitante: 'Bosnia y Herzegovina', fecha_hora_inicio: '2026-06-18T14:00:00-05:00' }, // Grupo B
    { equipo_local: 'Canada', equipo_visitante: 'Catar', fecha_hora_inicio: '2026-06-18T17:00:00-05:00' }, // Grupo B
    { equipo_local: 'Mexico', equipo_visitante: 'Corea del Sur', fecha_hora_inicio: '2026-06-18T20:00:00-05:00' }, // Grupo A

    // --- Jun 19 ---
    { equipo_local: 'Estados Unidos', equipo_visitante: 'Australia', fecha_hora_inicio: '2026-06-19T14:00:00-05:00' }, // Grupo D
    { equipo_local: 'Escocia', equipo_visitante: 'Marruecos', fecha_hora_inicio: '2026-06-19T14:00:00-05:00' }, // Grupo C
    { equipo_local: 'Brasil', equipo_visitante: 'Haiti', fecha_hora_inicio: '2026-06-19T20:00:00-05:00' }, // Grupo C
    { equipo_local: 'Turquia', equipo_visitante: 'Paraguay', fecha_hora_inicio: '2026-06-19T23:00:00-05:00' }, // Grupo D

    // --- Jun 20 ---
    { equipo_local: 'Holanda', equipo_visitante: 'Suecia', fecha_hora_inicio: '2026-06-20T12:00:00-05:00' }, // Grupo F
    { equipo_local: 'Alemania', equipo_visitante: 'Costa de Marfil', fecha_hora_inicio: '2026-06-20T15:00:00-05:00' }, // Grupo E
    { equipo_local: 'Ecuador', equipo_visitante: 'Curazao', fecha_hora_inicio: '2026-06-20T19:00:00-05:00' }, // Grupo E
    { equipo_local: 'Tunez', equipo_visitante: 'Japon', fecha_hora_inicio: '2026-06-20T23:00:00-05:00' }, // Grupo F

    // --- Jun 21 ---
    { equipo_local: 'Espana', equipo_visitante: 'Arabia Saudita', fecha_hora_inicio: '2026-06-21T11:00:00-05:00' }, // Grupo H
    { equipo_local: 'Belgica', equipo_visitante: 'Iran', fecha_hora_inicio: '2026-06-21T14:00:00-05:00' }, // Grupo G
    { equipo_local: 'Uruguay', equipo_visitante: 'Cabo Verde', fecha_hora_inicio: '2026-06-21T17:00:00-05:00' }, // Grupo H
    { equipo_local: 'Nueva Zelanda', equipo_visitante: 'Egipto', fecha_hora_inicio: '2026-06-21T20:00:00-05:00' }, // Grupo G

    // --- Jun 22 ---
    { equipo_local: 'Argentina', equipo_visitante: 'Austria', fecha_hora_inicio: '2026-06-22T12:00:00-05:00' }, // Grupo J
    { equipo_local: 'Francia', equipo_visitante: 'Irak', fecha_hora_inicio: '2026-06-22T16:00:00-05:00' }, // Grupo I
    { equipo_local: 'Noruega', equipo_visitante: 'Senegal', fecha_hora_inicio: '2026-06-22T19:00:00-05:00' }, // Grupo I
    { equipo_local: 'Jordania', equipo_visitante: 'Argelia', fecha_hora_inicio: '2026-06-22T22:00:00-05:00' }, // Grupo J

    // --- Jun 23 ---
    { equipo_local: 'Portugal', equipo_visitante: 'Uzbekistan', fecha_hora_inicio: '2026-06-23T12:00:00-05:00' }, // Grupo K
    { equipo_local: 'Inglaterra', equipo_visitante: 'Ghana', fecha_hora_inicio: '2026-06-23T15:00:00-05:00' }, // Grupo L
    { equipo_local: 'Panama', equipo_visitante: 'Croacia', fecha_hora_inicio: '2026-06-23T18:00:00-05:00' }, // Grupo L
    { equipo_local: 'Colombia', equipo_visitante: 'RD Congo', fecha_hora_inicio: '2026-06-23T21:00:00-05:00' }, // Grupo K - PARTIDO DE COLOMBIA, verificar hora

    // --- Jun 24 ---
    { equipo_local: 'Suiza', equipo_visitante: 'Canada', fecha_hora_inicio: '2026-06-24T14:00:00-05:00' }, // Grupo B
    { equipo_local: 'Bosnia y Herzegovina', equipo_visitante: 'Catar', fecha_hora_inicio: '2026-06-24T14:00:00-05:00' }, // Grupo B
    { equipo_local: 'Brasil', equipo_visitante: 'Escocia', fecha_hora_inicio: '2026-06-24T17:00:00-05:00' }, // Grupo C
    { equipo_local: 'Marruecos', equipo_visitante: 'Haiti', fecha_hora_inicio: '2026-06-24T17:00:00-05:00' }, // Grupo C
    { equipo_local: 'Mexico', equipo_visitante: 'Chequia', fecha_hora_inicio: '2026-06-24T20:00:00-05:00' }, // Grupo A
    { equipo_local: 'Corea del Sur', equipo_visitante: 'Sudafrica', fecha_hora_inicio: '2026-06-24T20:00:00-05:00' }, // Grupo A

    // --- Jun 25 ---
    { equipo_local: 'Ecuador', equipo_visitante: 'Alemania', fecha_hora_inicio: '2026-06-25T15:00:00-05:00' }, // Grupo E
    { equipo_local: 'Curazao', equipo_visitante: 'Costa de Marfil', fecha_hora_inicio: '2026-06-25T15:00:00-05:00' }, // Grupo E
    { equipo_local: 'Tunez', equipo_visitante: 'Holanda', fecha_hora_inicio: '2026-06-25T18:00:00-05:00' }, // Grupo F
    { equipo_local: 'Japon', equipo_visitante: 'Suecia', fecha_hora_inicio: '2026-06-25T18:00:00-05:00' }, // Grupo F
    { equipo_local: 'Estados Unidos', equipo_visitante: 'Turquia', fecha_hora_inicio: '2026-06-25T21:00:00-05:00' }, // Grupo D
    { equipo_local: 'Paraguay', equipo_visitante: 'Australia', fecha_hora_inicio: '2026-06-25T21:00:00-05:00' }, // Grupo D

    // --- Jun 26 ---
    { equipo_local: 'Noruega', equipo_visitante: 'Francia', fecha_hora_inicio: '2026-06-26T14:00:00-05:00' }, // Grupo I
    { equipo_local: 'Senegal', equipo_visitante: 'Irak', fecha_hora_inicio: '2026-06-26T14:00:00-05:00' }, // Grupo I
    { equipo_local: 'Uruguay', equipo_visitante: 'Espana', fecha_hora_inicio: '2026-06-26T19:00:00-05:00' }, // Grupo H
    { equipo_local: 'Cabo Verde', equipo_visitante: 'Arabia Saudita', fecha_hora_inicio: '2026-06-26T19:00:00-05:00' }, // Grupo H
    { equipo_local: 'Nueva Zelanda', equipo_visitante: 'Belgica', fecha_hora_inicio: '2026-06-26T22:00:00-05:00' }, // Grupo G
    { equipo_local: 'Egipto', equipo_visitante: 'Iran', fecha_hora_inicio: '2026-06-26T22:00:00-05:00' }, // Grupo G

    // --- Jun 27 ---
    { equipo_local: 'Panama', equipo_visitante: 'Inglaterra', fecha_hora_inicio: '2026-06-27T16:00:00-05:00' }, // Grupo L
    { equipo_local: 'Croacia', equipo_visitante: 'Ghana', fecha_hora_inicio: '2026-06-27T16:00:00-05:00' }, // Grupo L
    { equipo_local: 'Colombia', equipo_visitante: 'Portugal', fecha_hora_inicio: '2026-06-27T18:30:00-05:00' }, // Grupo K - PARTIDO DE COLOMBIA, verificar hora
    { equipo_local: 'RD Congo', equipo_visitante: 'Uzbekistan', fecha_hora_inicio: '2026-06-27T18:30:00-05:00' }, // Grupo K
    { equipo_local: 'Argentina', equipo_visitante: 'Jordania', fecha_hora_inicio: '2026-06-27T21:00:00-05:00' }, // Grupo J
    { equipo_local: 'Argelia', equipo_visitante: 'Austria', fecha_hora_inicio: '2026-06-27T21:00:00-05:00' }, // Grupo J
];

async function main() {
    let creados = 0;
    let fallidos = 0;

    for (const partido of partidos) {
        try {
            const res = await fetch(`${BACKEND_URL}/api/admin/partidos`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${ADMIN_API_KEY}`,
                },
                body: JSON.stringify(partido),
            });

            const data = await res.json();

            if (data.success) {
                creados++;
                console.log(`OK: ${partido.equipo_local} vs ${partido.equipo_visitante} (${partido.fecha_hora_inicio})`);
            } else {
                fallidos++;
                console.error(`ERROR: ${partido.equipo_local} vs ${partido.equipo_visitante} -> ${data.error}`);
            }
        } catch (err) {
            fallidos++;
            console.error(`ERROR de conexion: ${partido.equipo_local} vs ${partido.equipo_visitante} -> ${err.message}`);
        }
    }

    console.log(`\nListo. Creados: ${creados}, Fallidos: ${fallidos}`);
}

main();
