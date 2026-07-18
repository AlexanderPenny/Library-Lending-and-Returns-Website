#!/usr/bin/env node

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
 * Interactive first-run setup.
 *   npm run setup
 *
 * Creates .env (secret + admin password hash + branding) and seeds the data
 * files. Safe to re-run: it will not overwrite an existing .env or catalogue
 * without asking.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const DATA = path.join(ROOT, 'data');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise(res =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, a => res((a || '').trim() || def)));

function askHidden(q) {
  return new Promise(resolve => {
    const onData = () => process.stdout.write('\x1b[2K\x1b[200D' + q + '*'.repeat(rl.line.length));
    process.stdin.on('data', onData);
    rl.question(q, answer => { process.stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  console.log('\n  Lending Library — setup\n  ' + '─'.repeat(40) + '\n');

  if (fs.existsSync(ENV)) {
    const go = await ask('.env already exists. Overwrite it? (y/N)', 'N');
    if (!/^y/i.test(go)) { console.log('Left .env untouched. Nothing changed.'); rl.close(); return; }
  }

  const name = await ask('Library name', 'Lending Library');
  const location = await ask('Location (optional, shown under the title)', '');
  const publicUrl = (await ask('Public URL of your site (no trailing slash)', 'http://localhost:3000')).replace(/\/$/, '');
  const homeUrl = await ask('Where should the "Home" button link to?', publicUrl);
  const basePath = await ask('URL path to serve the library under', '/Library');
  const port = await ask('Port to listen on', '3000');
  const adminUser = await ask('Admin username', 'admin');

  let pw = '';
  for (;;) {
    pw = await askHidden('Admin password (min 8 chars): ');
    if (pw.length < 8) { console.log('  Too short.'); continue; }
    const again = await askHidden('Confirm password: ');
    if (pw !== again) { console.log('  Did not match.'); continue; }
    break;
  }

  console.log('\n  Email is optional. Leave the host blank to run without it —');
  console.log('  verification links are then written to logs/mail.log.\n');
  const smtpHost = await ask('SMTP host (blank to skip)', '');
  let smtpPort = '587', smtpUser = '', smtpPass = '', mailFrom = `library@example.com`;
  if (smtpHost) {
    smtpPort = await ask('SMTP port', '587');
    smtpUser = await ask('SMTP username', '');
    smtpPass = await askHidden('SMTP password / token: ');
    mailFrom = await ask('Send emails from address', smtpUser || 'library@example.com');
  }

  const secret = crypto.randomBytes(48).toString('hex');
  const hash = await bcrypt.hash(pw, 12);
  const secure = publicUrl.startsWith('https://') ? 'true' : 'false';

  const env = `PORT=${port}
BASE_PATH=${basePath}
PUBLIC_URL=${publicUrl}
HOME_URL=${homeUrl}

LIBRARY_NAME=${name}
LIBRARY_LOCATION=${location}

ADMIN_USER=${adminUser}
ADMIN_PASSWORD_HASH=${hash}

SESSION_SECRET=${secret}
TRUST_PROXY=1
COOKIE_SECURE=${secure}

SMTP_HOST=${smtpHost}
SMTP_PORT=${smtpPort}
SMTP_USER=${smtpUser}
SMTP_PASS=${smtpPass}
MAIL_FROM=${mailFrom}
MAIL_FROM_NAME=${name}
`;
  fs.writeFileSync(ENV, env, { mode: 0o600 });
  console.log('\n  ✓ Wrote .env');

  fs.mkdirSync(DATA, { recursive: true });
  const booksFile = path.join(DATA, 'books.json');
  if (!fs.existsSync(booksFile)) {
    const seed = await ask('Seed the catalogue with 6 sample books? (Y/n)', 'Y');
    fs.writeFileSync(booksFile, /^y/i.test(seed)
      ? fs.readFileSync(path.join(DATA, 'books.sample.json'), 'utf8')
      : '[]\n');
    console.log('  ✓ Created data/books.json');
  } else {
    console.log('  · data/books.json already exists, left alone');
  }
  const usersFile = path.join(DATA, 'users.json');
  if (!fs.existsSync(usersFile)) { fs.writeFileSync(usersFile, '[]\n'); console.log('  ✓ Created data/users.json'); }

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

  console.log(`
  ${'─'.repeat(40)}
  Done. Start it with:

      npm start

  Then open:  ${publicUrl}${basePath === '/' ? '' : basePath}/
  Admin:      ${publicUrl}${basePath === '/' ? '' : basePath}/admin

  If you are testing locally over plain http, run:
      COOKIE_SECURE=false npm start
`);
  rl.close();
})();
