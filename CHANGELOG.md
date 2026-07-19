# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-07-19

### Added
- **Editable categories & statuses in the admin panel.** A new *Categories & statuses*
  section lets you add, rename, remove and reorder **genres** and **statuses** from the
  web UI — no code, no config files, no restart. Changes apply immediately and are saved
  to `data/settings.json`. One list drives the admin dropdowns, the catalogue's filters,
  badge colours (built-in entries keep their named colours; custom ones cycle through a
  fallback palette), and server-side validation.
  - **Genres** are fully editable; the first entry is the fallback for a book whose genre
    isn't in the list (the dropdown flags a removed value as *(removed)* so it isn't lost).
  - **Statuses**: the four workflow statuses (`Available`, `Reserved`, `On Loan`,
    `Reference Only`) are fixed because the lending logic depends on them; anything you add
    is an "out of circulation" label that can't be reserved.
  - The `GENRES` and `STATUSES` env vars now only **seed** the initial lists before you've
    saved from the panel; afterwards `data/settings.json` takes over.
- New endpoints: `GET`/`POST /api/admin/settings`.

### Changed
- A book in any non-circulating status (`Reference Only`, `Unavailable`, or a custom one)
  now consistently can't be reserved or queued. Previously an `Unavailable` book could
  still be added to a waiting list; it now shows an "out of circulation" note instead.

## [1.0.1] — 2026-07-19

### Fixed
- **Waiting-list ordering.** Each book previously tracked two independent things: a
  manual `queue` count of offline people and a separate `reservations` list of website
  members. On return, only the website reservations were consulted, so a member could be
  handed a book ahead of offline people who had been waiting longer — contradicting the
  position they were told when they joined.

### Changed
- **Unified waiting list.** A book now has one ordered `waitlist`, where each entry is
  either a website `member` or an `offline` person the admin adds by name. There is one
  true order, so the position a member is told on joining always matches what happens on
  return, and **Mark returned** offers the book to whoever is genuinely next — emailing
  them if they're a member, or holding it for hand-over if they're offline.
- **Admin panel.** The numeric "offline count" field is replaced by a per-book waiting
  list you can reorder (↑/↓), remove from (✕), and add offline people to by name.
  "Give" now targets a specific entry, so you can hand a book out of turn.
- **New admin endpoints:** `POST /api/admin/books/waitlist/add`, `.../remove`, `.../move`.
  `POST /api/admin/books/give` now takes `{id, entryId}` instead of `{id, email}`.
- Corrected `package.json` license field to `Apache-2.0`, matching the `LICENSE` file
  and source headers.

### Migration
- Automatic and non-destructive. On first read, an existing `books.json` in the old
  format is converted to the new `waitlist` (offline count → unnamed offline entries at
  the front, followed by website reservations in join order). After upgrading, open the
  admin panel and rename any "Unnamed (from old offline count)" entries to the real
  people. No manual data editing is required.

## [1.0.0]

- Initial release: public catalogue, member accounts with email verification and admin
  approval, password reset, reservations and waiting lists, loan tracking, templated
  emails with graceful no-SMTP fallback, rate limiting, fail2ban-friendly auth logging,
  and atomic JSON storage.
