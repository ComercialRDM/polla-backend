// Configuración compartida por los scripts de k6. BASE_URL siempre debe
// apuntar a un entorno de sandbox (local o staging), NUNCA a producción.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

// Escalas para los escenarios "ramping-vus" (usuarios con la página abierta,
// ej. viendo el ranking en vivo): sube gradualmente hasta 20,000 VUs.
export const ESCALAS_VUS = [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 1000 },
    { duration: '2m', target: 5000 },
    { duration: '2m', target: 10000 },
    { duration: '2m', target: 20000 },
    { duration: '2m', target: 20000 },
    { duration: '30s', target: 0 },
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
