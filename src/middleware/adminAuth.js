const crypto = require('crypto');

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
    const claveEsperada = process.env.ADMIN_API_KEY || '';

    if (tipo !== 'Bearer' || !token || !claveEsperada || !compararSeguro(token, claveEsperada)) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    next();
}

module.exports = adminAuth;
