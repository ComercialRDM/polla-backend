const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'Bono_template.png');

// Tamaño real de la plantilla (1191×896 px)
const ANCHO = 1191;
const ALTO  = 896;

// --- Coordenadas calibradas para la plantilla "Bono Digital" negra/amarilla ---
// Valor numérico: va dentro del espacio "VÁLIDO POR $(  )" de la plantilla
const COORD = {
    valor:  { x: 400, y: 452, fontSize: 88, color: '#ffffff' },
    nombre: { x: 430, y: 828, fontSize: 40, color: '#1a1a1a' },
};

// Código QR: caja blanca en la zona derecha de la plantilla, DEBAJO del logo Retoucherie
// y:335 evita superposición con el logo (que termina aprox. en y:295)
const QR = { x: 762, y: 338, size: 308, padding: 14 };

/**
 * Genera (si no existe) un template placeholder para el bono.
 */
async function asegurarTemplate() {
    if (fs.existsSync(TEMPLATE_PATH)) return;

    const placeholderSvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#fde047"/>
        <rect x="20" y="20" width="${ANCHO - 40}" height="${ALTO - 40}" fill="none" stroke="#18181b" stroke-width="8"/>
        <text x="${ANCHO / 2}" y="120" font-family="Arial" font-size="60" font-weight="bold" fill="#18181b" text-anchor="middle">LA RETOUCHERIE DE MANUELA</text>
        <text x="${ANCHO / 2}" y="190" font-family="Arial" font-size="36" fill="#18181b" text-anchor="middle">BONO DIGITAL - POLLA MUNDIALISTA</text>
    </svg>`;

    await sharp(Buffer.from(placeholderSvg)).jpeg({ quality: 90 }).toFile(TEMPLATE_PATH);
}

/**
 * Genera la imagen del bono (PNG) con el valor, el nombre del cliente y un código QR
 * (token de acceso) incrustados. El QR lo escanea el local para marcar el bono como usado.
 * @param {{ nombre: string, saldoBono: number, tokenAcceso: string, esTest?: boolean }} datos
 * @returns {Promise<Buffer>}
 */
async function generarImagenBono({ nombre, saldoBono, tokenAcceso, esTest }) {
    await asegurarTemplate();

    // La plantilla ya imprime el símbolo "$" y los paréntesis "(VALOR)", solo se reemplaza el número
    const valorFormateado = saldoBono.toLocaleString('es-CO');

    // Reduce el tamaño de letra del nombre si es muy largo para que no se salga del recuadro
    const nombreFontSize = nombre.length > 22 ? 32 : COORD.nombre.fontSize;

    const overlaySvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <text x="${COORD.valor.x}" y="${COORD.valor.y}" font-family="Georgia, 'Times New Roman', serif" font-size="${COORD.valor.fontSize}" font-weight="bold" fill="${COORD.valor.color}" text-anchor="middle">${valorFormateado}</text>
        <text x="${COORD.nombre.x}" y="${COORD.nombre.y}" font-family="Arial" font-size="${nombreFontSize}" font-weight="bold" fill="${COORD.nombre.color}" text-anchor="middle">${escapeXml(nombre)}</text>
        ${esTest ? `
        <g transform="rotate(-25 ${ANCHO / 2} ${ALTO / 2})">
            <rect x="${ANCHO / 2 - 520}" y="${ALTO / 2 - 70}" width="1040" height="140" fill="#dc2626" opacity="0.85"/>
            <text x="${ANCHO / 2}" y="${ALTO / 2 + 30}" font-family="Arial" font-size="90" font-weight="bold" fill="#ffffff" text-anchor="middle">PRUEBA - NO VÁLIDO</text>
        </g>` : ''}
    </svg>`;

    const composite = [{ input: Buffer.from(overlaySvg), top: 0, left: 0 }];

    if (tokenAcceso) {
        const qrContenido = process.env.FRONTEND_URL
            ? `${process.env.FRONTEND_URL}/adminqr?token=${tokenAcceso}`
            : tokenAcceso;
        const qrBuffer = await QRCode.toBuffer(qrContenido, {
            type: 'png',
            width: QR.size - QR.padding * 2,
            margin: 0,
            color: { dark: '#1a1a1a', light: '#ffffff' },
        });

        // Fondo blanco con borde para que el QR resalte sobre la plantilla
        const fondoQrSvg = `
        <svg width="${QR.size}" height="${QR.size}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" rx="12" fill="#ffffff" stroke="#1a1a1a" stroke-width="2"/>
        </svg>`;

        composite.push({ input: Buffer.from(fondoQrSvg), top: QR.y, left: QR.x });
        composite.push({ input: qrBuffer, top: QR.y + QR.padding, left: QR.x + QR.padding });
    }

    const buffer = await sharp(TEMPLATE_PATH)
        .resize(ANCHO, ALTO)
        .composite(composite)
        .png()
        .toBuffer();

    return buffer;
}

function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
}

module.exports = { generarImagenBono };
