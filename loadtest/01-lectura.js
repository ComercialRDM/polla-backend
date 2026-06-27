// Simula gente con la página abierta consultando el ranking en vivo y el pozo
// de premios (tráfico de lectura, sin efectos secundarios — seguro de correr
// las veces que quieras). Requiere haber corrido antes scripts/seed-loadtest.js.
//
// Uso:  k6 run loadtest/01-lectura.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, ESCALAS_VUS, headersConIpFalsa } from './common.js';

export const options = {
    stages: ESCALAS_VUS,
    thresholds: {
        http_req_failed: ['rate<0.05'],
        http_req_duration: ['p(95)<2000'],
    },
};

export function setup() {
    const res = http.get(`${BASE_URL}/api/partidos/`);
    const partidos = res.json('partidos');
    const partido = partidos.find((p) => p.equipo_local === 'LoadTest A') || partidos[0];
    if (!partido) {
        throw new Error('No hay partidos en la BD. Corre primero scripts/seed-loadtest.js');
    }
    return { partidoId: partido.id };
}

export default function (data) {
    const headers = headersConIpFalsa(__VU);

    const ranking = http.get(`${BASE_URL}/api/partidos/${data.partidoId}/ranking`, { headers });
    check(ranking, { 'ranking 200': (r) => r.status === 200 });

    const pozo = http.get(`${BASE_URL}/api/polla/pozo`, { headers });
    check(pozo, { 'pozo 200': (r) => r.status === 200 });

    sleep(1 + Math.random());
}
