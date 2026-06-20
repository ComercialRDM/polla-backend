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

module.exports = { authLimiter, adminLimiter, transaccionesLimiter, pollaLimiter, votarLimiter };
