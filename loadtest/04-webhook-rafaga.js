// Simula una ráfaga de confirmaciones de pago de Wompi llegando de golpe
// (ej. una campaña que genera cientos de ventas aprobadas por minuto) para
// comprobar que el nuevo límite de webhooksLimiter (antes 30/min, ahora
// 1000/min) realmente las deja pasar.
//
// ADVERTENCIA: a diferencia de los otros scripts, este SÍ dispara el flujo
// real de aprobación (aprobacionService.js) — genera la imagen del bono y
// SÍ intenta enviar un correo real por SMTP a las direcciones @example.com
// generadas por el seed (no llegan a nadie real, pero tu cuenta SMTP local
// hace el intento de envío). ManyChat no se llama de verdad si no tienes
// MANYCHAT_API_KEY configurada localmente. Córrelo solo si entiendes esto.
//
// Requiere: node scripts/seed-loadtest.js  (genera loadtest/data/pendientes.json)
// y la variable de entorno WOMPI_EVENTS_SECRET (la misma que usa el backend local).
//
// Uso:  k6 run -e WOMPI_EVENTS_SECRET=test_events_xxx loadtest/04-webhook-rafaga.js
import http from 'k6/http';
import { sha256 } from 'k6/crypto';
import { check } from 'k6';
import { BASE_URL } from './common.js';

const pendientes = JSON.parse(open('./data/pendientes.json'));
const WOMPI_EVENTS_SECRET = __ENV.WOMPI_EVENTS_SECRET;

export const options = {
    scenarios: {
        webhook: {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            preAllocatedVUs: 100,
            maxVUs: 1000,
            stages: [
                { duration: '15s', target: 10 },
                { duration: '30s', target: 50 },
                { duration: '30s', target: 100 },
                { duration: '15s', target: 0 },
            ],
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],
    },
};

function firmarEvento({ id, status, amountInCents, timestamp }) {
    const cadena = `${id}${status}${amountInCents}${timestamp}${WOMPI_EVENTS_SECRET}`;
    return sha256(cadena, 'hex');
}

export default function () {
    if (!WOMPI_EVENTS_SECRET) {
        throw new Error('Falta -e WOMPI_EVENTS_SECRET=... (debe coincidir con el .env del backend local)');
    }
    if (pendientes.length === 0) {
        throw new Error('loadtest/data/pendientes.json está vacío. Corre primero scripts/seed-loadtest.js');
    }

    const indice = (__VU * 100000 + __ITER) % pendientes.length;
    const { reference, amount_in_cents } = pendientes[indice];
    const id = `loadtest-${reference}`;
    const status = 'APPROVED';
    const timestamp = Math.floor(Date.now() / 1000);

    const evento = {
        event: 'transaction.updated',
        data: {
            transaction: {
                id,
                status,
                amount_in_cents,
                reference,
                payment_link_id: null,
            },
        },
        signature: {
            properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
            checksum: firmarEvento({ id, status, amountInCents: amount_in_cents, timestamp }),
        },
        timestamp,
    };

    const res = http.post(`${BASE_URL}/api/webhooks/wompi`, JSON.stringify(evento), {
        headers: { 'Content-Type': 'application/json' },
    });

    check(res, { 'webhook no rechazado por rate limit (429)': (r) => r.status !== 429 });
}
