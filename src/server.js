require('dotenv').config();

const express = require('express');
const cors = require('cors');

const pool = require('./db');
const transaccionesRouter = require('./routes/transacciones');
const webhooksRouter = require('./routes/webhooks');
const pollaRouter = require('./routes/polla');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const partidosRouter = require('./routes/partidos');
const { iniciarMonitorPartidos } = require('./services/notificacionesService');
const { iniciarMonitorMarcadores } = require('./services/marcadoresService');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/transacciones', transaccionesRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/polla', pollaRouter);
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/partidos', partidosRouter);

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

    iniciarMonitorPartidos();
    iniciarMonitorMarcadores();
});
