// Simula gente nueva llegando a comprar el bono (POST /crear-link). Esto SÍ
// crea usuarios/transacciones reales en la BD de prueba, pero NO llama a
// Wompi ni envía correo/WhatsApp (eso solo pasa al aprobar vía webhook, que
// no se dispara aquí) — seguro de correr en el sandbox local.
//
// Uso:  k6 run loadtest/02-compras.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, ESCALAS_LLEGADAS, headersConIpFalsa } from './common.js';

export const options = {
    scenarios: {
        compras: {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            preAllocatedVUs: 200,
            maxVUs: 3000,
            stages: ESCALAS_LLEGADAS,
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.05'],
        http_req_duration: ['p(95)<3000'],
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
    const sufijo = `${__VU}-${__ITER}-${Date.now()}`;
    const celular = `3${String(700000000 + __VU * 1000 + (__ITER % 1000)).padStart(9, '0')}`;

    const payload = JSON.stringify({
        nombre: `LoadTest Compra ${sufijo}`,
        correo: `loadtest+compra${sufijo}@example.com`,
        celular,
        partido_id: data.partidoId,
        valor: 10000,
    });

    const res = http.post(`${BASE_URL}/api/transacciones/crear-link`, payload, {
        headers: headersConIpFalsa(__VU),
    });

    check(res, { 'crear-link OK': (r) => r.status === 200 });
}
