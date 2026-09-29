# Design Plan: "Rehearsal Score"

A visual redesign of every server-rendered page (`apps/api/src/dashboard/views.ts`)
before the product opens to the public. The working reference is
[`docs/design/style-tile.html`](./design/style-tile.html): open it in a browser
to see the direction and switch between the three candidate palettes.

## 1. Brief

- **Subject**: Fletcher, a code reviewer for GitHub pull requests with the
  voice of a demanding conservatory band director ("not quite my tempo").
- **Audience**: developers and small teams who install a GitHub App. They
  arrive from a link, decide in seconds, sign in with GitHub, and later
  come back to see why a review said what it said.
- **Primary jobs**, in order:
  1. Landing: understand what Fletcher does and sign in.
  2. Onboarding: install on GitHub, choose repositories, get a first review.
  3. Dashboard: see reviews per repository and read one review in full.

## 2. What's wrong today

| Problem                                                                                                                                         | Where                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Near-black background, one amber accent, monospace everywhere. This is the most common generated-UI look and has nothing to do with the subject | `styles` in `views.ts`                  |
| Every page is a table in the same weight, so nothing leads. A run page shows a tiny status and then a grid                                      | `repositoryRunsPage`, `runFindingsPage` |
| Severity is only a colored word ("warning"), and verdicts are not shown at all                                                                  | findings table                          |
| Metadata is joined with middle dots (`sha · trigger · status · model`), which reads as template chrome                                          | run header, dashboard header            |
| Raw internals shown to users: GitHub comment IDs, run IDs as the main link, trigger names like `synchronize`                                    | runs and findings tables                |
| Sign-in failures return JSON error bodies to a person in a browser                                                                              | `auth/routes.ts` (7 `c.json` responses) |
| No landing content beyond one sentence; no pricing or trial explanation                                                                         | `landingPage`                           |

## 3. Direction: the rehearsal score

Fletcher's world is the band room: printed scores, tempo markings, and the
director's red pencil. The UI is **a conductor's score marked up in pencil**.
The UI is dark only: the score is read under stage light in an empty
rehearsal hall, in the teal-black of the film's color grade. The page is quiet, the type is formal, and the only loud
thing on it is the correction.

Every musical device carries real information. None are decorative:

| Device                                                    | Meaning in the product                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Dynamic marks** _ff / mf / p_ set in bold italic Bodoni | Finding severity: critical / warning / suggestion. Loudness is the one scale musicians and readers both already know |
| **Red pencil**                                            | Critical findings, the "not quite my tempo" verdict, and destructive actions. Used nowhere else                      |
| **Rehearsal marks** (boxed **A B C**)                     | Numbered sequences only: the onboarding steps. The lists that were misusing numbers get none                         |
| **Staff lines** (five hairlines)                          | Appear once, running through the landing headline. That's the memorable moment; they are not reused as dividers      |

**Where the boldness goes**: the landing hero. The headline sits on a staff
next to a real sample review in which a red-pencil circle draws once around
the faulty line. Everything else is disciplined and quiet.

### Review against the brief (first draft → revision)

My first draft for this brief was a **dark "jazz club" theme**: black
background, brass accent, Blue Note-style condensed type. That is generic
look #2 again (near-black with one warm accent), and it is almost what the
app already has. Revisions:

- **A colored dark instead of black.** The background is the teal-black
  of Whiplash's film grade, `#0E1C1C`, never `#111`. Teal is the
  complement of the red pencil and the brass, so the accents read as
  deliberate against it. (A light "paper" version was tried and dropped:
  it looked washed out, and the product is dark only.)
- **The accent is the red pencil, not brass.** Brass stays as the one
  call-to-action color. Red has a single meaning: Fletcher objects.
- **Dropped Blue Note record-cover blocks.** They are a jazz cliché, and
  they are about records, not rehearsal. The score and the pencil are what
  this specific character works with.
