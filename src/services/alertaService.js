const { enviarBonoPorPlantilla } = require('./manychatService');

const ADMIN_CELULAR = process.env.ALERT_CELULAR;
const DEBOUNCE_MS = 5 * 60 * 1000; // 1 alerta del mismo tipo cada 5 min como máximo

// Contadores en memoria: se resetean solo al reiniciar el proceso (Render lo
// reinicia en cada deploy, lo cual es aceptable para este uso).
const contadores = {};
const ultimasAlertas = {};
const ventanas = {};

const NIVELES = {
    5: '🔴 CRÍTICO',
    4: '🟠 ALTO',
    3: '🟡 MEDIO',
    2: '🔵 BAJO',
    1: '⚪ INFO',
};

// Configuración de cada tipo de alerta: umbral de ocurrencias, ventana de tiempo
// en que se cuentan, y nivel de criticidad resultante.
const ALERTAS = {
    PAGO_FALLIDO: {
        nivel: 4,
        componente: 'Pasarela de pagos',
        umbral: 3,
        ventanaMs: 10 * 60 * 1000,
        descripcionBase: 'Múltiples transacciones fallaron consecutivamente',
    },
    WEBHOOK_FIRMA_INVALIDA: {
        nivel: 5,
        componente: 'Seguridad / Webhooks',
        umbral: 3,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Firma inválida en webhooks de Wompi — posible ataque',
    },
    AUTH_FUERZA_BRUTA: {
        nivel: 5,
        componente: 'Seguridad / Auth',
        umbral: 5,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Demasiados intentos de login desde la misma IP',
    },
    RATE_LIMIT_TRANSACCIONES: {
        nivel: 3,
        componente: 'Rate limiter / Bots',
        umbral: 10,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Tráfico anómalo en creación de transacciones',
    },
    RATE_LIMIT_VOTAR: {
        nivel: 3,
        componente: 'Rate limiter / Votaciones',
        umbral: 15,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Bot detectado intentando votar masivamente',
    },
    ERROR_SERVIDOR: {
        nivel: 3,
        componente: 'Servidor backend',
        umbral: 5,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Múltiples errores 500 en el backend',
    },
    ERROR_SERVIDOR_ALTO: {
        nivel: 4,
        componente: 'Servidor backend',
        umbral: 15,
        ventanaMs: 5 * 60 * 1000,
        descripcionBase: 'Avalancha de errores 500 — posible caída parcial',
    },
};

async function enviarAlerta({ tipo, descripcion, ip = '' }) {
    if (!ADMIN_CELULAR) return;

    const config = ALERTAS[tipo];
    if (!config) return;

    const ahora = Date.now();
    if (ultimasAlertas[tipo] && ahora - ultimasAlertas[tipo] < DEBOUNCE_MS) return;
    ultimasAlertas[tipo] = ahora;

    const nivel = config.nivel;
    const nivelStr = NIVELES[nivel] || `⚠️ NIVEL ${nivel}`;
    const ts = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', hour12: false });
    const ocurrencias = contadores[tipo] || 1;

    try {
        await enviarBonoPorPlantilla({
            celular: ADMIN_CELULAR,
            nombre: `${nivelStr} (${nivel}/5)`,
            monto: config.componente,
            codigo: (descripcion || config.descripcionBase).substring(0, 60),
            partido: ts,
            intentos: `${ocurrencias} evento${ocurrencias !== 1 ? 's' : ''} en ventana${ip ? ` · IP: ${ip}` : ''}`,
            link: 'https://dashboard.render.com',
        });
        console.log(`[alerta] Enviada alerta ${tipo} nivel ${nivel} a ${ADMIN_CELULAR}`);
    } catch (err) {
        console.error('[alerta] Error enviando alerta WhatsApp:', err.message);
    }
}

function registrarEvento(tipo, { descripcion = '', ip = '' } = {}) {
    const config = ALERTAS[tipo];
    if (!config) return;

    const ahora = Date.now();

    // Inicializar ventana deslizante
    if (!ventanas[tipo]) ventanas[tipo] = [];
    ventanas[tipo].push(ahora);

    // Limpiar eventos fuera de la ventana de tiempo
    ventanas[tipo] = ventanas[tipo].filter((t) => ahora - t < config.ventanaMs);
    contadores[tipo] = ventanas[tipo].length;

    if (contadores[tipo] >= config.umbral) {
        // Reset para no re-disparar hasta la próxima ventana completa
        ventanas[tipo] = [];
        contadores[tipo] = 0;
        enviarAlerta({ tipo, descripcion, ip });
    }
}

// Envío manual de alerta sin umbral (para errores críticos puntuales)
function alertaInmediata(tipo, { descripcion = '', ip = '' } = {}) {
    enviarAlerta({ tipo, descripcion, ip });
}

module.exports = { registrarEvento, alertaInmediata, ALERTAS };
