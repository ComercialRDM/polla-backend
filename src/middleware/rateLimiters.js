const rateLimit = require('express-rate-limit');

// Limita login, registro y recuperación de contraseña para frenar fuerza bruta
// y abuso del envío de OTP por WhatsApp (ManyChat)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
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
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Demasiadas solicitudes. Espera unos minutos e inténtalo de nuevo.' },
});

module.exports = { authLimiter, adminLimiter, transaccionesLimiter };