- **Dropped all-monospace UI.** Monospace is used only for code, file
  paths, and commit SHAs, which is real data that should look like code.
- **Dropped middle-dot metadata strings.** They become short sentences:
  "Pull request 42 in not-my-tempo/app, reviewed 2 minutes ago".

## 4. Tokens

### Color

Dark only. There is no light theme and no `prefers-color-scheme` switch;
set `color-scheme: dark` so form controls and scrollbars match.

Three candidate palettes were built and compared on the same content in
the style tile (`?palette=midnight|band-room|stage-light`). Each comes from
Fletcher's world:

| Palette                  | Background | Idea                                                                  |
| ------------------------ | ---------- | --------------------------------------------------------------------- |
| **Stage light** (chosen) | `#0E1C1C`  | Whiplash's teal-black film grade: a rehearsal hall lit from the stage |
| Midnight score           | `#141A2E`  | Conductor's navy                                                      |
| Band room                | `#1A1411`  | Dark walnut paneling under tungsten light                             |

**Chosen: Stage light** (decided 2026-09-28). It is the most cinematic of
the three and ties the product to the film directly. Teal sits opposite
red and amber on the color wheel, so critical (red pencil), warning (brass),
and suggestion (graphite) still separate at a glance. The red pencil was
kept on the warm, slightly orange side (`#FF6461`) so the teal field does
not mute it. Keep an eye on this in the implementation screenshots, and do
not reuse red at low opacity (tinted red over teal turns brown).

Stage light tokens:

| Token          | Hex       | Use                                                                   |
| -------------- | --------- | --------------------------------------------------------------------- |
| `--paper`      | `#0E1C1C` | Page background                                                       |
| `--surface`    | `#152828` | Sample review, code blocks, raised panels                             |
| `--ink`        | `#E7F0ED` | Text, headlines, "on" switches, completed rehearsal marks             |
| `--graphite`   | `#93AEA9` | Secondary text, _p_ marks, line numbers                               |
| `--staff`      | `#29413F` | Hairlines, borders, "off" switches                                    |
| `--red-pencil` | `#FF6461` | _ff_, the "not quite my tempo" verdict, failures, destructive actions |
| `--brass`      | `#EDB94E` | Primary button fill, focus ring, _mf_ marks                           |
| `--brass-ink`  | `#0E1C1C` | Text on brass buttons                                                 |

Three in-between shades were added in the SaaS shell revision (section 10).
They use the same teal hue and never carry meaning on their own:

| Token            | Hex       | Use                                                     |
| ---------------- | --------- | ------------------------------------------------------- |
| `--well`         | `#112222` | Sunken areas: inputs, code blocks, card footers         |
| `--raised`       | `#1A3131` | Hover fill on rows and secondary buttons, inline `code` |
| `--staff-strong` | `#36524F` | Borders that must read on `--surface`, badge outlines   |

Measured contrast on `--paper` (WCAG): ink 15.1:1, graphite 7.4:1, red
pencil 6.0:1 (5.3:1 on `--surface`), brass 9.7:1, and button text on brass
9.7:1. All pass AA for body text, and ink and brass pass AAA. `--staff`
(1.6:1) is for lines only, never text. Status is always stated in words as
well as color.

### Type

| Family                               | Role                      | Why                                                                                                                       |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Archivo** (variable, width 62–125) | Headlines and all UI text | Grotesk with a real width axis. Condensed 62 for the headline and verdicts, 125 (expanded) for the wordmark, 100 for body |
| **Bodoni Moda** Italic 700–900       | Dynamic marks only        | Printed scores set _ff_ and _mf_ in heavy Didone italics. This face never sets words                                      |
| **JetBrains Mono**                   | Code, paths, SHAs         | Ligatures and contextual alternates off (`calt 0`), so `=>` stays `=>`                                                    |

Loaded from Google Fonts with `display=swap` and one `<link>`, with system
fallbacks.

Scale: major third (1.25) from a 17px (1.0625rem) body.

