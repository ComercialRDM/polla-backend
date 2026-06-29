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
 * @param {{ destinatario: string, nombre: string, saldoBono: number, intentos: number, tokenAcceso: string, bonoBuffer: Buffer, esTest?: boolean, esEspecial?: boolean }} datos
 */
async function enviarCorreoBono({ destinatario, nombre, saldoBono, intentos, tokenAcceso, bonoBuffer, esTest, esEspecial }) {
    const transporter = crearTransporter();
    const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${tokenAcceso}`;

    const bannerTest = esTest
        ? `<div style="background: #fee2e2; color: #991b1b; font-weight: bold; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
               🧪 ESTE ES UN BONO DE PRUEBA — No representa dinero real y no es válido para redimir en tienda.
           </div>`
        : esEspecial
        ? `<div style="background: #fef3c7; color: #92400e; font-weight: bold; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
               🎖️ BONO ESPECIAL — Gracias por ser creador de contenido de La Retoucherie. Este bono SÍ es válido para redimir en tienda.
           </div>`
        : '';

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        ${bannerTest}
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
        subject: esTest
            ? '🧪 [PRUEBA] Tu Bono Digital y acceso a la Polla Mundialista'
            : esEspecial
            ? '🎖️ Tu Bono Especial de Creador de Contenido'
            : '¡Tu Bono Digital y acceso a la Polla Mundialista! 🇨🇴',
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
 * Correo personalizado al cerrar un partido: le cuenta a cada participante su
 * propio resultado (en vez del aviso genérico de "inicio de partido"/"gol" que
 * antes se mandaba por WhatsApp) y lo invita a comprar más cupos — reemplaza
 * esas notificaciones con algo que sí motiva la recompra, a costo de correo
 * (casi gratis) en vez de SMS (caro a esta escala).
 * @param {{ destinatario: string, nombre: string, equipoLocal: string, equipoVisitante: string, golesLocal: number, golesVisitante: number, prediccionLocal: number, prediccionVisitante: number, puntosGanados: number, cuposDisponibles: number, proximoPartido?: { equipoLocal: string, equipoVisitante: string }, linkCompra: string }} datos
 */
async function enviarCorreoResultadoPartido({
    destinatario, nombre, equipoLocal, equipoVisitante, golesLocal, golesVisitante,
    prediccionLocal, prediccionVisitante, puntosGanados, cuposDisponibles, proximoPartido, linkCompra,
}) {
    const transporter = crearTransporter();

    const acertoExacto = puntosGanados > 0 && prediccionLocal === golesLocal && prediccionVisitante === golesVisitante;
    const resultadoTexto = puntosGanados === 0
        ? 'Esta vez no acertaste, ¡pero el Mundial sigue!'
        : acertoExacto
            ? `¡Le pegaste exacto y ganaste ${puntosGanados} puntos! 🎯`
            : `Acertaste la tendencia y ganaste ${puntosGanados} puntos.`;

    const proximoHtml = proximoPartido
        ? `<p><strong>${proximoPartido.equipoLocal} vs ${proximoPartido.equipoVisitante}</strong> es el siguiente partido disponible en la Polla.</p>`
        : '';

    const cuposHtml = cuposDisponibles > 0
        ? `<p>Todavía te quedan <strong>${cuposDisponibles} cupo(s)</strong> sin usar para seguir pronosticando.</p>`
        : `<p>Ya usaste todos tus cupos — compra un nuevo bono para seguir participando.</p>`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">${equipoLocal} ${golesLocal} - ${golesVisitante} ${equipoVisitante}</h1>
        <p>Hola ${nombre}, tu pronóstico fue <strong>${prediccionLocal} - ${prediccionVisitante}</strong>. ${resultadoTexto}</p>
        ${cuposHtml}
        ${proximoHtml}
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
        subject: `${equipoLocal} ${golesLocal}-${golesVisitante} ${equipoVisitante} — así te fue en la Polla`,
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

/**
 * Envía el código OTP de recuperación de contraseña al correo del usuario.
 */
async function enviarCorreoResetPassword({ destinatario, nombre, codigo, vigenciaMin }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🔐 Recuperar contraseña</h1>
        <p>Hola <strong>${nombre}</strong>,</p>
        <p>Tu código para reestablecer la contraseña de la <strong>Polla Mundialista de La Retoucherie</strong> es:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #18181b; background: #FCD116; padding: 16px 32px; border-radius: 12px;">
                ${codigo}
            </span>
        </div>
        <p>Este código vence en <strong>${vigenciaMin} minutos</strong>. Si no solicitaste este cambio, ignora este correo.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">La Retoucherie de Manuela · GanaConRetoucherie</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `${codigo} — Tu código de recuperación · La Retoucherie`,
        html,
    });
}

/**
 * Notifica a un ganador del Bono Colombia $1M que acertó el marcador exacto.
 */
async function enviarCorreoBonoColWinner({ destinatario, nombre, partido, monto }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🇨🇴 ¡Felicitaciones, ${nombre}!</h1>
        <p>Acertaste el <strong>marcador exacto</strong> del partido <strong>${partido}</strong>.</p>
        <p>¡Has ganado el <strong>Bono Colombia</strong> por valor de
           <strong style="color: #f59e0b;">$${monto.toLocaleString('es-CO')} COP</strong>
           en Gift Card!</p>
        <p>Nuestro equipo se comunicará contigo a la brevedad para coordinar la entrega.
           Recuerda tener a mano tu documento de identidad.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">
            La Retoucherie de Manuela · GanaConRetoucherie
        </p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: '🇨🇴 ¡Ganaste el Bono Colombia! — La Retoucherie',
        html,
    });
}

/**
 * Envía una contraseña temporal a la cuenta de un local (Admin QR).
 */
async function enviarCorreoResetLocalPassword({ destinatario, nombre, tempPass }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🔑 Contraseña temporal — Admin QR</h1>
        <p>Hola <strong>${nombre || 'Administrador'}</strong>,</p>
        <p>Se ha generado una contraseña temporal para tu cuenta de <strong>Admin QR</strong> en La Retoucherie de Manuela:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #18181b; background: #FCD116; padding: 16px 32px; border-radius: 12px; font-family: monospace;">
                ${tempPass}
            </span>
        </div>
        <p>Usa esta contraseña para ingresar. Por seguridad, pídele al administrador que la actualice pronto.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">La Retoucherie de Manuela · Admin QR</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `🔑 Tu contraseña temporal — Admin QR La Retoucherie`,
        html,
    });
}

module.exports = { enviarCorreoBono, enviarCorreoNotificacionVoto, enviarCorreoRecompra, enviarCorreoResultadoPartido, enviarCorreoBackup, enviarCorreoResetPassword, enviarCorreoBonoColWinner, enviarCorreoResetLocalPassword };
