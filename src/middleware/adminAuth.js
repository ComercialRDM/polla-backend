const crypto = require('crypto');
const { verificarToken } = require('../utils/adminTokens');

function compararSeguro(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Compara contra sí mismo para mantener un tiempo constante aunque las longitudes difieran
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    // Token de sesión emitido por /api/admin/login (cuenta individual)
    const sesion = verificarToken(token);
    if (sesion) {
        req.admin = sesion;
        return next();
    }

    // Respaldo transitorio: clave estática ADMIN_API_KEY (será retirada)
    const claveEsperada = process.env.ADMIN_API_KEY || '';
    if (claveEsperada && compararSeguro(token, claveEsperada)) {
        return next();
    }

    return res.status(401).json({ success: false, error: 'No autorizado' });
}

module.exports = adminAuth;