| Step | Size                          | Use                                                            |
| ---- | ----------------------------- | -------------------------------------------------------------- |
| −1   | 0.85rem                       | Code, file paths, fine print                                   |
| 0    | 1.0625rem                     | Body, table cells, buttons                                     |
| 1    | 1.2rem                        | Lede, step headings                                            |
| 2    | 1.9rem                        | Page headings (width 75), dynamic marks                        |
| 3    | 3rem                          | Verdict on a review page (width 62)                            |
| hero | `clamp(3.5rem, 11vw, 8.5rem)` | Landing headline only (width 62, weight 900, line-height 0.88) |

Rules: sentence case everywhere; no all-caps labels; no accenting one word
in a headline; line length at most 38rem (about 70 characters).

### Space, shape, motion

- Spacing: 0.25rem base; section rhythm 3rem; page gutter `clamp(1rem, 4vw, 3rem)`.
- Radius: 10px on cards and panels, 6px on buttons, inputs, and icon tiles,
  4px on rehearsal marks and inline code; badges and switches are fully
  round. (Revised from 2px in section 10.) No shadows; depth comes from
  `--surface` against `--paper` and one `--staff` border, never from
  shadows (they disappear on dark).
- Motion: one moment only, the red-pencil circle on the landing sample
  (900ms stroke draw, 400ms delay). Switches animate 150ms because that
  motion answers a click. Both honor `prefers-reduced-motion`.
- Focus: `3px solid var(--brass)`, 3px offset, on every interactive element.

## 5. Pages

Every page shares one top bar and one footer; see section 10 for the
current shell. The wireframes below record the original page structure;
section 10 lists what the SaaS shell revision changed on each page.

### Landing `/`

```
┌──────────────────────────────────────────────────────────────────┐
│ Not Quite My Tempo                                      Sign in  │
│                                                                  │
│ ═══Not═quite═my═════════════  ┌───────────────────────────────┐ │
│ ═══tempo.═══════════════════  │ src/tempo.ts in pull request 42│ │
│                               │ 12 export const beatLength …  │ │
│ Fletcher reviews every pull   │ 14 (return bar.duration/beats)│ │ ← red pencil
│ request you open…             │ ───────────────────────────── │ │
│                               │ ff  Were you rushing or …     │ │
│ [ Sign in with GitHub ]       └───────────────────────────────┘ │
│ Free with your own Gemini API key. Your first 5 reviews are on us.│
├──────────────────────────────────────────────────────────────────┤
│ What happens: three short paragraphs, left aligned              │
│  • He reviews every pull request and every push                  │
│  • Each comment is on the exact line and says how to fix it      │
│  • /fletcher again asks for another review                       │
├──────────────────────────────────────────────────────────────────┤
│ Pricing: two plain columns                                       │
│  Your own key: free                 Fletcher's key: paid plan    │
├──────────────────────────────────────────────────────────────────┤
│ Your code goes to Google's Gemini API to be reviewed. Privacy →  │
└──────────────────────────────────────────────────────────────────┘
```

Two columns on desktop; on phones the sample review stacks under the
button. Left aligned throughout. The pricing section shows the free
bring-your-own-key plan and marks the hosted plan "Coming soon" with no
price until Phase 16 (billing) ships.

### Onboarding `/onboarding`

```
 Set up Fletcher
 [A]  Install Fletcher on GitHub                         ← filled when done
      Installed on not-my-tempo. [Add or remove repositories on GitHub]
 [B]  Choose which repositories get reviews
      not-my-tempo/app .................... Reviews on  (●━)
      not-my-tempo/site ................... Reviews off (━○)
 [C]  Open a pull request
      Fletcher reviews it within a minute. Comment /fletcher again …
```

- Rehearsal marks fill in with ink as steps complete: A when an
  installation exists, B when a repository has reviews on, C when a first
  run exists.
- The switch is a real `<button role="switch" aria-checked>` inside the
  existing POST form, so it works without JavaScript. The visible label
  states the current state ("Reviews on").
