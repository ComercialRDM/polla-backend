const rateLimit = require('express-rate-limit');

// Limita login, registro y recuperación de contraseña para frenar fuerza bruta
// y abuso del envío de OTP por WhatsApp (ManyChat)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
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
const transaccionesLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
});

// Limita el tráfico general de /api/polla y /api/partidos (ranking en vivo,
// resúmenes, info) para resistir picos de tráfico o scraping agresivo durante
// partidos de alta audiencia (ej. Colombia), sin afectar el uso normal.
const pollaLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' },
});

// Límite extra, más estricto, sobre las acciones de escritura (votar/votar-flash)
// para frenar bots que intenten acaparar sorteos flash a fuerza de repetir
// intentos en bucle.
const votarLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiados intentos de votación. Espera unos minutos e inténtalo de nuevo.' },
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
// en vivo). No reemplaza la validación de firma/secreto, solo evita fuerza bruta
// del secreto y picos de tráfico no esperados.
const webhooksLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
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

module.exports = { authLimiter, adminLimiter, transaccionesLimiter, pollaLimiter, votarLimiter, otpLimiter, webhooksLimiter, resetPasswordLimiter };
