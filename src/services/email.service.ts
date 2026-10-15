import { Resend } from "resend";

const FROM_ADDRESS = process.env.EMAIL_FROM || "Nicole Pastry Arts <app@nicole.com.ec>";

export class EmailService {
  private resend: Resend;

  constructor() {
    this.resend = new Resend(process.env.RESEND_API_KEY);
  }

  /**
   * Envía el correo de recuperación de contraseña con el link de reset.
   */
  async sendPasswordResetEmail(to: string, userName: string, resetUrl: string) {
    const html = `
<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background-color:#faf7f2;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf7f2;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:40px;box-shadow:0 4px 12px rgba(124,58,237,0.08);">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <h1 style="margin:0;color:#7c3aed;font-size:22px;">Nicole Pastry Arts</h1>
              <p style="margin:4px 0 0;color:#9ca3af;font-size:13px;">Sistema de Pedidos</p>
            </td>
          </tr>
          <tr>
            <td style="color:#374151;font-size:15px;line-height:1.6;">
              <p>Hola${userName ? ` <strong>${userName}</strong>` : ""},</p>
              <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el botón para crear una nueva:</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 0;">
              <a href="${resetUrl}" style="background:#7c3aed;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:bold;font-size:15px;display:inline-block;">
                Restablecer contraseña
              </a>
            </td>
          </tr>
          <tr>
            <td style="color:#6b7280;font-size:13px;line-height:1.6;">
              <p>Este enlace es válido por <strong>1 hora</strong>. Si no solicitaste este cambio, puedes ignorar este correo — tu contraseña seguirá siendo la misma.</p>
              <p style="margin-bottom:0;">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
              <a href="${resetUrl}" style="color:#7c3aed;word-break:break-all;">${resetUrl}</a></p>
            </td>
          </tr>
        </table>
        <p style="color:#9ca3af;font-size:12px;margin-top:16px;">© Nicole Pastry Arts · app.nicole.com.ec</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const { data, error } = await this.resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject: "Restablece tu contraseña — Nicole Pastry Arts",
      html,
    });

    if (error) {
      console.error("❌ Error enviando email de reset:", error);
      throw new Error("EMAIL_SEND_FAILED");
    }

    return data;
  }

  /**
   * Correo genérico con la plantilla de la marca. `bodyHtml` va dentro de la
   * tarjeta; `cta` agrega el botón. No lanza: devuelve false si Resend falla,
   * para que un correo caído no tumbe el flujo que lo dispara.
   */
  async sendBranded(params: {
    to: string | string[];
    subject: string;
    bodyHtml: string;
    cta?: { label: string; url: string };
    attachments?: Array<{ filename: string; content: Buffer }>;
  }): Promise<boolean> {
    const recipients = (Array.isArray(params.to) ? params.to : [params.to]).filter(Boolean);
    if (!recipients.length || !process.env.RESEND_API_KEY) return false;

    const button = params.cta
      ? `<tr><td align="center" style="padding:24px 0 8px;">
          <a href="${params.cta.url}" style="background:#7c3aed;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:bold;font-size:15px;display:inline-block;">${params.cta.label}</a>
        </td></tr>`
      : "";

    const html = `
<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:0;background-color:#faf7f2;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf7f2;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:40px;box-shadow:0 4px 12px rgba(124,58,237,0.08);">
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <h1 style="margin:0;color:#7c3aed;font-size:22px;">Nicole Pastry Arts</h1>
            </td>
          </tr>
          <tr><td style="color:#374151;font-size:15px;line-height:1.6;">${params.bodyHtml}</td></tr>
          ${button}
        </table>
        <p style="color:#9ca3af;font-size:12px;margin-top:16px;">© Nicole Pastry Arts</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    try {
      const { error } = await this.resend.emails.send({
        from: FROM_ADDRESS,
        to: recipients,
        subject: params.subject,
        html,
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
      });
      if (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
      }
      return true;
    } catch (err) {
      console.error("❌ Error enviando correo:", err);
      return false;
    }
  }
}

/** Escapa texto que viene de usuarios antes de meterlo en un HTML de correo. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
