const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'bono_template.jpg');

// Tamaño del template (placeholder generado si no existe el archivo)
const ANCHO = 1748;
const ALTO = 1240;

// --- Coordenadas fácilmente calibrables del overlay ---
// Calibradas para la plantilla "Bono Digital" (placeholders "$(VALOR)" y "(nombre)")
const COORD = {
    valor: { x: 890, y: 704, fontSize: 140, color: '#1a1a1a' },
    nombre: { x: 900, y: 1076, fontSize: 45, color: '#1a1a1a' },
};

// Rectángulos para tapar el texto placeholder de la plantilla antes de escribir el valor real
const COVER = {
    valor: { x: 480, y: 545, w: 820, h: 220, color: '#F3EAE1' },
    nombre: { x: 700, y: 1035, w: 400, h: 50, color: '#FEE580' },
    vigencia: { x: 350, y: 1108, w: 1060, h: 125, color: '#F4EBE2' },
    sedes: { x: 330, y: 838, w: 945, h: 152, color: '#FEE580' },
};

// Texto de vigencia y sedes (tapa y reemplaza el texto fijo de la plantilla)
const VIGENCIA_TEXTO_1 = '*Válido hasta el 1 de marzo de 2027 - 6:00 p.m.';
const VIGENCIA_TEXTO_2 = 'Sedes en Barranquilla y Cartagena';
const SEDES_TEXTO_1 = 'Preséntalo en cualquiera de nuestras';
const SEDES_TEXTO_2 = 'sedes en Barranquilla o Cartagena';

// Código QR (token de acceso del bono) en la esquina inferior derecha, para que
// el local lo escanee y marque el bono como consumido
const QR = { x: ANCHO - 240, y: ALTO - 240, size: 200, padding: 10 };

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
 * @param {{ nombre: string, saldoBono: number, tokenAcceso: string }} datos
 * @returns {Promise<Buffer>}
 */
async function generarImagenBono({ nombre, saldoBono, tokenAcceso }) {
    await asegurarTemplate();

    // La plantilla ya imprime el símbolo "$" y los paréntesis "(VALOR)", solo se reemplaza el número
    const valorFormateado = saldoBono.toLocaleString('es-CO');

    // Reduce el tamaño de letra del nombre si es muy largo para que no se salga del recuadro
    const nombreFontSize = nombre.length > 22 ? 32 : COORD.nombre.fontSize;

    const overlaySvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${COVER.valor.x}" y="${COVER.valor.y}" width="${COVER.valor.w}" height="${COVER.valor.h}" fill="${COVER.valor.color}"/>
        <rect x="${COVER.nombre.x}" y="${COVER.nombre.y}" width="${COVER.nombre.w}" height="${COVER.nombre.h}" fill="${COVER.nombre.color}"/>
        <rect x="${COVER.vigencia.x}" y="${COVER.vigencia.y}" width="${COVER.vigencia.w}" height="${COVER.vigencia.h}" fill="${COVER.vigencia.color}"/>
        <rect x="${COVER.sedes.x}" y="${COVER.sedes.y}" width="${COVER.sedes.w}" height="${COVER.sedes.h}" fill="${COVER.sedes.color}"/>
        <text x="${COORD.valor.x}" y="${COORD.valor.y}" font-family="Georgia, 'Times New Roman', serif" font-size="${COORD.valor.fontSize}" font-weight="bold" fill="${COORD.valor.color}" text-anchor="middle">${valorFormateado}</text>
        <text x="${COORD.nombre.x}" y="${COORD.nombre.y}" font-family="Arial" font-size="${nombreFontSize}" font-weight="bold" fill="${COORD.nombre.color}" text-anchor="middle">${escapeXml(nombre)}</text>
        <text x="${ANCHO / 2}" y="885" font-family="Arial" font-size="38" fill="#1a1a1a" text-anchor="middle">${escapeXml(SEDES_TEXTO_1)}</text>
        <text x="${ANCHO / 2}" y="940" font-family="Arial" font-size="38" fill="#1a1a1a" text-anchor="middle">${escapeXml(SEDES_TEXTO_2)}</text>
        <text x="${ANCHO / 2}" y="1150" font-family="Arial" font-size="38" fill="#1a1a1a" text-anchor="middle">${escapeXml(VIGENCIA_TEXTO_1)}</text>
        <text x="${ANCHO / 2}" y="1200" font-family="Arial" font-size="38" fill="#1a1a1a" text-anchor="middle">${escapeXml(VIGENCIA_TEXTO_2)}</text>
    </svg>`;

    const composite = [{ input: Buffer.from(overlaySvg), top: 0, left: 0 }];

    if (tokenAcceso) {
        const qrBuffer = await QRCode.toBuffer(tokenAcceso, {
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
