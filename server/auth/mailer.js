import nodemailer from 'nodemailer';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** provider 'smtp' sends real email (Brevo, Resend, Gmail app password, SES...). 'console' prints to the server log: DEV ONLY. */
export function createMailer({ provider = 'console', from, smtp = {}, isProd = false, transport } = {}) {
  if (provider === 'console' && isProd) throw new Error('EMAIL_PROVIDER=console is not allowed in production. Configure SMTP.');
  let tx = transport;
  if (!tx && provider === 'smtp') {
    tx = nodemailer.createTransport({
      host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      requireTLS: !smtp.secure && isProd, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  }
  return {
    provider,
    async send({ to, subject, text, html }) {
      if (provider === 'console' && !transport) {
        console.log(`\n[email:dev-console] To: ${to}\nSubject: ${subject}\n${text}\n`);
        return { delivered: false, dev: true };
      }
      await tx.sendMail({ from, to, subject, text, html });
      return { delivered: true };
    },
  };
}

export function resetEmail({ name, link, minutes }) {
  const subject = 'Reset your InvestBrick password';
  const text = `Hi ${name},\n\nSomeone asked to reset the password for your InvestBrick account. To choose a new password, open this link within ${minutes} minutes:\n\n${link}\n\nIf you did not ask for this, ignore this email. Your password will not change.\n\nInvestBrick is a paper-trading learning tool. We will never ask for your password by email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0b1020">
<h2 style="margin:0 0 12px">Reset your password</h2>
<p>Hi ${esc(name)},</p>
<p>Someone asked to reset the password for your InvestBrick account. This link works for ${minutes} minutes and only once.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#5fe3f0;color:#04121a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
<p style="font-size:13px;color:#555">Or paste this into your browser:<br>${esc(link)}</p>
<p style="font-size:13px;color:#555">If you did not ask for this, ignore this email. Your password will not change.</p></div>`;
  return { subject, text, html };
}
