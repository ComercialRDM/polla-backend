const express = require('express');
const multer = require('multer');
const pool = require('../db');

const router = express.Router();

const REDES_VALIDAS = ['instagram', 'tiktok', 'ambas'];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('La foto debe ser una imagen JPG, PNG o WEBP'));
        }
        cb(null, true);
    },
});

function normalizarCelular(celular) {
    return String(celular || '').replace(/[^0-9+]/g, '').trim();
}

// POST /api/influencers/registrar - formulario público para creadores de
// contenido. Solo guarda la solicitud; el bono se crea manualmente desde el
// panel admin (sección Influenciadores) reutilizando el flujo de Bonos
// Especiales ya existente. La foto es opcional, pero si se adjunta requiere
// autorización explícita de uso (se publica en el ranking de influencers).
router.post('/registrar', upload.single('foto'), async (req, res) => {
    const nombre = String(req.body.nombre || '').trim();
    const correo = String(req.body.correo || '').trim().toLowerCase();
    const celular = normalizarCelular(req.body.celular);
    const red_contenido = String(req.body.red_contenido || '').trim().toLowerCase();
    const autorizaFoto = req.body.autoriza_foto === 'true' || req.body.autoriza_foto === '1';

    if (!nombre) {
        return res.status(400).json({ success: false, error: 'Ingresa tu nombre completo' });
    }
    if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
        return res.status(400).json({ success: false, error: 'Ingresa un correo electrónico válido' });
    }
    if (!celular || celular.length < 7) {
        return res.status(400).json({ success: false, error: 'Ingresa un número de celular válido' });
    }
    if (!REDES_VALIDAS.includes(red_contenido)) {
        return res.status(400).json({ success: false, error: 'Selecciona en qué red creas contenido' });
    }
    if (req.file && !autorizaFoto) {
        return res.status(400).json({ success: false, error: 'Debes autorizar el uso de tu foto para poder subirla' });
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO influencer_registros (nombre, correo, celular, red_contenido, foto_imagen, foto_mime, autoriza_foto)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [nombre, correo, celular, red_contenido, req.file?.buffer || null, req.file?.mimetype || null, autorizaFoto]
        );
        return res.json({ success: true, id: rows[0].id });
    } catch (err) {
        console.error('Error en /influencers/registrar:', err);
        return res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = router;
