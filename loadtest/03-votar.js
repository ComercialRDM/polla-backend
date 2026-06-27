// Simula miles de personas registrando su pronóstico al mismo tiempo
// (POST /api/polla/votar) — el escenario central de la pregunta original
// ("30 influencers + 10,000-20,000 personas pronosticando"). Cada token de
// los pre-cargados solo puede votar una vez por partido (regla real de
// negocio); pasada la primera ronda, las repeticiones devuelven 400 "ya
// registraste tu pronóstico", lo cual es esperado y aun así ejercita la
// consulta + el bloqueo de fila en DB.
//
// Requiere haber corrido antes:  node scripts/seed-loadtest.js
// Uso:  k6 run loadtest/03-votar.js
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, ESCALAS_LLEGADAS, headersConIpFalsa } from './common.js';

const tokens = JSON.parse(open('./data/tokens.json'));

export const options = {
    scenarios: {
        votar: {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            preAllocatedVUs: 500,
            maxVUs: 5000,
            stages: ESCALAS_LLEGADAS,
        },
    },
    thresholds: {
        // 5xx = el servidor se cayó/saturó; 400 "ya registraste" no cuenta como fallo de carga.
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<3000'],
    },
};

export default function () {
    if (tokens.length === 0) {
        throw new Error('loadtest/data/tokens.json está vacío. Corre primero scripts/seed-loadtest.js');
    }

    const indice = (__VU * 100000 + __ITER) % tokens.length;
    const { token_acceso, partido_id } = tokens[indice];

    const payload = JSON.stringify({
        token_acceso,
        partido_id,
        local: Math.floor(Math.random() * 5),
        visitante: Math.floor(Math.random() * 5),
    });

    const res = http.post(`${BASE_URL}/api/polla/votar`, payload, {
        headers: headersConIpFalsa(__VU),
    });

    check(res, { 'votar no es error de servidor (5xx)': (r) => r.status < 500 });
}
