const { verificarToken } = require('../utils/adminTokens');
const pool = require('../db');

// Autenticación para las rutas de la rifa (/api/admin/rifa/*): acepta el rol
// ADMIN (acceso total) y el rol RIFA (cuentas limitadas, p. ej. la persona de
// automatizaciones), que NO pasa por adminAuth y por lo tanto no puede usar
// ninguna otra ruta del panel de administración.
const ROLES_PERMITIDOS = new Set(['ADMIN', 'RIFA']);

async function rifaAuth(req, res, next) {
    const [tipo, token] = (req.headers.authorization || '').split(' ');
    if (tipo !== 'Bearer' || !token) return res.status(401).json({ success: false, error: 'No autorizado' });

    const sesion = verificarToken(token);
    if (!sesion) return res.status(401).json({ success: false, error: 'No autorizado' });
    if (!ROLES_PERMITIDOS.has(sesion.role)) {
        return res.status(403).json({ success: false, error: 'Acceso prohibido' });
    }
    try {
        const { rows } = await pool.query(
            'SELECT token_version, rol FROM admin_usuarios WHERE id = $1 AND activo = TRUE',
            [sesion.id]
        );
        // El rol se vuelve a leer de la base: si a la cuenta le quitan permisos,
        // sus tokens viejos dejan de servir.
        if (!rows.length || rows[0].token_version !== sesion.tv || (rows[0].rol || 'ADMIN') !== sesion.role) {
            return res.status(401).json({ success: false, error: 'Sesión inválida. Vuelve a iniciar sesión.' });
        }
    } catch (err) {
        console.error('rifaAuth:', err.message);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
    req.admin = sesion;
    return next();
}

module.exports = rifaAuth;
