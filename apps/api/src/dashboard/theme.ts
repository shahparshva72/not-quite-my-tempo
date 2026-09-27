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
  --gutter: clamp(1rem, 4vw, 3rem);
  --measure: 38rem;
  --code: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font-family: "Archivo", system-ui, sans-serif;
  font-variation-settings: "wdth" 100;
  font-size: 1.0625rem; line-height: 1.55;
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
code { font-size: 0.9em; }

/* Top bar */
.bar {
  display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem;
  justify-content: space-between; align-items: center;
  padding: 1.25rem var(--gutter);
}
.wordmark {
  font-weight: 800; font-variation-settings: "wdth" 125;
  letter-spacing: -0.01em; text-decoration: none; font-size: 1.05rem;
}
.account { display: flex; gap: 1rem; align-items: center; color: var(--graphite); }
.account form { display: inline; }
main { padding: 0 var(--gutter) 4rem; max-width: 76rem; }

/* Buttons */
.btn {
  display: inline-block; padding: 0.7rem 1.2rem; border-radius: 2px;
  background: var(--brass); color: var(--brass-ink); border: 0;
  font: inherit; font-weight: 700; text-decoration: none; cursor: pointer;
}
.link-button {
  background: none; border: 0; padding: 0; color: var(--ink);
  font: inherit; font-weight: 600; text-decoration: underline;
  text-underline-offset: 0.2em; cursor: pointer;
}

/* Type */
h1, h2, h3 { margin: 0; line-height: 1.1; }
.page-title {
  font-size: 1.9rem; font-weight: 800; font-variation-settings: "wdth" 75;
  margin: 1.5rem 0 1rem;
}
h2 {
  font-size: 1.9rem; font-weight: 800; font-variation-settings: "wdth" 75;
  margin: 0 0 1.25rem;
}
h3 { font-size: 1.2rem; font-weight: 700; margin: 0.2rem 0 0.35rem; }
p { margin: 0 0 1rem; max-width: var(--measure); }
.lede { font-size: 1.2rem; }
.quiet { color: var(--graphite); }
.fine { color: var(--graphite); font-size: 0.9rem; }
section.band { padding: 3rem 0; border-top: 1px solid var(--staff); }

/* Landing hero: the headline on a staff, next to a sample review */
.hero {
  display: grid; gap: 3rem; align-items: center;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  padding: clamp(2rem, 6vw, 5rem) 0 4rem; overflow: hidden;
}
.headline {
  margin: 0 0 1.5rem; font-weight: 900; line-height: 0.88;
  font-variation-settings: "wdth" 62; letter-spacing: -0.01em;
  font-size: clamp(3.5rem, 11vw, 8.5rem);
}
.on-staff { position: relative; display: block; isolation: isolate; }
.on-staff::before {
  content: ""; position: absolute; z-index: -1;
  left: calc(-1 * var(--gutter)); right: -100vw;
  top: 0.02em; height: calc(0.88em + 1px);
  background: repeating-linear-gradient(
    to bottom, var(--staff) 0 1px, transparent 1px 0.22em);
}
.sample {
  margin: 0; background: var(--surface); border: 1px solid var(--staff);
  border-radius: 2px; padding: 1.25rem 1.25rem 1.5rem;
}
.sample pre { margin: 0; font-size: 0.85rem; line-height: 1.7; overflow-x: auto; }
.ln { color: var(--graphite); display: inline-block; width: 2.2em; user-select: none; }
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
.features {
  display: grid; gap: 2rem;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
}
.features p { margin: 0; }

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
.sample .annotation {
  margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--staff);
}
.annotation p { margin: 0; }

/* Rehearsal marks: the onboarding sequence */
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2.5rem; max-width: 48rem; }
.step { display: grid; grid-template-columns: 3rem minmax(0, 1fr); gap: 1.25rem; }
.mark {
  width: 2.6rem; height: 2.6rem; display: grid; place-items: center;
  border: 2px solid var(--ink); font-weight: 900; font-size: 1.3rem;
}
.step-done .mark { background: var(--ink); color: var(--paper); }

/* Repository list with review switches */
.repos { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; }
.repos td { padding: 0.7rem 0; border-bottom: 1px solid var(--staff); overflow-wrap: anywhere; }
.repos td:last-child { text-align: right; white-space: nowrap; padding-left: 1rem; }
.switch {
  display: inline-flex; align-items: center; gap: 0.6rem; padding: 0.25rem;
  background: none; border: 0; color: var(--ink); font: inherit; cursor: pointer;
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

/* Message pages: one headline, one sentence, one action */
.message { padding: clamp(2rem, 8vw, 6rem) 0; max-width: 40rem; }
.message .page-title { font-size: clamp(2.2rem, 6vw, 3.5rem); font-variation-settings: "wdth" 62; }

/* Entry lists: repositories on the dashboard, reviews on a repository */
.page-head {
  display: flex; flex-wrap: wrap; gap: 0.5rem 2rem;
  align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem;
}
.page-head .page-title { margin-bottom: 0; }
.page-head form { align-self: center; }
.entries { list-style: none; margin: 0 0 2rem; padding: 0; max-width: 56rem; }
.entry {
  display: grid; grid-template-columns: 3rem minmax(0, 1fr); gap: 1rem;
  padding: 1.1rem 0; border-bottom: 1px solid var(--staff);
}
.entries .entry:first-child { border-top: 1px solid var(--staff); }
.entry-mark { padding-top: 0.1rem; }
.entry p { margin: 0; max-width: none; }
.entry-title {
  display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: baseline;
  font-weight: 600; overflow-wrap: anywhere;
}
.entry-title a { font-size: 1.2rem; font-weight: 700; }
.entry-title span { font-weight: 400; }
.entry-detail { margin-top: 0.25rem; }
.state-active { color: var(--brass); }
.state-failed { color: var(--red-pencil); }

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
.crumbs { margin: 1rem 0 0; color: var(--graphite); }

@media (max-width: 52rem) {
  /* minmax(0, …) so the code sample scrolls instead of widening the page */
  .hero { grid-template-columns: minmax(0, 1fr); }
}
`;
