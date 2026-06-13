function adminAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [tipo, token] = header.split(' ');

    if (tipo !== 'Bearer' || !token || token !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    next();
}

module.exports = adminAuth;
