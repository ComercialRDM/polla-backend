const rateLimit = require('express-rate-limit');
const { registrarEvento } = require('../services/alertaService');
const { obtenerIp } = require('../utils/request');

// Limita login, registro y recuperación de contraseña para frenar fuerza bruta
// y abuso del envío de OTP por WhatsApp (ManyChat)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
    handler: (req, res, next, options) => {
        registrarEvento('AUTH_FUERZA_BRUTA', { ip: obtenerIp(req) });
        res.status(options.statusCode).json(options.message);
    },
});

// Limita el panel de administración (clave fija) para frenar fuerza bruta
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
});

// Limita la creación de transacciones (endpoints públicos sin autenticación)
// para frenar el registro masivo de usuarios/transacciones y el abuso de Wompi.
// Límite alto a propósito: con campañas/influencers, muchos compradores
// legítimos distintos pueden compartir la misma IP pública (NAT de operador
// móvil colombiano) y no deben bloquearse entre sí.
const transaccionesLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
    handler: (req, res, next, options) => {
        registrarEvento('RATE_LIMIT_TRANSACCIONES', { ip: obtenerIp(req) });
        res.status(options.statusCode).json(options.message);
    },
});

// Limita el tráfico general de /api/polla y /api/partidos (ranking en vivo,
// resúmenes, info) para resistir scraping agresivo, sin afectar picos de
// tráfico legítimo durante partidos de alta audiencia o campañas masivas.
const pollaLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' },
});

// Límite extra sobre las acciones de escritura (votar/votar-flash) para frenar
// bots que intenten acaparar sorteos flash a fuerza de repetir intentos en
// bucle. Límite alto a propósito (mismo motivo que transaccionesLimiter):
// muchos votantes legítimos distintos pueden compartir IP en una campaña.
const votarLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos de votación. Espera unos minutos e inténtalo de nuevo.' },
    handler: (req, res, next, options) => {
        registrarEvento('RATE_LIMIT_VOTAR', { ip: obtenerIp(req) });
        res.status(options.statusCode).json(options.message);
    },
});

// Límite estricto y por número de destino para el envío de OTP por SMS (Twilio,
// tiene costo monetario real por mensaje). Evita "SMS bombing" hacia un celular
// arbitrario reutilizando /api/auth/telefono/solicitar-codigo en bucle.
const otpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiados códigos solicitados. Espera una hora e inténtalo de nuevo.' },
    keyGenerator: (req) => (req.body?.celular ? `otp:${req.body.celular}` : req.ip),
});

// Límite genérico para webhooks externos (Wompi, ManyChat, proveedor de marcadores
// en vivo). No reemplaza la validación de firma/secreto (esa es la protección
// real) — solo evita fuerza bruta del secreto. Límite alto a propósito: una
// campaña/influencers exitosa puede generar muchas más de 30 confirmaciones de
// pago de Wompi por minuto, y bloquearlas dejaría compras pagadas sin bono.
const webhooksLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes.' },
});

// Límite por número de celular (no solo por IP) para solicitar restablecer la
// contraseña: evita que alguien bombardee el WhatsApp/correo de otra persona
// con códigos de reset repetidos (acoso/spam), aunque no pueda adivinarlos.
const resetPasswordLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes de restablecimiento. Espera una hora e inténtalo de nuevo.' },
    keyGenerator: (req) => (req.body?.celular ? `reset:${req.body.celular}` : req.ip),
});

// Limita el formulario público de registro de influencers/creadores de
// contenido para frenar spam y bots (no requiere autenticación).
const influencersLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
});

// Limita el registro de clics de afiliados: es público y de escritura, así
// que sin límite sería el blanco más fácil para inflar clics por fuerza bruta.
const clicLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' },
});

module.exports = { authLimiter, adminLimiter, transaccionesLimiter, pollaLimiter, votarLimiter, otpLimiter, webhooksLimiter, resetPasswordLimiter, influencersLimiter, clicLimiter };
