// Configuración compartida por los scripts de k6. BASE_URL siempre debe
// apuntar a un entorno de sandbox (local o staging), NUNCA a producción.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

// El backend usa rate limiting por IP (correcto para producción). Contra
// localhost, TODAS las VUs de k6 comparten la misma IP real (127.0.0.1), así
// que sin esto se bloquearían entre ellas mismas con 429 y la prueba no
// mediría nada real. El backend confía en X-Forwarded-For (trust proxy
// configurado en server.js), así que cada VU manda una IP simulada distinta
// — esto sí representa miles de usuarios reales detrás de IPs distintas.
export function headersConIpFalsa(vu) {
    const a = 10;
    const b = (vu >> 16) & 255;
    const c = (vu >> 8) & 255;
    const d = vu & 255;
    return {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `${a}.${b}.${c}.${d}`,
    };
}

// Escalas para los escenarios "ramping-vus" (usuarios con la página abierta,
// ej. viendo el ranking en vivo). Tope bajado a 3,000 VUs: contra localhost en
// Windows, más de eso agota los buffers de socket del propio sistema operativo
// (no del backend) y los resultados dejan de ser confiables. Contra un entorno
// real desplegado (no localhost), se puede subir con -e MAX_VUS=20000.
const TOPE_VUS = Number(__ENV.MAX_VUS) || 3000;
export const ESCALAS_VUS = [
    { duration: '20s', target: Math.round(TOPE_VUS * 0.03) },
    { duration: '40s', target: Math.round(TOPE_VUS * 0.17) },
    { duration: '1m', target: Math.round(TOPE_VUS * 0.5) },
    { duration: '1m', target: TOPE_VUS },
    { duration: '2m', target: TOPE_VUS },
    { duration: '20s', target: 0 },
];

// Escalas para los escenarios "ramping-arrival-rate" (acciones de una sola
// vez por persona, ej. comprar o votar): sube la tasa de llegadas por segundo.
export const ESCALAS_LLEGADAS = [
    { duration: '30s', target: 5 },
    { duration: '1m', target: 20 },
    { duration: '2m', target: 60 },
    { duration: '2m', target: 120 },
    { duration: '2m', target: 200 },
    { duration: '30s', target: 0 },
];
