   //  Copyright 2026 Alexander L. Penny
   
   //  Licensed under the Apache License, Version 2.0 (the "License");
   //  you may not use this file except in compliance with the License.
   //  You may obtain a copy of the License at

   //      http://www.apache.org/licenses/LICENSE-2.0

   //  Unless required by applicable law or agreed to in writing, software
   //  distributed under the License is distributed on an "AS IS" BASIS,
   //  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   //  See the License for the specific language governing permissions and
   //  limitations under the License. 

/**
 * Lending Library — self-hosted book catalogue with member accounts.
 *
 * Public:
 *   GET  /Library/                 catalogue page
 *   GET  /Library/api/books        public catalogue (safe fields only)
 *   POST /Library/api/signup       name, email, password -> pending account + verify email
 *   GET  /Library/verify?token=..  confirm email address
 *   POST /Library/api/login        admin (username) OR approved member (email)
 *   POST /Library/api/logout
 *   GET  /Library/api/me           current session info
 *
 * Members (logged in, approved):
 *   POST /Library/api/reserve            { id } -> join the waiting list
 *   POST /Library/api/cancel-reservation -> leave whatever list you're on
 *
 * Admin (.env credentials):
 *   GET  /Library/admin            admin page
 *   GET  /Library/api/admin/books  full catalogue (incl. borrower/waitlist detail)
 *   PUT  /Library/api/books        overwrite catalogue
 *   GET  /Library/api/admin/users  list members (for the approval screen)
 *   POST /Library/api/admin/users/decision  { id, decision: approve|reject }
 *   POST /Library/api/admin/books/give             { id, entryId } -> hand book to that waitlist entry
 *   POST /Library/api/admin/books/return            { id } -> return; next in the unified waitlist gets it
 *   POST /Library/api/admin/books/waitlist/add      { id, name } -> add an offline (non-website) waiter
 *   POST /Library/api/admin/books/waitlist/remove   { id, entryId }
 *   POST /Library/api/admin/books/waitlist/move     { id, entryId, direction: up|down }
 *
 * The waiting list for a book is a single ordered array (`waitlist`) mixing
 * website members and offline (in-person/phone) waiters the admin adds by name.
 * There is one true order, so "Mark returned" always offers the book to whoever
 * is genuinely next, and the position a member is told when they join always
 * matches what happens later. See normaliseWaitlist() for the one-time
 * migration from the old separate `queue` count + `reservations` list.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');

// ---------- minimal .env loader (no dependency) ----------
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// Required AFTER .env is loaded, so it sees the SMTP settings.
const mailer = require('./lib/mailer');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_PATH = process.env.BASE_PATH || '/Library';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const DATA_DIR = path.join(__dirname, 'data');
const BOOKS_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'books.json');
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, 'users.json');
const AUTH_LOG = process.env.AUTH_LOG || path.join(__dirname, 'logs', 'auth.log');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY || '1', 10);
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'true') === 'true';

// ---------- branding (all optional; sensible defaults) ----------
const LIBRARY_NAME = process.env.LIBRARY_NAME || 'Lending Library';
const LIBRARY_LOCATION = process.env.LIBRARY_LOCATION || '';
const HOME_URL = process.env.HOME_URL || (PUBLIC_URL + '/');
// The title is shown with the middle word emphasised, e.g. "Green <em>Lane</em> Library".
function libraryTitleHtml() {
  const parts = LIBRARY_NAME.trim().split(/\s+/);
  if (parts.length < 2) return escapeHtmlPage(LIBRARY_NAME);
  const mid = Math.floor(parts.length / 2) - (parts.length % 2 === 0 ? 1 : 0);
  return parts.map((w, i) => i === mid ? `<span>${escapeHtmlPage(w)}</span>` : escapeHtmlPage(w)).join(' ');
}
function escapeHtmlPage(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Tokens substituted into the two HTML pages when they are served.
function pageTokens() {
  return {
    '{{LIBRARY_NAME}}': escapeHtmlPage(LIBRARY_NAME),
    '{{LIBRARY_TITLE_HTML}}': libraryTitleHtml(),
    '{{LIBRARY_LOCATION}}': escapeHtmlPage(LIBRARY_LOCATION),
    '{{LOCATION_SUFFIX}}': LIBRARY_LOCATION ? ' \u2014 ' + escapeHtmlPage(LIBRARY_LOCATION) : '',
    '{{LOCATION_DOT}}': LIBRARY_LOCATION ? ' \u00b7 ' + escapeHtmlPage(LIBRARY_LOCATION) : '',
    '{{HOME_URL}}': escapeHtmlPage(HOME_URL),
    '{{PUBLIC_URL}}': escapeHtmlPage(PUBLIC_URL),
    '{{BASE_PATH}}': escapeHtmlPage(BASE_PATH),
  };
}
const _pageCache = {};
function renderPage(file) {
  if (process.env.NODE_ENV !== 'production' || !_pageCache[file]) {
    let html = fs.readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(pageTokens())) html = html.split(k).join(v);
    _pageCache[file] = html;
  }
  return _pageCache[file];
}

if (!ADMIN_PASSWORD_HASH) { console.error('FATAL: ADMIN_PASSWORD_HASH not set. Run `npm run set-password`.'); process.exit(1); }
if (!SESSION_SECRET || SESSION_SECRET.length < 16) { console.error('FATAL: SESSION_SECRET missing/too short.'); process.exit(1); }

// ---------- app ----------
const app = express();
app.set('trust proxy', TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(session({
  name: 'library.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 1000 * 60 * 60 * 8, path: BASE_PATH },
}));

// ---------- auth logging (fail2ban reads this) ----------
fs.mkdirSync(path.dirname(AUTH_LOG), { recursive: true });
function logAuth(kind, req, extra = '') {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '-';
  fs.appendFile(AUTH_LOG, `${new Date().toISOString()} LIBRARY_AUTH ${kind} ip=${ip} ${extra}`.trim() + '\n', () => {});
}

// ---------- json helpers (atomic writes) ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.tmp');
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

// serialise writes to each file so concurrent requests don't clobber
const locks = {};
function withLock(key, fn) {
  const prev = locks[key] || Promise.resolve();
  const next = prev.then(fn, fn);
  locks[key] = next.catch(() => {});
  return next;
}

// ---------- books ----------
const VALID_GENRES = ['Fiction', 'Non-Fiction', 'Mystery', 'History', 'Science', 'Reference', 'Theology'];
const VALID_AVAIL = ['Available', 'Reserved', 'On Loan', 'Reference Only', 'Unavailable'];

// One ordered waiting list per book, mixing website members and offline
// (in-person/phone) waiters. Each entry has a stable `id` so admin actions
// (give/remove/reorder) target the right person even after the list reorders.
function normaliseWaitlistEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'member') {
    const email = String(e.email || '').toLowerCase().slice(0, 200);
    if (!email) return null;
    return { id: String(e.id || crypto.randomUUID()), type: 'member', name: String(e.name || '').slice(0, 200), email, at: e.at || null };
  }
  return { id: String(e.id || crypto.randomUUID()), type: 'offline', name: String(e.name || '').slice(0, 200) || 'Unnamed', at: e.at || null };
}
function normaliseWaitlist(b) {
  if (Array.isArray(b.waitlist)) return b.waitlist.map(normaliseWaitlistEntry).filter(Boolean);
  // Migrate the old model: a manual offline `queue` count (unnamed, always
  // treated as ahead of the line) plus a `reservations` array of website
  // members in join order. This ran the two lists independently, so this is
  // a one-time, best-effort merge — offline entries land unnamed at the
  // front; the admin can rename or reorder them afterwards.
  const legacyQueue = Number.isFinite(parseInt(b.queue, 10)) && parseInt(b.queue, 10) > 0 ? parseInt(b.queue, 10) : 0;
  const offline = Array.from({ length: legacyQueue }, () => ({ id: crypto.randomUUID(), type: 'offline', name: 'Unnamed (from old offline count)', at: null }));
  const members = (Array.isArray(b.reservations) ? b.reservations : []).map(r => ({
    id: crypto.randomUUID(), type: 'member', name: String(r.name || '').slice(0, 200), email: String(r.email || '').toLowerCase(), at: r.at || null,
  }));
  return offline.concat(members);
}
function normaliseBook(b, i) {
  return {
    id: Number.isFinite(parseInt(b.id, 10)) ? parseInt(b.id, 10) : i + 1,
    title: String(b.title || '').slice(0, 500),
    author: String(b.author || '').slice(0, 500),
    genre: VALID_GENRES.includes(b.genre) ? b.genre : 'Non-Fiction',
    year: String(b.year || '').slice(0, 20),
    avail: VALID_AVAIL.includes(b.avail) ? b.avail : 'Available',
    img: String(b.img || '').slice(0, 2000),
    blurb: String(b.blurb || '').slice(0, 4000),
    borrowedBy: b.borrowedBy || null,
    waitlist: normaliseWaitlist(b),
  };
}
async function readBooks() {
  const raw = await readJson(BOOKS_FILE, []);
  return raw.map(normaliseBook);
}
function publicBook(b) {
  // Borrower and waitlist identities are never exposed publicly, just the count.
  return {
    id: b.id, title: b.title, author: b.author, genre: b.genre, year: b.year,
    avail: b.avail,
    queue: (b.waitlist || []).length,
    img: b.img, blurb: b.blurb,
  };
}

// What is this member currently holding? (max one book each)
function holdingOf(books, email) {
  if (!email) return null;
  for (const b of books) {
    if (b.borrowedBy && b.borrowedBy.email === email) return { book: b, kind: 'loan' };
    if ((b.waitlist || []).some(x => x.type === 'member' && x.email === email)) return { book: b, kind: 'reservation' };
  }
  return null;
}

// ---------- users ----------
async function readUsers() { return await readJson(USERS_FILE, []); }
function findUser(users, email) { return users.find(u => u.email.toLowerCase() === String(email).toLowerCase()); }
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, status: u.status, createdAt: u.createdAt }; }

// ---------- middleware ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin only' });
}
function requireMember(req, res, next) {
  if (req.session && (req.session.role === 'user' || req.session.role === 'admin')) return next();
  return res.status(401).json({ error: 'Please log in' });
}

// ---------- router ----------
const r = express.Router();

// -- public catalogue --
r.get('/api/books', async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json((await readBooks()).map(publicBook)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not read catalogue' }); }
});

// -- session info --
r.get('/api/me', (req, res) => {
  const s = req.session || {};
  res.json({ authenticated: !!s.role, role: s.role || null, name: s.name || null, email: s.email || null });
});

// -- signup --
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-ups from this address. Try later.' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

r.post('/api/signup', signupLimiter, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 200);
  const password = String((req.body && req.body.password) || '');
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const result = await withLock('users', async () => {
      const users = await readUsers();
      if (findUser(users, email)) return { conflict: true };
      const token = crypto.randomBytes(24).toString('hex');
      const user = {
        id: crypto.randomUUID(),
        name, email,
        passHash: await bcrypt.hash(password, 12),
        status: 'pending_email',
        token, tokenExp: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeJson(USERS_FILE, users);
      return { user, token };
    });
    if (result.conflict) return res.status(409).json({ error: 'That email is already registered.' });

    const link = `${PUBLIC_URL}${BASE_PATH}/verify?token=${result.token}`;
    const msg = mailer.verificationEmail(name, link, await readBooks());
    try { await mailer.sendMail({ to: email, ...msg }); }
    catch (e) { console.error('sendMail failed:', e.message); }
    logAuth('SIGNUP', req, `email=${email}`);
    res.json({ ok: true, emailConfigured: mailer.isConfigured() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not create the account.' }); }
});

// -- verify email --
r.get('/verify', async (req, res) => {
  const token = String(req.query.token || '');
  let outcome = 'invalid';
  if (token) {
    outcome = await withLock('users', async () => {
      const users = await readUsers();
      const u = users.find(x => x.token === token);
      if (!u) return 'invalid';
      if (u.tokenExp && u.tokenExp < Date.now()) return 'expired';
      if (u.status === 'pending_email') { u.status = 'pending_approval'; u.token = null; u.tokenExp = null; await writeJson(USERS_FILE, users); }
      return 'ok';
    });
  }
  res.set('Content-Type', 'text/html').send(verifyPage(outcome));
});

// -- resend verification link --
const resendLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });

r.post('/api/resend-verification', resendLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const result = await withLock('users', async () => {
    const users = await readUsers();
    const u = findUser(users, email);
    if (!u) return { silent: true };
    if (u.status !== 'pending_email') return { silent: true, status: u.status };
    u.token = crypto.randomBytes(24).toString('hex');
    u.tokenExp = Date.now() + 24 * 60 * 60 * 1000;
    await writeJson(USERS_FILE, users);
    return { user: u };
  });

  if (result.user) {
    const link = `${PUBLIC_URL}${BASE_PATH}/verify?token=${result.user.token}`;
    const msg = mailer.verificationEmail(result.user.name, link, await readBooks());
    try { await mailer.sendMail({ to: result.user.email, ...msg }); }
    catch (e) { console.error('resend failed:', e.message); }
    logAuth('RESEND', req, `email=${email}`);
  }
  // Always the same reply, so this can't be used to discover which emails exist.
  res.json({ ok: true, message: 'If that address needs verifying, a new link is on its way. Check your inbox and spam folder.' });
});

// -- forgot password: request a reset link --
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });

r.post('/api/forgot-password', forgotLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const outcome = await withLock('users', async () => {
    const users = await readUsers();
    const u = findUser(users, email);
    if (!u || u.status === 'rejected') return null;
    u.resetToken = crypto.randomBytes(24).toString('hex');
    u.resetExp = Date.now() + 60 * 60 * 1000; // 1 hour
    await writeJson(USERS_FILE, users);
    return u;
  });

  if (outcome) {
    const link = `${PUBLIC_URL}${BASE_PATH}/reset?token=${outcome.resetToken}`;
    try {
      const msg = mailer.resetEmail(outcome.name, link);
      await mailer.sendMail({ to: outcome.email, ...msg });
    } catch (e) { console.error('reset mail failed:', e.message); }
    logAuth('RESET_REQUEST', req, `email=${email}`);
  }
  // Identical reply either way, so this can't reveal which addresses exist.
  res.json({ ok: true, message: 'If that email is registered, a password reset link is on its way. Check your inbox and spam folder.' });
});

// -- reset password: submit a new one --
r.post('/api/reset-password', forgotLimiter, async (req, res) => {
  const token = String((req.body && req.body.token) || '');
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const outcome = await withLock('users', async () => {
    const users = await readUsers();
    const u = users.find(x => x.resetToken && x.resetToken === token);
    if (!u) return { error: 'This reset link is not valid. It may have already been used.' };
    if (!u.resetExp || u.resetExp < Date.now()) return { error: 'This reset link has expired. Please request a new one.' };
    u.passHash = await bcrypt.hash(password, 12);
    u.resetToken = null;
    u.resetExp = null;
    await writeJson(USERS_FILE, users);
    return { user: u };
  });
  if (outcome.error) return res.status(400).json({ error: outcome.error });
  logAuth('RESET_DONE', req, `email=${outcome.user.email}`);
  res.json({ ok: true, status: outcome.user.status });
});

// -- reset landing page --
r.get('/reset', (req, res) => {
  res.set('Content-Type', 'text/html').send(resetPage(String(req.query.token || '')));
});

// -- login (admin OR approved member) --
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });

r.post('/api/login', loginLimiter, async (req, res) => {
  const identifier = String((req.body && req.body.identifier) || '').trim();
  const password = String((req.body && req.body.password) || '');

  // admin path
  if (identifier === ADMIN_USER) {
    let ok = false;
    try { ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH); } catch (_) {}
    if (ok) {
      return req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error' });
        req.session.role = 'admin'; req.session.name = 'Admin';
        logAuth('SUCCESS', req, 'user=admin'); res.json({ ok: true, role: 'admin' });
      });
    }
    logAuth('FAIL', req, 'user=admin');
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // member path (by email)
  const email = identifier.toLowerCase();
  const users = await readUsers();
  const u = findUser(users, email);
  let passOk = false;
  if (u && u.passHash) { try { passOk = await bcrypt.compare(password, u.passHash); } catch (_) {} }

  if (u && passOk) {
    if (u.status === 'approved') {
      return req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error' });
        req.session.role = 'user'; req.session.email = u.email; req.session.name = u.name; req.session.uid = u.id;
        logAuth('SUCCESS', req, `email=${email}`); res.json({ ok: true, role: 'user', name: u.name });
      });
    }
    logAuth('FAIL', req, `email=${email} status=${u.status}`);
    if (u.status === 'pending_email') return res.status(403).json({ error: 'Please verify your email first (check your inbox).' });
    if (u.status === 'pending_approval') return res.status(403).json({ error: 'Your account is awaiting administrator approval.' });
    return res.status(403).json({ error: 'This account cannot log in.' });
  }
  logAuth('FAIL', req, `email=${email}`);
  res.status(401).json({ error: 'Invalid email or password' });
});

r.post('/api/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('library.sid', { path: BASE_PATH }); res.json({ ok: true }); });
});

// -- reserve / join waiting list (members). Max ONE book per member. --
r.post('/api/reserve', requireMember, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const me = { name: req.session.name, email: req.session.email || 'admin', at: new Date().toISOString() };

  let mail = null;
  try {
    const result = await withLock('books', async () => {
      const books = await readBooks();
      const b = books.find(x => x.id === id);
      if (!b) return { error: 'Book not found', code: 404 };
      if (b.avail === 'Reference Only') return { error: 'This book is reference only and can\u2019t be taken out.', code: 409 };

      // one book per member
      const held = holdingOf(books, me.email);
      if (held) {
        if (held.book.id === b.id) {
          return { ok: true, message: held.kind === 'loan'
            ? 'You already have this book on loan.'
            : 'You\u2019re already on the list for this book.' };
        }
        return { error: `You already have "${held.book.title}" ${held.kind === 'loan' ? 'on loan' : 'reserved'}. Only one book at a time \u2014 please return it first.`, code: 409 };
      }

      b.waitlist = b.waitlist || [];
      const entry = { id: crypto.randomUUID(), type: 'member', name: me.name, email: me.email, at: me.at };
      if (b.avail === 'Available') {
        // free right now -> reserved for this member, awaiting handover by the admin
        b.avail = 'Reserved';
        b.waitlist.push(entry);
        await writeJson(BOOKS_FILE, books);
        mail = { kind: 'available', book: b };
        return { ok: true, message: `Reserved for you. We\u2019ll be in touch to arrange collection of "${b.title}".` };
      }

      // already out or reserved -> join the single ordered waiting list, behind
      // anyone (online or offline) already on it
      b.waitlist.push(entry);
      const position = b.waitlist.length;
      await writeJson(BOOKS_FILE, books);
      mail = { kind: 'waiting', book: b, position };
      return { ok: true, message: `Added to the waiting list for "${b.title}" \u2014 you\u2019re number ${position}.` };
    });

    if (result.error) return res.status(result.code).json({ error: result.error });

    if (mail) {
      try {
        const msg = mail.kind === 'available'
          ? mailer.bookAvailableEmail(me.name, mail.book)
          : mailer.waitingListEmail(me.name, mail.book, mail.position);
        await mailer.sendMail({ to: me.email, ...msg });
      } catch (e) { console.error('reserve mail failed:', e.message); }
      logAuth('RESERVE', req, `id=${id} email=${me.email} kind=${mail.kind}`);
    }
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not reserve the book.' }); }
});

// -- cancel my own reservation --
r.post('/api/cancel-reservation', requireMember, async (req, res) => {
  const email = req.session.email || 'admin';
  const out = await withLock('books', async () => {
    const books = await readBooks();
    let changed = null;
    for (const b of books) {
      const before = (b.waitlist || []).length;
      b.waitlist = (b.waitlist || []).filter(x => !(x.type === 'member' && x.email === email));
      if (b.waitlist.length !== before) {
        if (b.avail === 'Reserved' && b.waitlist.length === 0) b.avail = 'Available';
        changed = b;
      }
    }
    if (changed) await writeJson(BOOKS_FILE, books);
    return changed;
  });
  if (!out) return res.status(404).json({ error: 'You have no reservation to cancel.' });
  logAuth('CANCEL_RESERVATION', req, `email=${email} id=${out.id}`);
  res.json({ ok: true, message: `Cancelled your reservation for "${out.title}".` });
});

// -- what am I holding? (drives the public UI) --
r.get('/api/my-holding', requireMember, async (req, res) => {
  const email = req.session.email || 'admin';
  const books = await readBooks();
  const held = holdingOf(books, email);
  res.set('Cache-Control', 'no-store');
  res.json(held ? { holding: true, kind: held.kind, id: held.book.id, title: held.book.title } : { holding: false });
});

// -- admin: hand the book over ("I have given book to ...") --
// Targets a specific waitlist entry (member or offline) by id, not
// necessarily the one at the front \u2014 the admin may have arranged a handover
// out of turn, and that's their call to make.
r.post('/api/admin/books/give', requireAdmin, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const entryId = String((req.body && req.body.entryId) || '');
  const out = await withLock('books', async () => {
    const books = await readBooks();
    const b = books.find(x => x.id === id);
    if (!b) return { error: 'Book not found' };
    const i = (b.waitlist || []).findIndex(x => x.id === entryId);
    if (i === -1) return { error: 'That person is not on this book\u2019s waiting list.' };
    const entry = b.waitlist[i];
    b.borrowedBy = { name: entry.name, email: entry.type === 'member' ? entry.email : null };
    b.avail = 'On Loan';
    b.waitlist.splice(i, 1);
    await writeJson(BOOKS_FILE, books);
    return { book: b, entry };
  });
  if (out.error) return res.status(400).json(out);
  logAuth('GIVE', req, `id=${id} entry=${entryId}`);
  res.json({ ok: true, message: `Marked "${out.book.title}" as on loan to ${out.entry.name}.` });
});

// -- admin: book returned --
// Whoever is at the front of the single ordered waitlist gets it next,
// whether they're a website member (emailed automatically) or an offline
// waiter the admin added by name (the admin hands it over manually and then
// clicks "Mark given" on that entry) \u2014 so the order a member was told when
// they joined always matches what actually happens here.
r.post('/api/admin/books/return', requireAdmin, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  let notify = null;
  let nextOffline = null;
  const out = await withLock('books', async () => {
    const books = await readBooks();
    const b = books.find(x => x.id === id);
    if (!b) return { error: 'Book not found' };
    b.borrowedBy = null;
    b.waitlist = b.waitlist || [];
    if (b.waitlist.length) {
      const next = b.waitlist[0];
      b.avail = 'Reserved';
      if (next.type === 'member') notify = { person: next, book: b };
      else nextOffline = next;
    } else {
      b.avail = 'Available';
    }
    await writeJson(BOOKS_FILE, books);
    return { book: b };
  });
  if (out.error) return res.status(400).json(out);

  let notified = null;
  if (notify) {
    try {
      const msg = mailer.bookAvailableEmail(notify.person.name, notify.book);
      await mailer.sendMail({ to: notify.person.email, ...msg });
      notified = notify.person.name;
    } catch (e) { console.error('return notify failed:', e.message); }
  }
  logAuth('RETURN', req, `id=${id} notified=${notified || 'none'} nextOffline=${nextOffline ? nextOffline.name : 'none'}`);
  res.json({
    ok: true,
    message: notified
      ? `Returned. Now reserved for ${notified}, who has been emailed.`
      : nextOffline
        ? `Returned. Next in line is ${nextOffline.name} (offline) \u2014 once you\u2019ve handed it over, click "Mark given" on their entry.`
        : `Returned. "${out.book.title}" is available again.`,
  });
});

// -- admin: add an offline (non-website) person to a book's waiting list --
r.post('/api/admin/books/waitlist/add', requireAdmin, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const name = String((req.body && req.body.name) || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'Please enter a name.' });
  const out = await withLock('books', async () => {
    const books = await readBooks();
    const b = books.find(x => x.id === id);
    if (!b) return { error: 'Book not found' };
    b.waitlist = b.waitlist || [];
    b.waitlist.push({ id: crypto.randomUUID(), type: 'offline', name, at: new Date().toISOString() });
    if (b.avail === 'Available') b.avail = 'Reserved';
    await writeJson(BOOKS_FILE, books);
    return { book: b };
  });
  if (out.error) return res.status(400).json(out);
  logAuth('WAITLIST_ADD', req, `id=${id} name=${name}`);
  res.json({ ok: true, message: `Added ${name} to the waiting list.` });
});

// -- admin: remove an entry (member or offline) from a book's waiting list --
r.post('/api/admin/books/waitlist/remove', requireAdmin, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const entryId = String((req.body && req.body.entryId) || '');
  const out = await withLock('books', async () => {
    const books = await readBooks();
    const b = books.find(x => x.id === id);
    if (!b) return { error: 'Book not found' };
    const before = (b.waitlist || []).length;
    const removed = (b.waitlist || []).find(x => x.id === entryId);
    b.waitlist = (b.waitlist || []).filter(x => x.id !== entryId);
    if (b.waitlist.length === before) return { error: 'That entry was not found.' };
    if (b.avail === 'Reserved' && b.waitlist.length === 0) b.avail = 'Available';
    await writeJson(BOOKS_FILE, books);
    return { book: b, removed };
  });
  if (out.error) return res.status(400).json(out);
  logAuth('WAITLIST_REMOVE', req, `id=${id} entry=${entryId}`);
  res.json({ ok: true, message: `Removed ${out.removed.name} from the waiting list.` });
});

// -- admin: reorder a waiting list entry one place up or down --
r.post('/api/admin/books/waitlist/move', requireAdmin, async (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const entryId = String((req.body && req.body.entryId) || '');
  const dir = (req.body && req.body.direction) === 'down' ? 1 : -1;
  const out = await withLock('books', async () => {
    const books = await readBooks();
    const b = books.find(x => x.id === id);
    if (!b) return { error: 'Book not found' };
    const list = b.waitlist || [];
    const i = list.findIndex(x => x.id === entryId);
    if (i === -1) return { error: 'That entry was not found.' };
    const j = i + dir;
    if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
    await writeJson(BOOKS_FILE, books);
    return { book: b };
  });
  if (out.error) return res.status(400).json(out);
  res.json({ ok: true });
});

// -- admin: full catalogue --
r.get('/api/admin/books', requireAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store'); res.json(await readBooks());
});

// -- admin: save catalogue --
r.put('/api/books', requireAdmin, async (req, res) => {
  try {
    if (!Array.isArray(req.body)) throw new Error('Expected an array of books');
    if (req.body.length > 5000) throw new Error('Too many books');
    const books = req.body.map((b, i) => {
      const nb = normaliseBook(b, i);
      if (!nb.title.trim()) throw new Error(`Book #${i + 1} is missing a title`);
      // Deliberately NOT touched here: borrowedBy, waitlist.
      // Editing catalogue fields (title, genre, etc.) can never silently drop
      // who is on loan or waiting.
      return nb;
    });
    await withLock('books', () => writeJson(BOOKS_FILE, books));
    logAuth('SAVE', req, `count=${books.length}`);
    res.json({ ok: true, count: books.length });
  } catch (e) { res.status(400).json({ error: e.message || 'Invalid data' }); }
});

// -- admin: list members --
r.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await readUsers();
  const books = await readBooks();
  res.set('Cache-Control', 'no-store');
  res.json(users.map(u => {
    const held = holdingOf(books, u.email);
    return {
      ...publicUser(u),
      holding: held ? { kind: held.kind, id: held.book.id, title: held.book.title } : null,
    };
  }));
});

// -- admin: resend a verification link --
r.post('/api/admin/users/resend', requireAdmin, async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const outcome = await withLock('users', async () => {
    const users = await readUsers();
    const u = users.find(x => x.id === id);
    if (!u) return { error: 'User not found' };
    if (u.status !== 'pending_email') return { error: 'That account has already verified its email.' };
    u.token = crypto.randomBytes(24).toString('hex');
    u.tokenExp = Date.now() + 24 * 60 * 60 * 1000;
    await writeJson(USERS_FILE, users);
    return { user: u };
  });
  if (outcome.error) return res.status(400).json(outcome);

  const link = `${PUBLIC_URL}${BASE_PATH}/verify?token=${outcome.user.token}`;
  let sent = false, sendError = null;
  try {
    const msg = mailer.verificationEmail(outcome.user.name, link, await readBooks());
    const r2 = await mailer.sendMail({ to: outcome.user.email, ...msg });
    sent = !!r2.delivered;
  } catch (e) { sendError = e.message; console.error('admin resend failed:', e.message); }
  logAuth('ADMIN_RESEND', req, `id=${id} sent=${sent}`);
  // Admin-only: return the link too, so you can pass it on manually if mail is failing.
  res.json({ ok: true, sent, sendError, link, emailConfigured: mailer.isConfigured() });
});

// -- admin: permanently delete a member (and scrub them from book records) --
r.post('/api/admin/users/delete', requireAdmin, async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const removed = await withLock('users', async () => {
    const users = await readUsers();
    const i = users.findIndex(x => x.id === id);
    if (i === -1) return null;
    const [u] = users.splice(i, 1);
    await writeJson(USERS_FILE, users);
    return u;
  });
  if (!removed) return res.status(404).json({ error: 'User not found' });

  // Remove every trace of them from the catalogue.
  const scrub = await withLock('books', async () => {
    const books = await readBooks();
    let loansCleared = 0, queuesCleared = 0;
    for (const b of books) {
      if (b.borrowedBy && b.borrowedBy.email === removed.email) {
        b.borrowedBy = null;
        if (b.avail === 'On Loan') b.avail = 'Available';
        loansCleared++;
      }
      const before = (b.waitlist || []).length;
      b.waitlist = (b.waitlist || []).filter(x => !(x.type === 'member' && x.email === removed.email));
      if (b.waitlist.length !== before) {
        queuesCleared++;
        if (b.avail === 'Reserved' && b.waitlist.length === 0) b.avail = 'Available';
      }
    }
    await writeJson(BOOKS_FILE, books);
    return { loansCleared, queuesCleared };
  });

  logAuth('DELETE_USER', req, `email=${removed.email} loans=${scrub.loansCleared} queues=${scrub.queuesCleared}`);
  res.json({ ok: true, name: removed.name, ...scrub });
});

// -- admin: approve / reject --
r.post('/api/admin/users/decision', requireAdmin, async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const decision = String((req.body && req.body.decision) || '');
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Bad decision' });
  const outcome = await withLock('users', async () => {
    const users = await readUsers();
    const u = users.find(x => x.id === id);
    if (!u) return { error: 'User not found' };
    u.status = decision === 'approve' ? 'approved' : 'rejected';
    await writeJson(USERS_FILE, users);
    return { user: u };
  });
  if (outcome.error) return res.status(404).json(outcome);
  logAuth('DECISION', req, `id=${id} decision=${decision}`);
  if (decision === 'approve') {
    const link = `${PUBLIC_URL}${BASE_PATH}/`;
    const msg = mailer.approvedEmail(outcome.user.name, link);
    try { await mailer.sendMail({ to: outcome.user.email, ...msg }); } catch (e) { console.error('approve mail failed:', e.message); }
  }
  res.json({ ok: true, status: outcome.user.status });
});

// -- static pages --
const publicDir = path.join(__dirname, 'public', 'Library');
r.get('/admin', (req, res) => res.type('html').send(renderPage(path.join(publicDir, 'admin.html'))));
r.get('/', (req, res) => res.type('html').send(renderPage(path.join(publicDir, 'index.html'))));
r.get('/index.html', (req, res) => res.type('html').send(renderPage(path.join(publicDir, 'index.html'))));
r.use('/', express.static(publicDir));

app.use(BASE_PATH, r);
app.get('/', (req, res) => res.redirect(BASE_PATH + '/'));

// ---------- verify link landing page ----------
function verifyPage(outcome) {
  const map = {
    ok: ['Email verified', 'Thanks \u2014 your email is confirmed. An administrator will review your account shortly. You\u2019ll be able to log in once it\u2019s approved.'],
    expired: ['Link expired', 'That verification link has expired. Please sign up again to receive a new one.'],
    invalid: ['Invalid link', 'That verification link isn\u2019t valid. It may have already been used.'],
  };
  const [title, body] = map[outcome] || map.invalid;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} \u2014 ${LIBRARY_NAME}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>body{font-family:'DM Sans',sans-serif;background:#f5f4f0;color:#1a1917;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
.card{background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:10px;padding:2rem;max-width:440px;text-align:center}
h1{font-family:'DM Serif Display',serif;color:#2d5a3d;font-size:24px;margin:0 0 .75rem}p{color:#5a5850;line-height:1.6;font-size:14px}
a{display:inline-block;margin-top:1.25rem;background:#2d5a3d;color:#fff;text-decoration:none;padding:9px 18px;border-radius:6px;font-size:14px}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p><a href="${BASE_PATH}/">Go to the library</a></div></body></html>`;
}

// ---------- password reset page ----------
function resetPage(token) {
  const safeToken = String(token).replace(/[^a-f0-9]/gi, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset your password \u2014 ${LIBRARY_NAME}</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>body{font-family:'DM Sans',sans-serif;background:#f5f4f0;color:#1a1917;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
.card{background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:10px;padding:2rem;max-width:400px;width:100%}
h1{font-family:'DM Serif Display',serif;color:#2d5a3d;font-size:23px;margin:0 0 .35rem;text-align:center}
.sub{font-size:12px;color:#9a9890;margin-bottom:1.4rem;text-align:center}
label{display:block;font-size:11px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;color:#9a9890;margin-bottom:5px}
input{width:100%;box-sizing:border-box;font-family:'DM Sans',sans-serif;font-size:13px;color:#1a1917;background:#fff;border:1px solid rgba(0,0,0,.14);border-radius:6px;padding:9px 11px;outline:none;margin-bottom:12px}
input:focus{border-color:#2d5a3d}
button{width:100%;font-family:'DM Sans',sans-serif;font-size:13px;padding:9px 16px;border-radius:6px;border:1px solid #2d5a3d;background:#2d5a3d;color:#fff;cursor:pointer}
button:hover{background:#24492f}button:disabled{opacity:.55;cursor:default}
.msg{font-size:13px;padding:9px 11px;border-radius:6px;margin-bottom:12px;display:none}.msg.show{display:block}
.err{background:#fdecea;color:#8a1f1a;border:1px solid #f09595}.ok{background:#eaf2ec;color:#2d5a3d;border:1px solid #b9d5c1}
a.link{display:block;margin-top:1.1rem;text-align:center;color:#2d5a3d;font-size:13px;text-decoration:none}</style>
</head><body><div class="card">
<h1>Reset your password</h1><div class="sub">${LIBRARY_NAME}</div>
<div class="msg err" id="err"></div><div class="msg ok" id="ok"></div>
<div id="form">
  <label for="p1">New password</label><input id="p1" type="password" autocomplete="new-password" placeholder="At least 8 characters">
  <label for="p2">Confirm new password</label><input id="p2" type="password" autocomplete="new-password">
  <button id="go">Set new password</button>
</div>
<a class="link" href="${BASE_PATH}/">Back to the library</a>
</div>
<script>
var TOKEN=${JSON.stringify(safeToken)};
var err=document.getElementById('err'),ok=document.getElementById('ok'),go=document.getElementById('go');
function show(el,t){el.textContent=t;el.className='msg '+(el===err?'err':'ok')+' show';}
if(!TOKEN){show(err,'This reset link is missing its token. Please request a new one.');document.getElementById('form').style.display='none';}
go.addEventListener('click',async function(){
  var p1=document.getElementById('p1').value,p2=document.getElementById('p2').value;
  err.className='msg err';
  if(p1.length<8){show(err,'Password must be at least 8 characters.');return;}
  if(p1!==p2){show(err,'Those passwords do not match.');return;}
  go.disabled=true;
  try{
    var res=await fetch('api/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:TOKEN,password:p1})});
    var data=await res.json().catch(function(){return {};});
    if(res.ok){document.getElementById('form').style.display='none';
      show(ok, data.status==='approved' ? 'Password updated. You can now log in with your new password.' : 'Password updated. Your account still needs administrator approval before you can log in.');
    } else {show(err,data.error||'Could not reset the password.');go.disabled=false;}
  }catch(e){show(err,'Network error. Please try again.');go.disabled=false;}
});
document.getElementById('p2').addEventListener('keydown',function(e){if(e.key==='Enter')go.click();});
</script></body></html>`;
}

app.listen(PORT, () => {
  console.log(`Library app on http://127.0.0.1:${PORT}${BASE_PATH}/  (email ${mailer.isConfigured() ? 'configured' : 'NOT configured \u2014 links go to logs/mail.log'})`);
});