- Empty B: "Repositories you allow on GitHub appear here."

### Dashboard `/dashboard`

```
 Your repositories                                    [Set up another]
 not-my-tempo/app      Reviews on    Last review 2 min ago:  ff Not quite my tempo
 not-my-tempo/site     Reviews off   No reviews yet
 ─────────────────────────────────────────────────────────────────
 This month: 14 reviews, 182,300 tokens            (usage, quiet)
```

- The list leads with **what happened last**, not token counts. Tokens
  move to one quiet usage line, which later carries the trial counter
  ("3 of 5 free reviews left").
- Empty state: "Install Fletcher on a repository to get your first review"
  with the primary button.

### Repository `/dashboard/repositories/:id`

```
 not-my-tempo/app                                   Reviews on (●━)
 Pull request 42   ff  Not quite my tempo.   2 min ago   Review →
 Pull request 41   —   Reviewing…            just now
 Pull request 40   ✕   Failed: Gemini quota  1 hr ago    Try again
```

- Rows are pull requests, each linking to GitHub and to the review. Run
  IDs, trigger names, and models move to the review page.
- Failed runs say what failed in plain words, from `errorCode`.

### Review `/dashboard/runs/:id`

```
 Not quite my tempo.                                 ← verdict, width 62, red
 Pull request 42 in not-my-tempo/app, reviewed 2 minutes ago. View on GitHub
 Fletcher's summary paragraph.
 ff  src/tempo.ts:14                    View comment on GitHub
     Division by zero on an empty bar
     A 0/4 signature divides by zero …
 mf  src/metronome.ts:31 …
 ─────
 Commit a1b2c3d · gemini-3.8-flash · 1,200 tokens     (quiet details, a <dl>)
```

- Verdict colors: "Not quite my tempo." in red pencil, "Almost." in ink,
  "…Good job." in ink with the dynamic _p_.
- Empty and non-success states keep today's accurate wording (failed,
  skipped, in progress), set as the headline in place of a verdict.
- **Needs data that is not stored yet**: `verdict` and `summary` on
  `review_runs` (already listed in Phase 14). Until they exist, the headline
  comes from the highest severity found.

### Other pages

- **Waiting for approval**, **not found**, and **sign-in errors** use one
  simple message layout: a headline, one sentence on what happened, and one
  action. Sign-in failures in `auth/routes.ts` switch from JSON to this HTML
  page for browser requests.

## 6. Copy changes

| Today                                    | New                                                    |
| ---------------------------------------- | ------------------------------------------------------ |
| "Manage repositories"                    | "Set up another repository" / "Choose repositories"    |
| `#12` run links, `synchronize`, `opened` | "Pull request 42", "New push", "Opened", "Asked again" |
| "Comment" column of GitHub comment IDs   | "View comment on GitHub" link                          |
| "Not my chart. Back to the band."        | "This page doesn't exist. Go to your repositories."    |
| JSON `oauth_failed`                      | "GitHub sign-in didn't finish. Sign in again."         |

Fletcher's voice belongs to the review content he writes. The interface
around it stays plain and direct, so errors never mock the user.

## 7. Implementation

Server-rendered Hono `html` templates stay. No framework and no build step.

1. **Foundation**
   - Split `views.ts` into `dashboard/theme.ts` (tokens, base CSS, font
     link), `dashboard/components.ts` (top bar, button, switch, dynamic
     mark, rehearsal mark, message page), and one module per page.
   - Serve the CSS inline as today (it stays under 10KB); revisit a cached
     `/assets/app.css` if it grows.
   - Check the contrast targets.
2. **Landing, onboarding, and message pages** (done 2026-09-28). Landing hero with the staff
   and pencil, onboarding with rehearsal marks and switches, and HTML error
   pages for sign-in failures.
3. **Dashboard and repository pages** (done 2026-09-28). Last-review summary per repository,
   pull-request rows, and plain status wording.
