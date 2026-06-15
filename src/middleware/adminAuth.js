const { verificarToken } = require('../utils/adminTokens');

// Middleware de autenticación + control de acceso por rol (RBAC) para el
// panel de administración. Solo acepta tokens emitidos por /api/admin/login
// cuyo payload declare explícitamente role: "ADMIN".
function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const sesion = verificarToken(token);
    if (!sesion) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    if (sesion.role !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Acceso prohibido: se requiere rol ADMIN' });
    }

    req.admin = sesion;
    return next();
}

module.exports = adminAuth;
