require('dotenv').config();

const express = require('express');
const cors = require('cors');

const transaccionesRouter = require('./routes/transacciones');
const webhooksRouter = require('./routes/webhooks');
const pollaRouter = require('./routes/polla');
const adminRouter = require('./routes/admin');
const partidosRouter = require('./routes/partidos');
const { iniciarMonitorPartidos } = require('./services/notificacionesService');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/transacciones', transaccionesRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/polla', pollaRouter);
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
app.listen(PORT, () => {
    console.log(`Servidor de la Polla Mundialista corriendo en http://localhost:${PORT}`);
    iniciarMonitorPartidos();
});
