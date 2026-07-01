const { RekognitionClient, DetectModerationLabelsCommand } = require('@aws-sdk/client-rekognition');

// Solo se inicializa si las credenciales están configuradas.
// Sin ellas, checkearFoto() devuelve null y el flujo cae a cola manual.
function crearCliente() {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) return null;
    return new RekognitionClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    });
}

const UMBRAL_CONFIANZA = 80; // % mínimo para considerar un label como positivo

// Labels que disparan rechazo automático (sin revisión manual)
const LABELS_RECHAZO_AUTO = new Set([
    'Explicit Nudity',
    'Nudity',
    'Graphic Male Nudity',
    'Graphic Female Nudity',
    'Sexual Activity',
    'Illustrated Explicit Nudity',
    'Adult Toys',
    'Violence',
    'Graphic Violence Or Gore',
    'Physical Violence',
    'Weapon Violence',
    'Weapons',
    'Self Injury',
    'Hate Symbols',
    'Nazi Party',
    'White Supremacy',
    'Extremist',
]);

/**
 * Analiza una imagen con AWS Rekognition.
 * @param {Buffer} imageBuffer - Bytes de la imagen
 * @returns {{ rechazar: boolean, aprobar: boolean, razon: string | null } | null}
 *   null     = Rekognition no está configurado o falló → usar cola manual
 *   rechazar = contenido inapropiado detectado → auto-rechazar
 *   aprobar  = Rekognition no encontró nada malo → auto-aprobar sin revisión manual
 */
async function checkearFoto(imageBuffer) {
    const client = crearCliente();
    if (!client) return null;

    try {
        const command = new DetectModerationLabelsCommand({
            Image: { Bytes: imageBuffer },
            MinConfidence: UMBRAL_CONFIANZA,
        });
        const response = await client.send(command);
        const labels = response.ModerationLabels || [];

        const labelMalo = labels.find(
            (l) => LABELS_RECHAZO_AUTO.has(l.Name) || LABELS_RECHAZO_AUTO.has(l.ParentName)
        );

        if (labelMalo) {
            return {
                rechazar: true,
                aprobar: false,
                razon: 'La foto fue rechazada automáticamente por contener contenido inapropiado.',
            };
        }

        // Rekognition analizó la foto y no encontró nada malo → aprobar directo
        return { rechazar: false, aprobar: true, razon: null };
    } catch (err) {
        // Si Rekognition falla, cae a cola manual sin bloquear al usuario
        console.error('Rekognition error (fallback a manual):', err.message);
        return null;
    }
}

module.exports = { checkearFoto };
