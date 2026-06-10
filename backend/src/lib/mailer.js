// Minimal fail-soft mailer (invite delivery). Disabled unless SMTP env is present, and
// sendInviteEmail NEVER throws — invite creation must succeed even when email cannot be sent
// (the dashboard falls back to the copy-link flow). Env (see .env.example):
//   SMTP_HOST, SMTP_PORT (default 587; 465 => TLS), SMTP_USER, SMTP_PASS, MAIL_FROM
// Works with any SMTP provider — typically the same Resend/SES credentials configured for
// Supabase's own auth emails.
const ROLE_LABELS = {
  physician: 'แพทย์อาสา / Physician',
  auditor: 'ผู้ตรวจประเมิน / Auditor',
};

let _transport = null;

// Read env at CALL time (not module load) so tests and config reloads behave.
// RESEND_API_KEY (HTTPS) is preferred over SMTP: Railway's egress drops outbound SMTP
// connections (observed: 10s connection timeouts to smtp.resend.com:465 while HTTPS
// egress works), so the provider API is the reliable path in prod.
function isMailerEnabled() {
  return Boolean((process.env.RESEND_API_KEY || process.env.SMTP_HOST) && process.env.MAIL_FROM);
}

function getTransport() {
  if (_transport) return _transport;
  const nodemailer = require('nodemailer'); // lazy: dep only needed when the mailer is enabled
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,   // nodemailer's default is 30s — a blackholed SMTP greeting must not hold the invite response
    socketTimeout: 10_000,
  });
  return _transport;
}

function _resetTransport() { _transport = null; } // tests

// → Promise<boolean>. True only when the SMTP server accepted the message.
async function sendInviteEmail({ to, acceptUrl, role, councilNameTh, councilNameEn, expiresAt }) {
  if (!isMailerEnabled()) return false;
  const roleLabel = ROLE_LABELS[role] || role;
  const council = [councilNameTh, councilNameEn].filter(Boolean).join(' / ') || '-';
  const expiry = expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : '';
  const subject = `คำเชิญเข้าใช้งาน CLICS / Your CLICS invitation (${roleLabel})`;
  const text = [
    `คุณได้รับเชิญให้เข้าใช้งานระบบ CLICS ในบทบาท ${roleLabel}`,
    `สภาวิชาชีพ: ${council}`,
    `เปิดลิงก์นี้เพื่อยืนยันตัวตนและเริ่มใช้งาน (หมดอายุ ${expiry}):`,
    acceptUrl,
    ``,
    `You have been invited to CLICS as ${roleLabel} (council: ${council}).`,
    `Open this link to verify your identity and activate your account (expires ${expiry}):`,
    acceptUrl,
  ].join('\n');
  const html = [
    `<p>คุณได้รับเชิญให้เข้าใช้งานระบบ <strong>CLICS</strong> ในบทบาท <strong>${roleLabel}</strong><br/>สภาวิชาชีพ: ${council}</p>`,
    `<p>You have been invited to <strong>CLICS</strong> as <strong>${roleLabel}</strong> (council: ${council}).</p>`,
    `<p><a href="${acceptUrl}">ยืนยันตัวตนและเริ่มใช้งาน / Accept your invitation</a> (expires ${expiry})</p>`,
    `<p style="color:#666;font-size:12px">${acceptUrl}</p>`,
  ].join('\n');
  try {
    const message = { from: process.env.MAIL_FROM, to, subject, text, html };
    if (process.env.RESEND_API_KEY) await sendViaResendApi(message);
    else await getTransport().sendMail(message);
    return true;
  } catch (e) {
    console.error('[mailer] invite email failed:', e.message);
    return false;
  }
}

async function sendViaResendApi({ from, to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

module.exports = { isMailerEnabled, sendInviteEmail, _resetTransport };
