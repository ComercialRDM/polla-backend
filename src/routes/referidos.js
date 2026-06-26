const express = require('express');
const { registrarClic } = require('../services/referidosService');

const router = express.Router();

function obtenerIp(req) {
    return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
}

// POST /api/referidos/clic - registra el clic en el link de un influencer y
// devuelve un token firmado para que el frontend lo guarde y lo reenvíe al
// momento de la compra. No requiere autenticación (es el primer contacto de
// un visitante anónimo con el sitio).
router.post('/clic', async (req, res) => {
    const codigoAfiliado = String(req.body.codigo_afiliado || '').trim();
    if (!codigoAfiliado) {
        return res.status(400).json({ success: false, error: 'Falta codigo_afiliado' });
    }

    try {
        const resultado = await registrarClic({
            codigoAfiliado,
            ip: obtenerIp(req),
            userAgent: req.headers['user-agent'],
            utmSource: req.body.utm_source,
            utmMedium: req.body.utm_medium,
            utmCampaign: req.body.utm_campaign,
        });

        if (!resultado) {
            // Código inexistente o inactivo: no es un error de cliente grave,
            // simplemente no hay nada que atribuir.
            return res.json({ success: false, error: 'Código de afiliado no encontrado' });
        }

        return res.json({ success: true, token: resultado.token });
    } catch (err) {
        console.error('Error en /referidos/clic:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
