const nodemailer = require('nodemailer');

function crearTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

/**
 * Envía el correo con el bono adjunto, intentos disponibles y link de acceso a la polla.
 * @param {{ destinatario: string, nombre: string, saldoBono: number, intentos: number, tokenAcceso: string, bonoBuffer: Buffer }} datos
 */
async function enviarCorreoBono({ destinatario, nombre, saldoBono, intentos, tokenAcceso, bonoBuffer }) {
    const transporter = crearTransporter();
    const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${tokenAcceso}`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">¡Gracias por tu compra, ${nombre}!</h1>
        <p>Has recibido tu <strong>Bono Digital</strong> de <strong>$${saldoBono.toLocaleString('es-CO')}</strong> para servicios de La Retoucherie de Manuela.</p>
        <p>Además, ya quedaste inscrita en la <strong>Polla Mundialista</strong> con <strong>${intentos}</strong> intento(s) para predecir el marcador.</p>
        <p style="text-align: center; margin: 30px 0;">
            <a href="${linkPolla}" style="background: linear-gradient(90deg, #f59e0b, #f97316); color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Ir a la Polla
            </a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si el botón no funciona, copia y pega este link en tu navegador: ${linkPolla}</p>
        <p>¡Mucha suerte! 🇨🇴</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: '¡Tu Bono Digital y acceso a la Polla Mundialista! 🇨🇴',
        html,
        attachments: [
            {
                filename: 'bono-retoucherie.png',
                content: bonoBuffer,
                contentType: 'image/png',
            },
        ],
    });
}

/**
 * Notifica al administrador el pronóstico que un usuario acaba de registrar.
 * @param {{ nombre: string, correo: string, equipoLocal: string, equipoVisitante: string, local: number, visitante: number, fecha: Date }} datos
 */
async function enviarCorreoNotificacionVoto({ nombre, correo, equipoLocal, equipoVisitante, local, visitante, fecha }) {
    const transporter = crearTransporter();
    const destinatario = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
    const fechaTexto = fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h2 style="color: #f59e0b;">Nuevo pronóstico registrado</h2>
        <p><strong>${nombre}</strong> (${correo}) registró el siguiente pronóstico para <strong>${equipoLocal} vs ${equipoVisitante}</strong>:</p>
        <ul><li>${equipoLocal} ${local} - ${visitante} ${equipoVisitante}</li></ul>
        <p>Fecha y hora (Colombia): <strong>${fechaTexto}</strong></p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `Nuevo pronóstico: ${equipoLocal} vs ${equipoVisitante} - ${nombre}`,
        html,
    });
}

/**
 * Notifica a un participante de un partido anterior que ya puede comprar su bono
 * para el siguiente partido de la Selección Colombia.
 * @param {{ destinatario: string, nombre: string, equipoLocal: string, equipoVisitante: string, linkCompra: string }} datos
 */
async function enviarCorreoRecompra({ destinatario, nombre, equipoLocal, equipoVisitante, linkCompra }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">¡${nombre}, llegó el siguiente partido de Colombia! 🇨🇴</h1>
        <p><strong>${equipoLocal} vs ${equipoVisitante}</strong> ya está disponible en la Polla Mundialista de La Retoucherie de Manuela.</p>
        <p>Compra tu nuevo Bono Digital, recibe saldo para tus servicios de belleza y participa prediciendo el marcador para ganar premios.</p>
        <p style="text-align: center; margin: 30px 0;">
            <a href="${linkCompra}" style="background: linear-gradient(90deg, #f59e0b, #f97316); color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Comprar mi bono
            </a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si el botón no funciona, copia y pega este link en tu navegador: ${linkCompra}</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `¡${equipoLocal} vs ${equipoVisitante}! Compra tu bono y participa 🇨🇴`,
        html,
    });
}

/**
 * Envía el respaldo periódico de la base de datos (JSON comprimido) al correo
 * del administrador.
 * @param {{ destinatario: string, filename: string, buffer: Buffer, resumen: Record<string, number> }} datos
 */
async function enviarCorreoBackup({ destinatario, filename, buffer, resumen }) {
    const transporter = crearTransporter();
    const fechaTexto = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const filas = Object.entries(resumen)
        .map(([tabla, cantidad]) => `<li>${tabla}: ${cantidad} fila(s)</li>`)
        .join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h2 style="color: #f59e0b;">Respaldo automático de la base de datos</h2>
        <p>Generado: <strong>${fechaTexto}</strong> (Colombia)</p>
        <ul>${filas}</ul>
        <p>Adjunto encontrarás el archivo <strong>${filename}</strong> con el contenido completo (JSON comprimido).</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `Respaldo Polla Mundialista - ${fechaTexto}`,
        html,
        attachments: [
            {
                filename,
                content: buffer,
                contentType: 'application/gzip',
            },
        ],
    });
}

module.exports = { enviarCorreoBono, enviarCorreoNotificacionVoto, enviarCorreoRecompra, enviarCorreoBackup };
