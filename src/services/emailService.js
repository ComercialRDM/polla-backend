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

module.exports = { enviarCorreoBono };
