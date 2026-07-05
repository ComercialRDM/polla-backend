const express = require('express');
const multer = require('multer');
const pool = require('../db');
const adminAuth = require('../middleware/adminAuth');

const uploadLogo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            return cb(new Error('Solo se permiten imágenes JPG, PNG o WebP'));
        }
        cb(null, true);
    },
});

const REGISTRO_TOKEN = process.env.MARCAS_REGISTRO_TOKEN || 'rdm-marcas-2026-xk9p';

// Auto-migración: crea la tabla si no existe al arrancar el servidor
pool.query(`
    CREATE TABLE IF NOT EXISTS marcas_participantes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(120) NOT NULL,
        logo_imagen BYTEA,
        logo_mime VARCHAR(50),
        contacto VARCHAR(200),
        status VARCHAR(20) NOT NULL DEFAULT 'pendiente',
        origen VARCHAR(20) DEFAULT 'admin',
        fecha_creacion TIMESTAMPTZ DEFAULT NOW(),
        fecha_actualizacion TIMESTAMPTZ DEFAULT NOW()
    )
`).catch((err) => console.error('[marcas] Error creando tabla:', err.message));

// ── Router admin (/api/admin/marcas) ─────────────────────────────────────────
const adminRouter = express.Router();

// GET /api/admin/marcas — lista todas las marcas
adminRouter.get('/', adminAuth, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, nombre, contacto, status, origen, fecha_creacion,
                    (logo_imagen IS NOT NULL) AS tiene_logo
             FROM marcas_participantes ORDER BY fecha_creacion DESC`
        );
        res.json({ success: true, marcas: rows });
    } catch (err) {
        console.error('[GET /admin/marcas]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// GET /api/admin/marcas/:id/logo — sirve el binario del logo
adminRouter.get('/:id/logo', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT logo_imagen, logo_mime FROM marcas_participantes WHERE id = $1',
            [req.params.id]
        );
        if (!rows.length || !rows[0].logo_imagen) {
            return res.status(404).json({ success: false, error: 'Logo no encontrado' });
        }
        res.set('Content-Type', rows[0].logo_mime || 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(rows[0].logo_imagen);
    } catch (err) {
        console.error('[GET /admin/marcas/:id/logo]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/admin/marcas — crear marca (admin)
adminRouter.post('/', adminAuth, uploadLogo.single('logo'), async (req, res) => {
    const { nombre, contacto, status = 'pendiente' } = req.body;
    if (!nombre?.trim()) {
        return res.status(400).json({ success: false, error: 'El nombre es obligatorio' });
    }
    try {
        const { rows } = await pool.query(
            `INSERT INTO marcas_participantes (nombre, logo_imagen, logo_mime, contacto, status, origen)
             VALUES ($1, $2, $3, $4, $5, 'admin')
             RETURNING id, nombre, contacto, status, origen, fecha_creacion,
                       (logo_imagen IS NOT NULL) AS tiene_logo`,
            [
                nombre.trim(),
                req.file ? req.file.buffer : null,
                req.file ? req.file.mimetype : null,
                contacto?.trim() || null,
                status,
            ]
        );
        res.json({ success: true, marca: rows[0] });
    } catch (err) {
        console.error('[POST /admin/marcas]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// PATCH /api/admin/marcas/:id — editar marca (acepta logo opcional)
adminRouter.patch('/:id', adminAuth, uploadLogo.single('logo'), async (req, res) => {
    const { nombre, contacto, status } = req.body;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        let query, params;
        if (req.file) {
            query = `UPDATE marcas_participantes
                     SET nombre = COALESCE($1, nombre),
                         logo_imagen = $2, logo_mime = $3,
                         contacto = COALESCE($4, contacto),
                         status = COALESCE($5, status),
                         fecha_actualizacion = NOW()
                     WHERE id = $6
                     RETURNING id, nombre, contacto, status, origen, fecha_creacion,
                               (logo_imagen IS NOT NULL) AS tiene_logo`;
            params = [nombre?.trim() || null, req.file.buffer, req.file.mimetype, contacto?.trim() || null, status || null, id];
        } else {
            query = `UPDATE marcas_participantes
                     SET nombre = COALESCE($1, nombre),
                         contacto = COALESCE($2, contacto),
                         status = COALESCE($3, status),
                         fecha_actualizacion = NOW()
                     WHERE id = $4
                     RETURNING id, nombre, contacto, status, origen, fecha_creacion,
                               (logo_imagen IS NOT NULL) AS tiene_logo`;
            params = [nombre?.trim() || null, contacto?.trim() || null, status || null, id];
        }
        const { rows } = await pool.query(query, params);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Marca no encontrada' });
        res.json({ success: true, marca: rows[0] });
    } catch (err) {
        console.error('[PATCH /admin/marcas/:id]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// DELETE /api/admin/marcas/:id
adminRouter.delete('/:id', adminAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });
    try {
        await pool.query('DELETE FROM marcas_participantes WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('[DELETE /admin/marcas/:id]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// ── Router público (/api/marcas) ──────────────────────────────────────────────
const publicRouter = express.Router();

// GET /api/marcas/publicas — marcas activas para el componente de clientes
publicRouter.get('/publicas', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, nombre, (logo_imagen IS NOT NULL) AS tiene_logo
             FROM marcas_participantes WHERE status = 'activa' ORDER BY nombre`
        );
        res.json({ success: true, marcas: rows });
    } catch (err) {
        console.error('[GET /marcas/publicas]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

// POST /api/marcas/registro?token=X — inscripción externa de una marca
publicRouter.post('/registro', uploadLogo.single('logo'), async (req, res) => {
    const { token } = req.query;
    if (!token || token !== REGISTRO_TOKEN) {
        return res.status(403).json({ success: false, error: 'Enlace de registro inválido o expirado' });
    }
    const { nombre, contacto } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ success: false, error: 'El nombre de la marca es obligatorio' });
    if (!contacto?.trim()) return res.status(400).json({ success: false, error: 'El contacto es obligatorio' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO marcas_participantes (nombre, logo_imagen, logo_mime, contacto, status, origen)
             VALUES ($1, $2, $3, $4, 'pendiente', 'registro')
             RETURNING id`,
            [nombre.trim(), req.file ? req.file.buffer : null, req.file ? req.file.mimetype : null, contacto.trim()]
        );
        res.json({ success: true, id: rows[0].id });
    } catch (err) {
        console.error('[POST /marcas/registro]', err.message);
        res.status(500).json({ success: false, error: 'Error interno' });
    }
});

module.exports = { adminRouter, publicRouter };
