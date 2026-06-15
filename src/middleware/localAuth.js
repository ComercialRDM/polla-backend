const { verificarToken } = require('../utils/adminTokens');

// Middleware de autenticación + control de acceso por rol (RBAC) para las
// cuentas de los locales (redención de bonos en /redimircodigordm). Solo
// acepta tokens emitidos por /api/local/login cuyo payload declare
// explícitamente role: "LOCAL". Separado de adminAuth: una cuenta de local
// no puede acceder a las rutas /api/admin.
function localAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const sesion = verificarToken(token);
    if (!sesion) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    if (sesion.role !== 'LOCAL') {
        return res.status(403).json({ success: false, error: 'Acceso prohibido: se requiere cuenta de local' });
    }

    req.local = sesion;
    return next();
}

module.exports = localAuth;
