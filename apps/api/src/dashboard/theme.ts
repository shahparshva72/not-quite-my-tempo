// "Rehearsal Score" visual system, Stage light palette. See
// docs/DESIGN_PLAN.md for the reasoning behind each token and device.

export const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Bodoni+Moda:ital,opsz,wght@1,6..96,700..900&family=JetBrains+Mono:wght@400;600&display=swap";

export const styles = `
:root {
  color-scheme: dark;
  --paper: #0e1c1c;
  --surface: #152828;
  --ink: #e7f0ed;
  --graphite: #93aea9;
  --staff: #29413f;
  --red-pencil: #ff6461;
  --brass: #edb94e;
  --brass-ink: #0e1c1c;
  /* Steps between the tokens above, same teal hue: sunken wells, hover
     fills, and borders that need to read on --surface. */
  --well: #112222;
  --raised: #1a3131;
  --staff-strong: #36524f;
  --gutter: clamp(1rem, 4vw, 2rem);
  --measure: 38rem;
  --shell: 72rem;
  --radius: 10px;
  --radius-sm: 6px;
  --code: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Archivo", system-ui, sans-serif;
  font-variation-settings: "wdth" 100;
  font-size: 1rem; line-height: 1.55;
  min-height: 100vh; display: flex; flex-direction: column;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-underline-offset: 0.2em; }
:focus-visible { outline: 3px solid var(--brass); outline-offset: 3px; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
body pre, body code, body .code {
  font-family: var(--code);
  font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0;
}
code {
  font-size: 0.85em; background: var(--raised); border: 1px solid var(--staff);
  border-radius: 4px; padding: 0.05em 0.35em;
}
.icon { width: 1em; height: 1em; flex: none; vertical-align: -0.125em; }
.shell { width: 100%; max-width: var(--shell); margin: 0 auto; padding: 0 var(--gutter); }

/* Top bar */
.bar {
  position: sticky; top: 0; z-index: 10;
  background: rgb(14 28 28 / 0.88); backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--staff);
}
.bar-inner {
  display: flex; gap: 0.75rem 1.5rem; align-items: center;
  min-height: 3.75rem;
}
.wordmark {
  display: inline-flex; align-items: center; gap: 0.6rem;
  font-weight: 800; font-variation-settings: "wdth" 125;
  letter-spacing: -0.01em; text-decoration: none; font-size: 1rem;
  white-space: nowrap;
}
.logo {
  width: 1.75rem; height: 1.75rem; border-radius: var(--radius-sm);
  background: var(--brass); color: var(--brass-ink);
  display: grid; place-items: center; flex: none;
}
.logo svg { width: 1.1rem; height: 1.1rem; }
.nav { display: flex; gap: 0.25rem; margin-right: auto; }
.nav a {
  color: var(--graphite); text-decoration: none; font-weight: 600;
  font-size: 0.93rem; padding: 0.4rem 0.7rem; border-radius: var(--radius-sm);
}
.nav a:hover { color: var(--ink); background: var(--surface); }
.nav a[aria-current="page"] { color: var(--ink); background: var(--surface); }
.account { display: flex; gap: 0.75rem; align-items: center; color: var(--graphite); font-size: 0.93rem; }
.account form { display: inline; }
.account .who { display: inline-flex; align-items: center; gap: 0.5rem; }
.account-public { display: flex; gap: 0.5rem; align-items: center; }

main { flex: 1; padding: 2rem 0 4rem; }

/* Avatars: GitHub picture over the initial, which shows if it can't load */
.avatar {
  position: relative; display: inline-grid; place-items: center; flex: none;
  width: 1.75rem; height: 1.75rem; border-radius: 50%; overflow: hidden;
  background: var(--staff); color: var(--ink);
  font-weight: 700; font-size: 0.8rem; text-transform: uppercase;
}
.avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.avatar-lg { width: 2.5rem; height: 2.5rem; font-size: 1rem; border-radius: var(--radius-sm); }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  padding: 0.65rem 1.1rem; border-radius: var(--radius-sm);
  background: var(--brass); color: var(--brass-ink); border: 1px solid var(--brass);
  font: inherit; font-weight: 700; font-size: 0.95rem; line-height: 1.2;
  text-decoration: none; cursor: pointer; white-space: nowrap;
  transition: filter 120ms, background 120ms, border-color 120ms;
}
.btn:hover { filter: brightness(1.08); }
.btn-secondary { background: var(--surface); color: var(--ink); border-color: var(--staff-strong); }
.btn-secondary:hover { filter: none; background: var(--raised); }
.btn-ghost { background: transparent; color: var(--ink); border-color: transparent; }
.btn-ghost:hover { filter: none; background: var(--surface); }
.btn-danger { background: transparent; color: var(--red-pencil); border-color: var(--staff-strong); }
.btn-danger:hover { filter: none; border-color: var(--red-pencil); }
.btn-sm { padding: 0.4rem 0.75rem; font-size: 0.875rem; }
.btn-lg { padding: 0.85rem 1.4rem; font-size: 1.05rem; }
.link-button {
  background: none; border: 0; padding: 0; color: var(--ink);
  font: inherit; font-weight: 600; text-decoration: underline;
  text-underline-offset: 0.2em; cursor: pointer;
}
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }

/* Type */
h1, h2, h3 { margin: 0; line-height: 1.15; }
.page-title {
  font-size: clamp(1.75rem, 4vw, 2.25rem); font-weight: 800;
  font-variation-settings: "wdth" 75; margin: 0;
}
h2 {
  font-size: 1.35rem; font-weight: 800; font-variation-settings: "wdth" 85;
  margin: 0 0 1rem;
}
h3 { font-size: 1.05rem; font-weight: 700; margin: 0.2rem 0 0.35rem; }
p { margin: 0 0 1rem; max-width: var(--measure); }
.lede { font-size: 1.2rem; color: var(--ink); }
.quiet { color: var(--graphite); }
.fine { color: var(--graphite); font-size: 0.875rem; }
.eyebrow {
  display: block; color: var(--brass); font-weight: 700; font-size: 0.875rem;
  margin: 0 0 0.6rem;
}

/* Page header */
.crumbs {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
  margin: 0 0 1rem; color: var(--graphite); font-size: 0.9rem; max-width: none;
}
.crumbs a { color: var(--graphite); text-decoration: none; }
.crumbs a:hover { color: var(--ink); text-decoration: underline; }
.crumbs .sep { color: var(--staff-strong); }
.page-head {
  display: flex; flex-wrap: wrap; gap: 1rem 2rem;
  align-items: flex-end; justify-content: space-between; margin-bottom: 2rem;
}
.page-head p { margin: 0.4rem 0 0; }
.page-head form { align-self: center; }

/* Cards and panels */
.card {
  background: var(--surface); border: 1px solid var(--staff);
  border-radius: var(--radius);
}
.card-body { padding: 1.25rem 1.5rem; }
.card-head {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: center;
  padding: 1rem 1.5rem; border-bottom: 1px solid var(--staff);
}
.card-head h2 { margin: 0; font-size: 1.15rem; }
.card-foot {
  padding: 0.85rem 1.5rem; border-top: 1px solid var(--staff);
  background: var(--well); border-radius: 0 0 var(--radius) var(--radius);
}
.card-foot p { margin: 0; }
.stack { display: grid; gap: 1.5rem; }
.section-title { margin: 2.5rem 0 1rem; }

/* Badges */
.badge {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.15rem 0.6rem; border-radius: 999px;
  border: 1px solid var(--staff-strong); color: var(--graphite);
  font-size: 0.8rem; font-weight: 600; line-height: 1.5; white-space: nowrap;
}
.badge::before {
  content: ""; width: 0.45rem; height: 0.45rem; border-radius: 50%;
  background: currentColor; display: none;
}
.badge-dot::before { display: inline-block; }
.badge-on { color: var(--ink); border-color: var(--graphite); }
.badge-active { color: var(--brass); border-color: var(--brass); }
.badge-failed { color: var(--red-pencil); border-color: var(--red-pencil); }
.badge-brass { color: var(--brass-ink); background: var(--brass); border-color: var(--brass); }

/* Stat tiles */
.stats {
  display: grid; gap: 1rem; margin: 0 0 2rem;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
}
.stat { padding: 1.1rem 1.25rem; }
.stat p { margin: 0; }
.stat-label { color: var(--graphite); font-size: 0.875rem; font-weight: 600; }
.stat-value {
  font-size: 1.9rem; font-weight: 800; font-variation-settings: "wdth" 75;
  font-variant-numeric: tabular-nums; line-height: 1.2; margin-top: 0.25rem !important;
}

/* Usage meter (free reviews) */
.meter {
  width: 100%; max-width: 12rem; height: 0.4rem; border-radius: 999px;
  background: var(--staff); overflow: hidden;
}
.meter span { display: block; height: 100%; background: var(--brass); border-radius: inherit; }
.meter-empty span { background: var(--red-pencil); }

/* Landing hero: the headline on a staff, next to a sample review */
.hero {
  display: grid; gap: 3rem; align-items: center;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  padding: clamp(1rem, 5vw, 4rem) 0 clamp(3rem, 6vw, 5rem); overflow: hidden;
}
.pill {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.8rem 0.3rem 0.35rem; margin-bottom: 1.75rem;
  border: 1px solid var(--staff-strong); border-radius: 999px;
  background: var(--surface); color: var(--graphite);
  font-size: 0.85rem; font-weight: 600; text-decoration: none;
}
.pill .badge { padding: 0 0.5rem; }
.headline {
  margin: 0 0 1.5rem; font-weight: 900; line-height: 0.88;
  font-variation-settings: "wdth" 62; letter-spacing: -0.01em;
  font-size: clamp(3.5rem, 10vw, 7.5rem);
}
.on-staff { position: relative; display: block; isolation: isolate; }
.on-staff::before {
  content: ""; position: absolute; z-index: -1;
  left: calc(-1 * var(--gutter)); right: -100vw;
  top: 0.02em; height: calc(0.88em + 1px);
  background: repeating-linear-gradient(
    to bottom, var(--staff) 0 1px, transparent 1px 0.22em);
}
.hero .actions { margin: 2rem 0 1rem; }
.checks {
  list-style: none; margin: 1.25rem 0 0; padding: 0;
  display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem;
  color: var(--graphite); font-size: 0.9rem;
}
.checks li { display: inline-flex; align-items: center; gap: 0.4rem; }
.checks .icon { color: var(--brass); }

/* The sample review, dressed as a pull request comment */
.sample {
  position: relative; z-index: 1; margin: 0; background: var(--surface); border: 1px solid var(--staff);
  border-radius: var(--radius); overflow: hidden;
}
.sample-head {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--staff);
  background: var(--well); font-size: 0.875rem; color: var(--graphite);
}
.sample-head strong { color: var(--ink); }
.sample-head .badge { margin-left: auto; }
.sample-head .logo { width: 1.5rem; height: 1.5rem; border-radius: 50%; }
.sample-head .logo svg { width: 0.9rem; height: 0.9rem; }
.sample-body { padding: 1rem 1.25rem 1.5rem; }
.sample pre {
  margin: 0; font-size: 0.85rem; line-height: 1.7; overflow-x: auto;
  background: var(--well); border: 1px solid var(--staff); border-radius: var(--radius-sm);
  padding: 0.75rem 0.75rem 0.75rem 0.25rem;
}
.ln { color: var(--graphite); display: inline-block; width: 2.4em; text-align: right; padding-right: 0.8em; user-select: none; }
.flagged { position: relative; display: inline-block; }
.pencil {
  position: absolute; left: -0.8rem; top: -0.45rem; overflow: visible;
  width: calc(100% + 1.6rem); height: calc(100% + 0.9rem); pointer-events: none;
}
.pencil ellipse {
  fill: none; stroke: var(--red-pencil); stroke-width: 2.2;
  stroke-linecap: round; stroke-dasharray: 420; stroke-dashoffset: 420;
  animation: draw 900ms 400ms cubic-bezier(.6, .1, .3, 1) forwards;
}
@keyframes draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .pencil ellipse { animation: none; stroke-dashoffset: 0; }
}

/* Legal pages */
.legal { max-width: var(--measure); }
.legal h2 { margin: 2.5rem 0 0.75rem; }
.legal h3 { margin: 1.5rem 0 0.5rem; }
.legal ul { padding-left: 1.25rem; margin: 0 0 1rem; }
.legal li { margin-bottom: 0.4rem; }
.consent { margin: 1rem 0 0; }
.features + .fine { margin: 1.5rem 0 0; }

/* Landing sections */
section.band { padding: clamp(3rem, 7vw, 5rem) 0; border-top: 1px solid var(--staff); }
.band-head { max-width: 40rem; margin-bottom: 2.5rem; }
.band-head h2 { font-size: clamp(1.75rem, 4vw, 2.5rem); font-variation-settings: "wdth" 75; margin-bottom: 0.75rem; }
.band-head p { color: var(--graphite); font-size: 1.1rem; margin: 0; }
.features {
  display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
}
.feature { padding: 1.5rem; }
.feature p { margin: 0; color: var(--graphite); }
.feature h3 { margin: 1rem 0 0.4rem; }
.feature-icon {
  width: 2.5rem; height: 2.5rem; border-radius: var(--radius-sm);
  display: grid; place-items: center;
  background: var(--raised); border: 1px solid var(--staff-strong); color: var(--brass);
}
.feature-icon .icon { width: 1.25rem; height: 1.25rem; }
.feature-icon .dyn { font-size: 1.4rem; }

/* Pricing */
.plans {
  display: grid; gap: 1rem; max-width: 56rem;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
}
.plan { padding: 1.75rem; display: flex; flex-direction: column; }
.plan-featured { border-color: var(--brass); }
.plan-top { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
.plan h3 { margin: 0; font-size: 1.15rem; }
.price {
  font-size: 2.75rem; font-weight: 900; font-variation-settings: "wdth" 70;
  line-height: 1; margin: 1.25rem 0 0.25rem;
}
.price small { font-size: 1rem; font-weight: 600; color: var(--graphite); font-variation-settings: "wdth" 100; }
.plan > p { color: var(--graphite); }
.plan > p.price { color: var(--ink); }
.plan .checks { flex-direction: column; color: var(--ink); margin: 0.5rem 0 1.75rem; flex: 1; }
.plan .checks li { align-items: flex-start; }
.plan .checks .icon { margin-top: 0.2rem; }
.plan .btn { align-self: stretch; }

/* Closing call to action */
.cta {
  display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: center; justify-content: space-between;
  padding: clamp(1.75rem, 4vw, 2.75rem);
}
.cta h2 { font-size: clamp(1.6rem, 4vw, 2.25rem); font-variation-settings: "wdth" 75; margin: 0 0 0.5rem; }
.cta p { margin: 0; color: var(--graphite); }

/* Footer */
.footer { border-top: 1px solid var(--staff); color: var(--graphite); font-size: 0.875rem; }
.footer-inner {
  display: flex; flex-wrap: wrap; gap: 0.75rem 2rem; align-items: center;
  justify-content: space-between; padding-top: 1.5rem; padding-bottom: 1.5rem;
}
.footer p { margin: 0; }
.footer nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
.footer a { text-decoration: none; }
.footer a:hover { color: var(--ink); text-decoration: underline; }

/* Dynamic marks: finding severity as musical loudness */
.annotation {
  display: grid; grid-template-columns: 3rem minmax(0, 1fr); gap: 0.75rem 1rem;
}
.dyn {
  font-family: "Bodoni Moda", Didot, serif; font-style: italic; font-weight: 900;
  font-size: 1.9rem; line-height: 1; letter-spacing: -0.04em;
}
.dyn-critical { color: var(--red-pencil); }
.dyn-warning { color: var(--brass); }
.dyn-suggestion { color: var(--graphite); }
.sample .annotation { margin-top: 1.25rem; }
.annotation p { margin: 0; }
.annotation p + p { margin-top: 0.25rem; color: var(--graphite); }

/* Rehearsal marks: the onboarding sequence */
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; max-width: 52rem; }
.step {
  display: grid; grid-template-columns: 2.75rem minmax(0, 1fr); gap: 1.25rem;
  background: var(--surface); border: 1px solid var(--staff);
  border-radius: var(--radius); padding: 1.5rem;
}
.step > div > p:last-child { margin-bottom: 0; }
.step h3 { font-size: 1.15rem; }
.mark {
  width: 2.6rem; height: 2.6rem; display: grid; place-items: center;
  border: 2px solid var(--ink); border-radius: 4px; font-weight: 900; font-size: 1.3rem;
}
.step-done .mark { background: var(--ink); color: var(--paper); }
.step-done { border-color: var(--staff-strong); }
.progress {
  display: flex; align-items: center; gap: 1rem; margin: 0 0 1.5rem;
  color: var(--graphite); font-size: 0.9rem; max-width: 52rem;
}
.progress .meter { max-width: none; flex: 1; }
.landing-steps { grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); max-width: none; }
.landing-steps .step { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
.landing-steps p { color: var(--graphite); }

/* Repository list with review switches */
.repos { width: 100%; border-collapse: collapse; margin: 0.75rem 0 0; }
.repos td { padding: 0.75rem 0; border-bottom: 1px solid var(--staff); overflow-wrap: anywhere; }
.repos tr:last-child td { border-bottom: 0; }
.repos td:last-child { text-align: right; white-space: nowrap; padding-left: 1rem; }
.repo-name { display: inline-flex; gap: 0.6rem; align-items: center; font-weight: 600; }
.repo-name .icon { color: var(--graphite); }
.switch {
  display: inline-flex; align-items: center; gap: 0.6rem; padding: 0.25rem;
  background: none; border: 0; color: var(--ink); font: inherit; font-size: 0.93rem;
  cursor: pointer;
}
.track {
  position: relative; width: 2.6rem; height: 1.4rem; border-radius: 1rem;
  background: var(--staff); transition: background 150ms;
}
.track::after {
  content: ""; position: absolute; top: 0.2rem; left: 0.2rem;
  width: 1rem; height: 1rem; border-radius: 50%; background: var(--graphite);
  transition: transform 150ms, background 150ms;
}
.switch[aria-checked="true"] .track { background: var(--ink); }
.switch[aria-checked="true"] .track::after { transform: translateX(1.2rem); background: var(--paper); }
@media (prefers-reduced-motion: reduce) {
  .track, .track::after { transition: none; }
}

.review-state { display: inline-flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; justify-content: flex-end; align-items: center; }

/* Settings */
.key-status { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; margin: 0; max-width: none; }
.key-form { display: grid; gap: 0.5rem; max-width: 34rem; margin: 1.5rem 0 0; }
.key-form label { font-weight: 700; font-size: 0.93rem; }
.key-form input:not([type="radio"]), .key-form select {
  font: inherit; font-family: var(--code); color: var(--ink);
  background: var(--well); border: 1px solid var(--staff-strong);
  border-radius: var(--radius-sm); padding: 0.65rem 0.8rem;
}
.key-form input:focus, .key-form select:focus { border-color: var(--brass); outline: none; box-shadow: 0 0 0 3px var(--staff); }
.provider-choice { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; border: 0; padding: 0; margin: 0; }
.provider-choice legend { font-weight: 700; font-size: 0.93rem; padding: 0; margin-bottom: 0.4rem; }
.provider-choice label { display: inline-flex; gap: 0.4rem; align-items: center; font-weight: 400; }
.provider-choice input { accent-color: var(--brass); }
.key-form .btn { justify-self: start; margin-top: 0.5rem; }
.key-form p { margin: 0; }
.key-chip {
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;
  padding: 0.9rem 1rem; border: 1px solid var(--staff); border-radius: var(--radius-sm);
  background: var(--well);
}
.key-chip p { margin: 0; }
.key-chip .feature-icon { width: 2.25rem; height: 2.25rem; }
.danger-zone {
  display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between;
}
.danger-zone p { margin: 0; }
.notice {
  display: flex; gap: 0.75rem; align-items: flex-start;
  border: 1px solid var(--staff-strong); border-left: 3px solid var(--brass);
  border-radius: var(--radius-sm); padding: 0.75rem 1rem;
  background: var(--surface); max-width: 48rem; margin: 0 0 1.5rem;
}
.notice .icon { color: var(--brass); margin-top: 0.2rem; }
.notice-error { border-left-color: var(--red-pencil); }
.notice-error .icon { color: var(--red-pencil); }
.danger { color: var(--red-pencil); }

/* Message pages: one headline, one sentence, one action */
.message {
  max-width: 34rem; margin: clamp(1rem, 6vw, 4rem) auto; text-align: center;
  padding: clamp(2rem, 5vw, 3rem);
}
.message .page-title { font-size: clamp(2rem, 5vw, 2.75rem); font-variation-settings: "wdth" 62; margin-bottom: 1rem; }
.message p { margin-left: auto; margin-right: auto; color: var(--graphite); }
.message .logo { width: 3rem; height: 3rem; margin: 0 auto 1.5rem; border-radius: var(--radius); }
.message .logo svg { width: 1.75rem; height: 1.75rem; }
.message .btn { margin-top: 0.5rem; }

/* Workspaces on the dashboard */
.workspace { margin-bottom: 1.5rem; }
.workspace-head { gap: 0.75rem 1rem; }
.workspace-head h2 { margin: 0; font-size: 1.2rem; }
.workspace-title { display: flex; gap: 0.75rem; align-items: center; margin-right: auto; }
.workspace-title div { display: grid; gap: 0.15rem; }
.members td { vertical-align: middle; }
.members td:first-child { display: flex; align-items: center; gap: 0.75rem; }
.members td:nth-child(2) { white-space: nowrap; padding-left: 1rem; }

/* Entry lists: repositories on the dashboard, reviews on a repository */
.entries { list-style: none; margin: 0; padding: 0; }
.entry {
  display: grid; grid-template-columns: 2.5rem minmax(0, 1fr) auto; gap: 1rem;
  align-items: center; padding: 1rem 1.5rem; border-bottom: 1px solid var(--staff);
  transition: background 120ms;
}
.entry:hover { background: var(--raised); }
.entry:last-child { border-bottom: 0; border-radius: 0 0 var(--radius) var(--radius); }
.card > .entries:first-child .entry:first-child { border-radius: var(--radius) var(--radius) 0 0; }
.card > .entries:only-child .entry:only-child { border-radius: var(--radius); }
.entry-mark { display: grid; place-items: center; min-height: 2rem; }
.entry-mark .dyn { font-size: 1.6rem; }
.entry-mark .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--staff-strong); }
.entry p { margin: 0; max-width: none; }
.entry-title {
  display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: center;
  font-weight: 600; overflow-wrap: anywhere;
}
.entry-title a { font-size: 1.05rem; font-weight: 700; text-decoration: none; }
.entry-title a:hover { text-decoration: underline; }
.entry-title span { font-weight: 400; }
.entry-detail { margin-top: 0.2rem !important; font-size: 0.93rem; }
.entry-go { color: var(--graphite); display: inline-flex; }
.entry-go .icon { width: 1.1rem; height: 1.1rem; }
.state-active { color: var(--brass); }
.state-failed { color: var(--red-pencil); }
@media (prefers-reduced-motion: reduce) { .entry { transition: none; } }

.empty {
  text-align: center; padding: clamp(2rem, 6vw, 3.5rem) 1.5rem;
}
.empty p { margin-left: auto; margin-right: auto; color: var(--graphite); }
.empty .feature-icon { margin: 0 auto 1rem; width: 3rem; height: 3rem; }
.empty h2 { margin-bottom: 0.5rem; }

/* Review page */
.review-layout {
  display: grid; gap: 1.5rem; align-items: start;
  grid-template-columns: minmax(0, 1fr) 17rem;
}
.review-hero { padding: 1.75rem 1.75rem 1.5rem; }
.verdict {
  margin: 0 0 0.75rem; font-weight: 900; line-height: 0.95;
  font-variation-settings: "wdth" 62; font-size: clamp(2.6rem, 7vw, 4.25rem);
}
.verdict-failed { color: var(--red-pencil); }
.verdict-active { color: var(--brass); }
.verdict-quiet { color: var(--graphite); }
.review-meta { color: var(--graphite); margin: 0; }
.summary {
  margin: 1.25rem 0 0; padding-top: 1.25rem; border-top: 1px solid var(--staff);
  font-size: 1.1rem; max-width: 44rem;
}
.review-note { margin: 1rem 0 0; }
.findings-heading { margin: 2rem 0 1rem; }
.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.finding {
  padding: 1.25rem 1.5rem; background: var(--surface);
  border: 1px solid var(--staff); border-radius: var(--radius);
}
.finding-critical { border-left: 3px solid var(--red-pencil); }
.finding-warning { border-left: 3px solid var(--brass); }
.finding h3 { margin: 0.4rem 0 0.35rem; }
.finding p:last-child { color: var(--graphite); }
.finding-where {
  display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: center;
  color: var(--graphite); font-size: 0.875rem;
}
.finding-where .code {
  overflow-wrap: anywhere; color: var(--ink); background: var(--well);
  border: 1px solid var(--staff); border-radius: 4px; padding: 0.05rem 0.4rem;
}
.finding-where a { display: inline-flex; gap: 0.3rem; align-items: center; }
.aside { position: sticky; top: 5rem; display: grid; gap: 1rem; }
.aside h2 { font-size: 0.93rem; margin: 0 0 0.75rem; color: var(--graphite); font-variation-settings: "wdth" 100; }
.details { margin: 0; display: grid; gap: 0.6rem; font-size: 0.93rem; }
.details div { display: flex; justify-content: space-between; gap: 1rem; }
.details dt { color: var(--graphite); }
.details dd { margin: 0; color: var(--ink); text-align: right; overflow-wrap: anywhere; }
.tally { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
.tally li { display: grid; grid-template-columns: 2rem 1fr auto; align-items: center; gap: 0.5rem; font-size: 0.93rem; }
.tally .dyn { font-size: 1.3rem; }
.tally strong { font-variant-numeric: tabular-nums; }

/* Tables on dashboard pages */
.table-wrap { overflow-x: auto; margin-top: 1rem; }
table.data { border-collapse: collapse; width: 100%; }
table.data th, table.data td {
  text-align: left; padding: 0.6rem 0.75rem 0.6rem 0; vertical-align: top;
  border-bottom: 1px solid var(--staff); overflow-wrap: anywhere;
}
table.data th { color: var(--graphite); font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.status-completed { color: var(--ink); }
.status-failed, .status-cancelled { color: var(--red-pencil); }
.status-running, .status-queued { color: var(--brass); }
.severity-critical { color: var(--red-pencil); font-weight: 700; }
.severity-warning { color: var(--brass); }
.severity-suggestion { color: var(--graphite); }
td.finding { min-width: 16rem; }

@media (max-width: 56rem) {
  /* minmax(0, …) so the code sample scrolls instead of widening the page */
  .hero { grid-template-columns: minmax(0, 1fr); }
  .review-layout { grid-template-columns: minmax(0, 1fr); }
  .aside { position: static; }
}
@media (max-width: 40rem) {
  .wordmark-text, .account .who span, .hide-sm { display: none; }
  .bar-inner { gap: 0.5rem; }
  .nav a { padding: 0.4rem 0.5rem; }
  .card-body, .card-head, .card-foot { padding-left: 1rem; padding-right: 1rem; }
  .entry { padding: 0.9rem 1rem; grid-template-columns: 2rem minmax(0, 1fr); }
  .entry-go { display: none; }
  .step { grid-template-columns: minmax(0, 1fr); padding: 1.25rem; gap: 0.75rem; }
}
`;
