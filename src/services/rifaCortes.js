// Cortes horarios de aprobación de boletas de la rifa (hora de Colombia, UTC-5,
// sin horario de verano):
//   lunes a sábado: cada hora de 9:00 a 21:00
//   domingos y festivos: cada hora de 10:00 a 19:00
// Una boleta generada a las 10:23 de un martes entra al corte de las 11:00;
// una generada a las 22:10 entra al primer corte del día siguiente.

const OFFSET_MS = -5 * 60 * 60 * 1000; // Colombia

// Festivos de Colombia 2026 (Ley 51 de 1983 / Ley Emiliani; Pascua: 5 de abril)
const FESTIVOS = new Set([
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03',
    '2026-05-01', '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29',
    '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02',
    '2026-11-16', '2026-12-08', '2026-12-25',
    '2027-01-01', '2027-01-11',
]);

function horasDelDia(fechaLocal) {
    const iso = fechaLocal.toISOString().slice(0, 10);
    const domingoOFestivo = fechaLocal.getUTCDay() === 0 || FESTIVOS.has(iso);
    const [desde, hasta] = domingoOFestivo ? [10, 19] : [9, 21];
    return Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
}

/** Devuelve el instante (Date, UTC) del corte al que pertenece `cuando`. */
function corteDe(cuando = new Date()) {
    const local = new Date(cuando.getTime() + OFFSET_MS); // campos UTC = hora de Colombia
    for (let d = 0; d < 8; d += 1) {
        const dia = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d));
        for (const h of horasDelDia(dia)) {
            const corteLocal = new Date(dia.getTime() + h * 3600 * 1000);
            if (corteLocal.getTime() >= local.getTime()) return new Date(corteLocal.getTime() - OFFSET_MS);
        }
    }
    throw new Error('No se encontró corte');
}

module.exports = { corteDe, FESTIVOS };
