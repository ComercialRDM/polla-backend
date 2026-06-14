require('dotenv').config();

const Sentry = require('./instrument');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const pool = require('./db');
const transaccionesRouter = require('./routes/transacciones');
const webhooksRouter = require('./routes/webhooks');
const pollaRouter = require('./routes/polla');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const partidosRouter = require('./routes/partidos');
const { authLimiter, adminLimiter } = require('./middleware/rateLimiters');
const { iniciarMonitorPartidos } = require('./services/notificacionesService');
const { iniciarMonitorMarcadores } = require('./services/marcadoresService');

const app = express();

// Orígenes permitidos para CORS (separados por coma). Si no se define, permite todos
// los orígenes (modo permisivo de respaldo, pero se recomienda configurar FRONTEND_URL).
const origenesPermitidos = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origen) => origen.trim())
    .filter(Boolean);

if (origenesPermitidos.length === 0) {
    console.warn('FRONTEND_URL no está configurado: CORS permitirá cualquier origen.');
}

// CSP no aplica a una API que solo devuelve JSON/imágenes; se desactiva para evitar
// interferencias. Se permite que /api/polla/bono/:token (imagen del bono) se cargue
// desde el frontend (otro origen) y desde WhatsApp/ManyChat.
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({
    origin: origenesPermitidos.length > 0 ? origenesPermitidos : true,
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMPORAL: para verificar que Sentry recibe errores del backend. Quitar después de probar.
app.get('/debug-sentry', () => {
    throw new Error('Prueba Sentry backend');
});

app.use('/api/transacciones', transaccionesRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/polla', pollaRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/admin', adminLimiter, adminRouter);
app.use('/api/partidos', partidosRouter);

// Reporta a Sentry los errores no controlados que lleguen hasta aquí
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// Manejo de errores de subida de archivos (multer) y otros errores no controlados
app.use((err, req, res, next) => {
    if (err) {
        console.error('Error no controlado:', err.message);
        return res.status(400).json({ success: false, error: err.message || 'Error procesando la solicitud' });
    }
    next();
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`Servidor de la Polla Mundialista corriendo en http://localhost:${PORT}`);

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS equipos_favoritos TEXT[] NOT NULL DEFAULT '{}'`);
    } catch (err) {
        console.error('Error aplicando migración de equipos_favoritos:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash TEXT`);
        await pool.query(`ALTER TABLE usuarios ALTER COLUMN correo DROP NOT NULL`);
    } catch (err) {
        console.error('Error aplicando migración de password_hash:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code VARCHAR(6)`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_code_expira TIMESTAMPTZ`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_intentos INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
        console.error('Error aplicando migración de reset_code:', err.message);
    }

    iniciarMonitorPartidos();
    iniciarMonitorMarcadores();
});
