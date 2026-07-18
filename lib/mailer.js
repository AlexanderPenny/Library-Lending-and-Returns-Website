//    Copyright 2026 Alexander L. Penny

//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at

//        http://www.apache.org/licenses/LICENSE-2.0

//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

/**
 * Email sending via SMTP (configured for Brevo, but any SMTP works).
 * Reads config from environment. If SMTP isn't configured, it degrades
 * gracefully: the message (including any verification link) is written to
 * logs/mail.log and the console, so the flow still works while you set up DNS.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const MAIL_LOG = process.env.MAIL_LOG || path.join(__dirname, '..', 'logs', 'mail.log');

// Config is read lazily (on first send), NOT at import time — server.js loads
// .env after requiring this module, so reading it here too early would miss it.
function LIBRARY_NAME() { return process.env.LIBRARY_NAME || 'Lending Library'; }

function cfg() {
  return {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'library@localhost',
    fromName: process.env.MAIL_FROM_NAME || LIBRARY_NAME(),
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.host && c.port && c.user && c.pass);
}

let _transport = null;
function transport() {
  if (_transport) return _transport;
  const c = cfg();
  _transport = nodemailer.createTransport({
    host: c.host,
    port: parseInt(c.port, 10),
    secure: parseInt(c.port, 10) === 465, // 465 implicit TLS; 587 STARTTLS
    requireTLS: parseInt(c.port, 10) !== 465,
    auth: { user: c.user, pass: c.pass },
  });
  return _transport;
}

function logMail(to, subject, text) {
  const entry = `\n===== ${new Date().toISOString()} =====\nTO: ${to}\nSUBJECT: ${subject}\n${text}\n`;
  try {
    fs.mkdirSync(path.dirname(MAIL_LOG), { recursive: true });
    fs.appendFileSync(MAIL_LOG, entry);
  } catch (_) {}
  console.log('[mailer:not-configured] wrote message to log instead of sending:', to, '—', subject);
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    logMail(to, subject, text || html || '');
    return { delivered: false, logged: true };
  }
  const c = cfg();
  await transport().sendMail({
    from: `"${c.fromName}" <${c.from}>`,
    to, subject, text, html,
  });
  return { delivered: true };
}

// Pick up to `n` books to feature: Available first (shuffled), topped up with
// On Loan if there aren't enough. Reference Only / Unavailable are never shown.
function pickSuggestions(books, n = 3) {
  const shuffle = (a) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const list = Array.isArray(books) ? books : [];
  const available = shuffle(list.filter(b => b.avail === 'Available'));
  const onLoan = shuffle(list.filter(b => b.avail === 'On Loan'));
  return available.concat(onLoan).slice(0, n);
}

function bookColumn(b, width) {
  const cover = b.img
    ? `<img src="${escapeAttr(b.img)}" alt="${escapeAttr(b.title)}" width="120" style="display: block; max-width: 120px; background-color: #e5e7eb; margin-bottom: 12px; border: 1px solid #e5e7eb; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">`
    : `<div style="width:120px;height:170px;background-color:#e5e7eb;border:1px solid #e5e7eb;margin-bottom:12px;"></div>`;
  const status = b.avail === 'Available'
    ? `<p style="margin: 6px 0 0 0; font-size: 11px; color: #15803d;">Available now</p>`
    : `<p style="margin: 6px 0 0 0; font-size: 11px; color: #b45309;">On loan</p>`;
  return `                                    <td class="book-column" width="${width}%" align="center" valign="top" style="padding: 0 10px;">
                                        ${cover}
                                        <h4 style="margin: 0 0 4px 0; font-size: 14px; color: #111827;">${escapeHtml(b.title)}</h4>
                                        <p style="margin: 0; font-size: 12px; color: #6b7280;">${escapeHtml(b.author || '')}</p>
                                        ${status}
                                    </td>`;
}

const _tplCache = {};
function loadTemplate(name = 'verify-email.html') {
  if (_tplCache[name]) return _tplCache[name];
  let t = fs.readFileSync(path.join(__dirname, 'templates', name), 'utf8');
  // Branding tokens available in every email template.
  t = t.split('{{library_name}}').join(escapeHtml(LIBRARY_NAME()))
       .split('{{site_url}}').join(escapeAttr(process.env.PUBLIC_URL || ''));
  _tplCache[name] = t;
  return t;
}

function verificationEmail(name, link, books) {
  const subject = `Verify your ${LIBRARY_NAME()} account`;
  const picks = pickSuggestions(books, 3);

  let html;
  try {
    html = loadTemplate();
    if (picks.length) {
      const width = Math.floor(100 / picks.length);
      html = html.replace('{{book_columns}}', picks.map(b => bookColumn(b, width)).join('\n'));
    } else {
      // No suggestable books: drop the whole section.
      html = html.replace(/<!--BOOKS_START-->[\s\S]*?<!--BOOKS_END-->/, '');
    }
    html = html.split('{{verification_link}}').join(escapeAttr(link))
               .split('{{name}}').join(escapeHtml(name));
  } catch (e) {
    console.error('verify template failed, using plain fallback:', e.message);
    html = `<p>Hi ${escapeHtml(name)},</p><p>Please confirm your email address:</p>
            <p><a href="${escapeAttr(link)}">Verify my email</a></p><p>${escapeHtml(link)}</p>`;
  }

  const bookLines = picks.length
    ? '\n\nAvailable in the library:\n' + picks.map(b => `  - ${b.title}${b.author ? ' by ' + b.author : ''} (${b.avail})`).join('\n')
    : '';

  const text =
`Hi ${name},

Thanks for signing up to ${LIBRARY_NAME()}.

Please confirm your email address by opening this link:
${link}

This link expires in 24 hours. After you verify, an administrator will review
your account before you can log in.${bookLines}

If you didn't sign up, you can ignore this email.

- ${LIBRARY_NAME()}`;

  return { subject, text, html };
}

function resetEmail(name, link) {
  const subject = `Reset your ${LIBRARY_NAME()} password`;
  let html;
  try {
    html = loadTemplate('reset-email.html')
      .split('{{reset_link}}').join(escapeAttr(link))
      .split('{{name}}').join(escapeHtml(name));
  } catch (e) {
    console.error('reset template failed, using plain fallback:', e.message);
    html = `<p>Hi ${escapeHtml(name)},</p><p>Reset your password:</p>
            <p><a href="${escapeAttr(link)}">Reset password</a></p><p>${escapeHtml(link)}</p>`;
  }
  const text =
`Hi ${name},

We received a request to reset the password for your ${LIBRARY_NAME()}
account. Open this link to choose a new one:
${link}

This link expires in 1 hour and can only be used once.

If you didn't ask to reset your password, you can ignore this email - your
password will stay exactly as it is.

- ${LIBRARY_NAME()}`;
  return { subject, text, html };
}

function waitingListEmail(name, book, position) {
  const subject = `You're on the waiting list for "${book.title}"`;
  let html;
  try {
    html = loadTemplate('waiting-list-email.html')
      .split('{{book_title}}').join(escapeHtml(book.title))
      .split('{{book_author}}').join(escapeHtml(book.author || 'Unknown'))
      .split('{{name}}').join(escapeHtml(name));
  } catch (e) {
    console.error('waiting-list template failed:', e.message);
    html = `<p>Hi ${escapeHtml(name)},</p><p>You are on the waiting list for ${escapeHtml(book.title)}.</p>`;
  }
  const text =
`Hi ${name},

You have been added to the waiting list for:

  ${book.title}${book.author ? ' by ' + book.author : ''}${position ? `

You are number ${position} on the list.` : ''}

We'll email you the moment a copy becomes available for you to borrow.

- ${LIBRARY_NAME()}`;
  return { subject, text, html };
}

function bookAvailableEmail(name, book) {
  const subject = `"${book.title}" is ready for you`;
  let html;
  try {
    html = loadTemplate('book-available-email.html')
      .split('{{book_title}}').join(escapeHtml(book.title))
      .split('{{book_author}}').join(escapeHtml(book.author || 'Unknown'))
      .split('{{name}}').join(escapeHtml(name));
  } catch (e) {
    console.error('book-available template failed:', e.message);
    html = `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(book.title)} is ready to collect.</p>`;
  }
  const text =
`Hi ${name},

Good news - the book you requested is now reserved for you:

  ${book.title}${book.author ? ' by ' + book.author : ''}

Please reply directly to this email to arrange a pickup time.

- ${LIBRARY_NAME()}`;
  return { subject, text, html };
}

function approvedEmail(name, link) {
  const subject = 'Your library account is approved';
  const text =
`Hi ${name},

Good news \u2014 your ${LIBRARY_NAME()} account has been approved.
You can now log in and borrow or reserve books:
${link}

— ${LIBRARY_NAME()}`;
  const html =
`<div style="font-family:sans-serif;max-width:520px;margin:auto;color:#1a1917">
  <h2 style="font-family:Georgia,serif;color:#2d5a3d">${LIBRARY_NAME()}</h2>
  <p>Hi ${escapeHtml(name)},</p>
  <p>Good news — your account has been approved. You can now log in and borrow or reserve books.</p>
  <p><a href="${escapeAttr(link)}" style="display:inline-block;background:#2d5a3d;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Go to the library</a></p>
</div>`;
  return { subject, text, html };
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

module.exports = { sendMail, verificationEmail, resetEmail, waitingListEmail, bookAvailableEmail, approvedEmail, isConfigured, pickSuggestions };
