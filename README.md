# Lending Library

A small self-hosted lending library for a personal, church, school, office or community
book collection. Visitors browse a searchable catalogue; members sign up, verify their
email, wait for your approval, then reserve books and join waiting lists. You approve
members, hand books over, and mark them returned — the right emails go out automatically.

Runs comfortably on a Raspberry Pi. **No database** — everything lives in two JSON files
you can read, edit and back up with `cp`.

> **Status**: stable and in daily use, but small and deliberately simple. It is a lending
> tracker, not an integrated library system. If you need circulation rules, MARC records,
> barcodes or patron fines, use [Koha](https://koha-community.org/) instead.

<img width="1671" height="926" alt="Screenshot 2026-07-18 225331" src="https://github.com/user-attachments/assets/3de56e25-dc0b-490c-aaf2-685e629d6227" />

---

## Contents

- [Features](#features)
- [Screens](#screens)
- [How lending works](#how-lending-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running it for real](#running-it-for-real)
  - [systemd](#1-run-it-as-a-service-systemd)
  - [Reverse proxy](#2-put-it-behind-a-reverse-proxy)
  - [fail2ban](#3-fail2ban-optional-but-recommended)
- [Email setup](#email-setup)
- [Configuration reference](#configuration-reference)
- [Customising](#customising)
- [Data files and backups](#data-files-and-backups)
- [Security notes](#security-notes)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Licence](#licence)

---

## Features

**Public catalogue**
- Search by title or author; filter by genre and availability
- Click a book to expand its description, year and cover
- Shareable per-book links (`/Library/?book=7`) that open straight to that book
- Works on phones; no build step, no framework, no tracking

**Member accounts**
- Sign up with name, email and password
- Email verification, then **admin approval** — nobody gets in just by registering
- "Forgot my password" with an emailed, single-use, time-limited reset link
- Resend buttons for both verification and reset emails

**Lending**
- Members **reserve** an available book, or **join the waiting list** for one that's out
- One book per member at a time
- You hand the book over and press **"I have given book to …"** → marked *On Loan*
- **Mark returned** → the book is offered to whoever is genuinely next in line and, if
  they're a website member, they're emailed automatically
- **One ordered waiting list per book** mixing website members and offline (in-person /
  phone) people you add by name — reorder, remove, or hand out of turn from the admin panel

**Admin**
- Password-protected panel at `/Library/admin`
- Add, edit, reorder and delete books, with live cover previews
- Raw-JSON editing mode for bulk changes
- Member list with pending-approval badge, Approve / Deny / Delete
- See at a glance what each member is holding
- Borrower and reservation identities are **never exposed publicly** — admin only

**Email** (optional)
- Five templated HTML emails: verify, password reset, waiting list, book ready, approved
- Verification email features three random currently-available books
- Works with any SMTP provider (Proton, Brevo, Gmail, Fastmail, self-hosted…)
- **Runs fine with no email configured** — links are written to `logs/mail.log` and shown
  in the admin panel so you can pass them on manually

**Operations**
- Single Node process, ~15 MB of dependencies, no database
- Failed logins written to `logs/auth.log` in a fail2ban-friendly format
- Built-in rate limiting on login, signup, reset and resend
- Atomic JSON writes (temp file + rename) so a crash can't corrupt your catalogue

---

## Screens

| Page | Path | Who |
|---|---|---|
| Catalogue | `/Library/` | Everyone |
| Book deep link | `/Library/?book=7` | Everyone |
| Email verification landing | `/Library/verify?token=…` | Link recipients |
| Password reset | `/Library/reset?token=…` | Link recipients |
| Admin panel | `/Library/admin` | Admin only |

---

## How lending works

The flow assumes **you physically hand over books**, so nothing is marked as loaned until
you say so.

```
Member browses catalogue
        │
        ├─ book is Available ──► "Reserve book"
        │                          → status becomes Reserved
        │                          → member emailed "your book is ready"
        │
        └─ book is out ─────────► "Join waiting list"
                                   → added to the end of the one ordered list
                                   → member emailed their position

You meet the member and hand the book over
        │
        └─ admin panel ──► "I have given book to Ann"
                             → status becomes On Loan, recorded against Ann

Book comes back
        │
        └─ admin panel ──► "Mark returned"
                             ├─ member next?  → reserved for them + emailed
                             ├─ offline next? → held for them; you mark it given by hand
                             └─ nobody waiting? → back to Available
```

**Statuses**: `Available`, `Reserved`, `On Loan`, `Reference Only` (the four fixed
workflow statuses), plus any extra "out of circulation" statuses you configure via
`STATUSES` (default `Unavailable`). Only `Available`, `Reserved` and `On Loan` books can be
reserved or queued; `Reference Only` and every extra status can't be taken out.

**One waiting list per book.** Each book has a single ordered `waitlist`, where every entry
is either a **website member** (who reserved online) or an **offline** person you added by
name because they asked in person or by phone. Because there's one true order, the position
a member is told when they join always matches what happens on return, and **"Mark returned"
always offers the book to whoever is genuinely next** — member or offline. From the admin
panel you can reorder entries, remove them, add offline people, and hand a book to someone
out of turn if you've arranged it. The public catalogue only ever shows the *number* waiting,
never who.

---

## Requirements

- **Node.js 18 or newer** (20+ recommended) — `node --version`
- A Linux machine (Raspberry Pi 3 or better is plenty; ~60 MB RAM in use)
- Optional: a domain and reverse proxy for public access over HTTPS
- Optional: SMTP credentials for outbound email

---

## Quick start

```bash
git clone https://github.com/YOURNAME/lending-library.git
cd lending-library
npm install
npm run setup        # interactive: name, URL, admin password, optional SMTP
npm start
```

Then open <http://localhost:3000/Library/> and <http://localhost:3000/Library/admin>.

> Testing locally over plain `http`? Session cookies are marked *secure* by default, so
> log in will not stick. Either answer the setup prompt with a `http://` URL (it sets
> `COOKIE_SECURE=false` for you) or run `COOKIE_SECURE=false npm start`.

Prefer to configure by hand? Copy `.env.example` to `.env`, then:

```bash
npm run gen-secret      # prints a SESSION_SECRET
npm run set-password    # prints an ADMIN_PASSWORD_HASH
cp data/books.sample.json data/books.json
echo "[]" > data/users.json
```

---

## Running it for real

### 1. Run it as a service (systemd)

```bash
sudo cp deploy/lending-library.service /etc/systemd/system/
sudo nano /etc/systemd/system/lending-library.service   # replace CHANGEME
sudo systemctl daemon-reload
sudo systemctl enable --now lending-library
sudo systemctl status lending-library --no-pager
```

Logs: `journalctl -u lending-library -e`

### 2. Put it behind a reverse proxy

The app listens on `127.0.0.1` and speaks plain HTTP. Terminate TLS in front of it.

**Caddy** (`deploy/Caddyfile.example`) — add inside your site block:

```
reverse_proxy /Library* 127.0.0.1:3000
```

Use `reverse_proxy /Library*`, **not** `handle_path`, so the `/Library` prefix is preserved.

**nginx** (`deploy/nginx.conf.example`) — add inside your `server { }` block:

```nginx
location /Library {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Set `TRUST_PROXY=1` in `.env` so the app sees real client IPs (0 if there's no proxy).

### 3. fail2ban (optional but recommended)

```bash
sudo cp deploy/fail2ban-filter.conf /etc/fail2ban/filter.d/lending-library.conf
# append deploy/fail2ban-jail.conf to /etc/fail2ban/jail.local, fixing the logpath
touch logs/auth.log
sudo systemctl restart fail2ban
sudo fail2ban-client status lending-library
```

Verify the pattern matches after a few bad logins:

```bash
sudo fail2ban-regex logs/auth.log /etc/fail2ban/filter.d/lending-library.conf
```

**Behind Cloudflare or another proxy?** A local firewall ban won't reach the visitor,
because traffic arrives from the proxy. Use `banaction = cloudflare-zone` (or your CDN's
equivalent) so bans are applied at the edge.

---

## Email setup

Email is **optional**. With `SMTP_HOST` blank the app still works: every verification and
reset link is written to `logs/mail.log`, and the admin panel shows a copyable link so you
can send it yourself. Configure SMTP when you want it automated.

Set four values in `.env`, then restart:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=library@example.com
SMTP_PASS=your-password-or-token
MAIL_FROM=library@example.com
```

Confirm it took effect — the startup line reports which mode it's in:

```bash
journalctl -u lending-library -n 5 --no-pager | grep "Library app"
# → Library app on http://127.0.0.1:3000/Library/  (email configured)
```

### Provider notes

| Provider | Host / port | Notes |
|---|---|---|
| **Proton Mail** | `smtp.protonmail.ch:587` | Needs an **SMTP submission token** (Settings → IMAP/SMTP). `SMTP_USER` and `MAIL_FROM` must both be the exact address the token was paired with, and it must be a custom-domain address. Availability varies by plan. |
| **Brevo** | `smtp-relay.brevo.com:587` | Free tier ~300 emails/day. `SMTP_USER` is your Brevo login, which may differ from `MAIL_FROM`. Verify your domain first. |
| **Gmail** | `smtp.gmail.com:587` | Requires an App Password (2FA on). Low sending limits. |
| **Fastmail / most hosts** | `:587` STARTTLS or `:465` TLS | Port 465 is detected automatically as implicit TLS. |

Test credentials independently of the app:

```bash
node -e "
require('dotenv')" 2>/dev/null; node -e "
const fs=require('fs');for(const l of fs.readFileSync('.env','utf8').split('\n')){const t=l.trim();if(!t||t[0]=='#')continue;const i=t.indexOf('=');process.env[t.slice(0,i)]=t.slice(i+1);}
const nm=require('nodemailer');
nm.createTransport({host:process.env.SMTP_HOST,port:+process.env.SMTP_PORT,secure:+process.env.SMTP_PORT===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}})
.verify().then(()=>console.log('SMTP OK')).catch(e=>console.log('SMTP FAILED:',e.message));"
```

> First emails from a brand-new sending address often land in spam until the address
> builds reputation. Check the spam folder before assuming something is broken.

---

## Configuration reference

All settings live in `.env`. Only the first four are required.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD_HASH` | — | **Required.** bcrypt hash; `npm run set-password` |
| `SESSION_SECRET` | — | **Required.** Long random string; `npm run gen-secret` |
| `PUBLIC_URL` | `http://localhost:PORT` | Full site URL, no trailing slash. Used to build email links — **must be correct or links break** |
| `BASE_PATH` | `/Library` | URL path to serve under. `/` for the domain root |
| `PORT` | `3000` | Listen port |
| `ADMIN_USER` | `admin` | Admin login name |
| `TRUST_PROXY` | `1` | Number of proxies in front (0 if direct). Affects client IPs |
| `COOKIE_SECURE` | `true` | Require HTTPS for session cookies. `false` only for local http testing |
| `LIBRARY_NAME` | `Lending Library` | Shown in page titles, headers and emails |
| `LIBRARY_LOCATION` | *(blank)* | Optional subtitle, e.g. `Bristol, England`. Omitted if blank |
| `GENRES` | *(built-in list)* | Seeds initial categories; edit later in the admin panel |
| `STATUSES` | `Unavailable` | Seeds initial extra statuses; edit later in the admin panel |
| `HOME_URL` | `PUBLIC_URL` | Where the "← Home" button links |
| `SMTP_HOST` | *(blank)* | Blank disables sending (links go to `logs/mail.log`) |
| `SMTP_PORT` | `587` | 465 is treated as implicit TLS |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP credentials |
| `MAIL_FROM` | `library@localhost` | From address on outgoing mail |
| `MAIL_FROM_NAME` | `LIBRARY_NAME` | Display name on outgoing mail |
| `DATA_FILE` / `USERS_FILE` | `data/*.json` | Override data file locations |
| `AUTH_LOG` / `MAIL_LOG` | `logs/*.log` | Override log locations |

---

## Customising

**Name and location** — `LIBRARY_NAME` and `LIBRARY_LOCATION` in `.env`. The title shows
with one word emphasised in the accent colour (e.g. "Green *Lane* Community Library").

**Colours and fonts** — edit the `:root { … }` CSS variables at the top of
`public/Library/index.html` and `admin.html`. Both pages are single self-contained files
with no build step; change and reload.

**Genres and statuses** — edit these from the admin panel under **Categories &
statuses**: add, rename, remove and reorder entries, then *Save*. Changes apply
immediately (no restart) and are stored in `data/settings.json`. One list drives the admin
dropdown, the catalogue's filter, badge colours (built-in entries keep their named
colours; custom ones cycle through a fallback palette), and server-side validation.

- **Genres** are fully editable. The first entry is the fallback for any book whose genre
  isn't in the list, so if you remove a genre, books using it show as that first entry
  until re-tagged (the admin dropdown flags the old value as *(removed)* so you can spot
  them).
- **Statuses**: the four workflow statuses (`Available`, `Reserved`, `On Loan`,
  `Reference Only`) are fixed because the lending logic depends on them. Anything you add
  is an "out of circulation" label — shown everywhere, but a book in one can't be reserved.

The `GENRES` and `STATUSES` env vars (see `.env.example`) only **seed** the initial lists
before you've saved anything from the panel; afterwards `data/settings.json` takes over.

**Emails** — plain HTML files in `lib/templates/`. Edit freely and restart. Available
tokens: `{{library_name}}` and `{{site_url}}` in all of them, plus
`{{verification_link}}` / `{{name}}` / `{{book_columns}}` (verify), `{{reset_link}}`
(reset), and `{{book_title}}` / `{{book_author}}` (waiting list, book ready).

**Book fields** — each book is a flat JSON object; add fields in `normaliseBook()` in
`server.js` and render them in the two HTML files.

---

## Data files and backups

```
data/books.json    the catalogue, including loans and per-book waiting lists
data/users.json    member accounts (bcrypt password hashes, never plaintext)
data/settings.json genres and statuses saved from the admin panel (auto-created)
logs/auth.log      login attempts — read by fail2ban
logs/mail.log      outgoing mail, only when SMTP is not configured
```

Both data files are plain JSON, safe to edit by hand while the app runs (it re-reads on
each request). Keep them valid JSON.

Back up:

```bash
# crontab -e
@daily tar czf ~/library-backup-$(date +\%F).tar.gz ~/lending-library/data
```

`users.json` is the one that really matters — a catalogue can be retyped, member accounts
can't.

---

## Security notes

What's in place:

- Passwords stored only as bcrypt hashes (cost 12); the admin password never leaves `.env`
- Session cookies are `httpOnly`, `sameSite=lax`, signed, and `secure` when `COOKIE_SECURE=true`
- Session ID regenerated on login (prevents session fixation)
- Rate limits: 10 logins / 15 min, 20 signups / hour, 8 resets / hour, 5 resends / hour, per IP
- Verification links expire in 24 h; reset links in 1 h, single use, invalidated by a resend
- Password reset and resend endpoints return **identical responses for known and unknown
  addresses**, so they can't be used to discover who's registered
- All catalogue writes validated and normalised server-side; unknown genres/statuses fall
  back to safe defaults
- Atomic writes and per-file locking, so concurrent requests can't corrupt or interleave
- The public API never returns borrower names, reservation lists or member emails

What you should still do:

- Serve it over **HTTPS** and keep `COOKIE_SECURE=true`
- Use a strong admin password and consider a non-obvious `ADMIN_USER`
- Set `TRUST_PROXY` correctly — too high lets clients spoof their IP past rate limits
- Consider restricting `/Library/admin` by IP, VPN, or an extra auth layer at the proxy
- Keep Node and your OS patched

There is **no self-service reset for the admin account** — deliberately, as it would be a
way in. If you lose it, run `npm run set-password`, paste the new hash into `.env`, restart.

---

## API reference

All paths are relative to `BASE_PATH`.

**Public**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/books` | Catalogue. No member identities |
| `GET` | `/api/me` | Current session |
| `POST` | `/api/signup` | `{name, email, password}` |
| `GET` | `/verify?token=` | Confirm email address |
| `POST` | `/api/login` | `{identifier, password}` — admin username or member email |
| `POST` | `/api/logout` | End session |
| `POST` | `/api/resend-verification` | `{email}` |
| `POST` | `/api/forgot-password` | `{email}` |
| `POST` | `/api/reset-password` | `{token, password}` |
| `GET` | `/reset?token=` | Reset form |

**Members** (session required)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/reserve` | `{id}` — reserve or join the waiting list |
| `POST` | `/api/cancel-reservation` | Cancel your own reservation |
| `GET` | `/api/my-holding` | What you currently hold |

**Admin** (admin session required)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/books` | Full catalogue incl. borrower and waiting list |
| `PUT` | `/api/books` | Replace the catalogue |
| `POST` | `/api/admin/books/give` | `{id, entryId}` — hand book to that waitlist entry |
| `POST` | `/api/admin/books/return` | `{id}` — mark returned, offer to next in line |
| `POST` | `/api/admin/books/waitlist/add` | `{id, name}` — add an offline person |
| `POST` | `/api/admin/books/waitlist/remove` | `{id, entryId}` — remove an entry |
| `POST` | `/api/admin/books/waitlist/move` | `{id, entryId, direction: up\|down}` — reorder |
| `GET` | `/api/admin/settings` | Current genres & statuses |
| `POST` | `/api/admin/settings` | `{genres[], statuses[]}` — save & apply immediately |
| `GET` | `/api/admin/users` | Members, with what each is holding |
| `POST` | `/api/admin/users/decision` | `{id, decision: approve\|reject}` |
| `POST` | `/api/admin/users/resend` | `{id}` — resend verification, returns the link |
| `POST` | `/api/admin/users/delete` | `{id}` — erase member and scrub their records |

---

## Troubleshooting

**502 / connection refused from the proxy**
The app isn't running or is on a different port.
`systemctl status lending-library` and check `PORT` in `.env` matches the proxy config.
A port clash shows as `EADDRINUSE` in `journalctl -u lending-library -e`.

**Startup says "email NOT configured" but SMTP is filled in**
The app only reads `.env` at boot — restart after editing. If it persists, check for
stray quotes or trailing spaces around the values.

**Emails never arrive**
Check spam first. Then `journalctl -u lending-library -f` while triggering a resend; a
`sendMail failed:` line gives the SMTP error verbatim. `Invalid login` usually means the
password/token is wrong or `SMTP_USER` isn't the address the credential belongs to.

**Verification links point to the wrong place**
`PUBLIC_URL` is wrong. It must be the full external URL, no trailing slash.

**Login doesn't stick / immediately logged out**
You're on plain `http` with `COOKIE_SECURE=true`. Use HTTPS, or set it to `false` for
local testing only.

**Members can't log in after verifying**
By design — they also need approving in the admin panel's Members section.

**Rate limit hit during testing**
Limits are per IP over 15–60 minutes. Restart the app to clear them.

**Nothing appears in the admin approval queue**
Accounts only reach it *after* the email is verified. Unverified ones sit in the
"Awaiting email verification" group, where you can resend the link or copy it directly.

---

## FAQ

**Can I run it at the domain root instead of `/Library`?**
Yes — set `BASE_PATH=/` and adjust the proxy accordingly.

**Can several people be admins?**
Not currently. There's one admin credential in `.env`. Members are separate accounts.

**Does it handle due dates, fines or renewals?**
No. It tracks who has what and who's waiting. Due dates would be a reasonable addition —
PRs welcome.

**Can members borrow more than one book?**
Not by default; the one-book limit is enforced in `/api/reserve`. Removing the
`holdingOf()` check lifts it.

**Do shared book links show a preview image on WhatsApp/Discord?**
No. The catalogue renders in the browser, so link previews show generic site metadata.
Per-book previews would need server-rendered meta tags.

**Is there a Docker image?**
Not provided. It's a single Node process — a three-line Dockerfile works if you want one.

**How many books/members does it handle?**
Fine into the low thousands of books. It rewrites the whole JSON file on save, so it's not
built for tens of thousands or for many simultaneous writers.

---

## Licence

MIT — see [LICENSE](LICENSE). Use it, change it, ship it.