4. **Review page** (done 2026-09-28; migration `0004` adds `verdict` and `summary`). Needs the Phase 14 migration for `verdict` and
   `summary`, and PR/comment URLs built from `owner`, `name`, and
   `githubCommentId`.
5. **Verification** (done 2026-09-28 for all pages at 375px and desktop, plus keyboard focus).
   - Screenshots at 375px and 1280px.
   - Keyboard-only pass.
   - Reduced-motion check.
   - Update the tests that assert on changed text: `dashboard.test.ts`
     (run ID `#42`, `warning`, `queued`), `onboarding.test.ts`, and
     `auth-routes.test.ts` (JSON errors become HTML for browsers).

Each step is one PR and keeps `pnpm lint`, `format:check`, `typecheck`,
`build`, and `test` green.

## 8. Naming (decided 2026-09-28)

- **Not Quite My Tempo** is the product and the site, at `notmytempo.dev`.
  It is the wordmark, the page title suffix, and the name in legal and
  billing copy.
- **Fletcher** is the reviewer and the name used everywhere else: the
  GitHub App users install, the author of review comments, and the subject
  of interface copy ("Install Fletcher on GitHub", "Fletcher reviews it
  within a minute", "Turn Fletcher off for this repository").
- Name the GitHub App "Fletcher" if the name is free on GitHub; App names
  are global, so a fallback like "Fletcher Review" keeps the bot name first.

## 9. Open questions

- **Illustration or photography.** The plan uses none. A drawn baton or
  metronome could come later, but the sample review already shows the
  product better than art would.

## 10. SaaS shell revision (2026-09-30)

A layout pass so the product reads as a finished SaaS app. The palette,
type, dynamic marks, rehearsal marks, staff, and red pencil are unchanged.

- **Shell.** A sticky top bar (blurred `--paper`, `--staff` bottom border)
  with a brass logo tile holding a metronome glyph, the wordmark, and
  section navigation: "How it works / Pricing / Privacy" signed out,
  "Repositories / Setup" signed in (`aria-current="page"` on the current
  one). Signed out shows "Sign in" and a brass "Get started"; signed in
  shows the GitHub avatar, "Signed in as …", and a secondary "Sign out"
  button. Content sits in a centered 72rem column; every page ends with a
  footer. Below 40rem the wordmark text and login hide, leaving the logo.
- **Components** (`dashboard/components.ts`): stroke icons, the GitHub
  mark, `avatar` (GitHub picture from `avatars.githubusercontent.com` over
  the login's initial, so a failed load still shows something), `pageHead`,
  `crumbs`, and `reviewsBadge`. Buttons come in primary (brass), secondary,
  ghost, and danger (red pencil outline), each in small and large sizes.
- **Cards** replace bare lists: `--surface` fill, `--staff` border, a
  header row, and an optional `--well` footer.
- **Landing.** A "GitHub App" badge line above the headline; primary and
  secondary buttons; the sample review framed as a pull request comment
  by Fletcher. New sections: feature cards, the three setup steps, pricing
  cards, privacy cards, and a closing sign-in banner.
- **Dashboard.** Stat tiles (reviews, repositories reviewed, workspaces,
  Gemini tokens); one card per workspace with Members and Settings
  buttons, clickable repository rows, and a free-review meter in the
  card footer (brass, red pencil when used up).
- **Repository and review pages.** Breadcrumbs. Reviews list in a card.
  The review page puts the verdict and summary in a card, each finding in
  its own card with a red pencil or brass left edge for critical and
  warning, and a sticky side panel with "View on GitHub", a severity tally,
  and details.
- **Settings, members, onboarding, messages.** Settings has a key card and
  a separate "Remove key" section; members show avatars and role badges;
  onboarding shows a progress bar and each step as a card; message pages
  are one centered card with the logo.
- Rows without a dynamic mark show a small `--staff-strong` dot so the
  mark column stays aligned.
