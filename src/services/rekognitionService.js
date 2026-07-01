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
 * @returns {{ rechazar: boolean, razon: string | null } | null}
 *   null = Rekognition no está configurado (usar cola manual)
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

        const labelEncontrado = labels.find(
            (l) => LABELS_RECHAZO_AUTO.has(l.Name) || LABELS_RECHAZO_AUTO.has(l.ParentName)
        );

        if (labelEncontrado) {
            return {
                rechazar: true,
                razon: 'La foto fue rechazada automáticamente por contener contenido inapropiado.',
            };
        }

        return { rechazar: false, razon: null };
    } catch (err) {
        // Si Rekognition falla, no bloqueamos al usuario — cae a cola manual
        console.error('Rekognition error (fallback a manual):', err.message);
        return null;
    }
}

module.exports = { checkearFoto };
