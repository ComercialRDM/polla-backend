const { verificarToken } = require('../utils/adminTokens');

function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    // Token de sesión emitido por /api/admin/login (cuenta individual)
    const sesion = verificarToken(token);
    if (!sesion) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    req.admin = sesion;
    return next();
}

module.exports = adminAuth;
