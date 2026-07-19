# Contributing

Thanks for taking an interest. This is a personal project maintained in
spare time — read the short version below before opening a pull request.

---

## The short version

- Pull requests are welcome.
- **AI-generated code is explicitly permitted.** No stigma, no special process.
- Everything merged is licensed under **Apache License 2.0**.
- Submitting a contribution does not give you any ownership, authority, or
  claim over this project. See [Ownership](#ownership) below.
- The maintainer reviews at their own discretion and may decline anything, for
  any reason or none.

---

## AI-generated contributions

Code written with help from an AI assistant — Claude, Copilot, Cursor, or
anything else — is welcome here on exactly the same terms as hand-written code.
It is judged on whether it works and whether it fits the project, not on how it
was produced.

Two conditions apply, and they are not about the AI:

1. **You must have the right to submit it.** You are the one making the
   contribution and agreeing to the licence terms, so you need to be confident
   the code is yours to give. That means not pasting in code from a source with
   an incompatible licence, whether a model reproduced it or you found it on
   Stack Overflow.

2. **You are responsible for it.** If a reviewer asks why a change works, "the
   AI wrote it" is not an answer. Understand what you are submitting. This is
   the same standard applied to code copied from a tutorial.

Mentioning that a change was AI-assisted is appreciated but not required. It
helps set review expectations, nothing more.

**Please do not open bulk or automated pull requests.** Drive-by PRs generated
across many repositories without engaging with this one will be closed without
review. The problem there is the lack of intent, not the tooling.

---

## Before you open a pull request

For anything beyond a small fix, **open an issue first**. A change can be
perfectly good and still not get merged because it does not fit where the
project is going — an issue costs you five minutes and can save you an evening.

Changes likely to be declined:

- New runtime dependencies, unless they earn their place. The dependency list is
  deliberately short.
- Build steps, bundlers, transpilers, or frontend frameworks. The UI is
  server-rendered HTML on purpose.
- Features that weaken the security posture: relaxing upload validation,
  accepting SVG, loosening authentication, or making private images easier to
  reach.
- Large refactors with no functional change.

Changes likely to be welcomed:

- Bug fixes, with a test that fails before and passes after.
- Documentation corrections, especially anything that misled you during setup.
- Reverse-proxy or fail2ban configurations for setups not yet covered.
- Accessibility improvements.
- Security fixes — though please read the disclosure note below first.

---

## Working on a change

```bash
git clone https://github.com/YOURNAME/contactsheet.git
cd contactsheet
npm install
npm test
```

`npm test` runs `test/smoke.sh`, which starts the app on a scratch directory and
exercises authentication, uploads, visibility rules and the security boundaries.
It must pass before a pull request is reviewed. It also runs in CI on Node 20
and 22.

If you change behaviour, add a case to the smoke test. If you change a security
boundary, add a case proving the boundary still holds.

A few house conventions:

- Two-space indent, semicolons, single quotes.
- Comments explain **why**, not what. If a line needs a comment to say what it
  does, rewrite the line.
- Keep commit messages in the imperative: "Add WebP dimension parsing".
- One logical change per pull request.

---

## Security issues

Please do **not** open a public issue for a vulnerability that could be exploited
against a running deployment. Use GitHub's private security advisory feature, or
contact the maintainer directly.

For hardening suggestions that are not exploitable — an extra header, a stricter
default — a normal issue is fine.

---

## Licensing

This project is licensed under the **Apache License 2.0**.

By submitting a contribution, you agree that:

- Your contribution is licensed under Apache License 2.0, the same terms as the
  project. This is the default under section 5 of that licence, stated here
  explicitly so there is no ambiguity.
- You have the right to grant that licence — the work is yours, or you have
  permission from whoever holds the rights to it.
- You grant the patent licence described in section 3 of the Apache Licence for
  any patent claims your contribution necessarily infringes.

There is no separate CLA to sign. Opening a pull request is the agreement.

If you cannot agree to those terms, please do not submit code. Bug reports and
suggestions are still very welcome.

---

## Ownership

To state this plainly, because it occasionally needs stating:

**Contributing does not give you any rights over this project.**

Specifically, having a contribution merged does not grant you:

- any ownership stake, or any claim over the project name, domain or hosting;
- any say in the project's direction, roadmap or governance;
- any right to be consulted about future decisions, including relicensing,
  archiving, or the project being taken in a direction you dislike;
- commit access, maintainer status, or any position of authority;
- any entitlement to have future contributions accepted, reviewed, or responded
  to at all.

You keep copyright in what you wrote, and you are credited in the git history.
That is what you get, and it is what every contributor to every project of this
kind gets.

The maintainer retains sole authority over what is merged, what is reverted, and
where the project goes. Pull requests may be closed without explanation.
Contributions may be modified, rewritten, or later removed entirely. Issues may
go unanswered indefinitely — this is a spare-time project, not a product with a
support obligation.

None of this is meant unkindly. Contributions are genuinely appreciated. It is
written down so that expectations are set before anyone invests their time.

---

## Code of conduct

Be decent to people. Discuss the code, not the person who wrote it. The
maintainer will remove comments and block accounts at their discretion, without
a formal process.

---

*These terms are a plain-language description of how this project operates, not
legal advice. The Apache License 2.0 text in [LICENSE](LICENSE) governs, and
where this document and the licence disagree, the licence wins.*
