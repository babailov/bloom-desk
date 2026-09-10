/**
 * The front door.
 *
 * Cloudflare Access no longer covers the whole hostname -- it covers exactly
 * `/enter`. Everything else reaches the Worker, where the gate in auth.ts still
 * demands a valid Access JWT before a single byte of data is served. What that
 * buys is this page: an unauthenticated browser gets os-bloom's own terminal
 * instead of Cloudflare's generic login screen, and clicks through to Access
 * when it is ready.
 *
 * The trade is deliberate and worth stating plainly. Before, two independent
 * layers refused an anonymous request: Access at the edge and the Worker's own
 * verification. Now only the second one does. The first layer was never what
 * protected the data -- auth.ts was, and is -- but it did keep anonymous
 * traffic from reaching the Worker at all. If that ever matters more than the
 * page, point the Access application back at the bare hostname and this file
 * goes unread.
 */

/**
 * Requests under this prefix skip the gate, because the sign-in page has to be
 * able to load its own artwork while signed out.
 *
 * It is an exact prefix test on an already-normalized pathname, and `ui/gate/`
 * holds nothing but that artwork. Adding a file there publishes it to the
 * internet; that is the whole contract of the directory.
 */
const PUBLIC_PREFIX = "/gate/";

export function isPublicPath(pathname: string): boolean {
  return pathname.startsWith(PUBLIC_PREFIX);
}

/** Why the visitor is looking at this page rather than the terminal. */
export type GateReason = "signed-out" | "denied";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const CSS = `
:root {
  --bg: #0a0e0a; --panel: #0e130e; --fg: #c8d0c8; --amber: #f5a623;
  --muted: #6a746a; --line: #1e261e; --down: #ef5350;
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--fg);
  font: 13px/1.45 "SF Mono", Menlo, Consolas, monospace;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; overflow: hidden;
}

/* The artwork sits behind everything, dimmed to terminal levels so the amber
   stays the brightest thing on screen. With ui/gate/hero.jpg absent, the
   gradient underneath is the page. */
.bg { position: fixed; inset: 0; z-index: 0;
      background: radial-gradient(120% 90% at 50% 0%, #16201a 0%, #0a0e0a 70%); }
.bg img { width: 100%; height: 100%; object-fit: cover;
          opacity: .38; filter: saturate(.55) contrast(1.08); }
.scrim { position: fixed; inset: 0; z-index: 0;
         background: radial-gradient(70% 65% at 50% 45%, rgba(10,14,10,.30), rgba(10,14,10,.94) 100%); }

.card {
  position: relative; z-index: 1; width: min(430px, 100%);
  background: rgba(14,19,14,.86); border: 1px solid var(--line);
  box-shadow: 0 24px 70px rgba(0,0,0,.6);
}
.head {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 8px 14px; border-bottom: 1px solid var(--line);
}
.brand { color: var(--amber); letter-spacing: 3px; font-weight: 700; }
.tag { color: var(--muted); font-size: 10px; letter-spacing: 2px; }
.tag.bad { color: var(--down); }

.body { padding: 22px 14px 18px; }
.rule { height: 1px; background: var(--line); margin: 0 0 16px; }
.line { margin-bottom: 8px; }
.line.muted { color: var(--muted); font-size: 11px; line-height: 1.6; }

/* Beveled like the workspace tabs, so the one control on the page belongs to
   the same machine as the terminal behind it. */
.enter {
  display: block; margin-top: 20px; padding: 9px 0;
  text-align: center; text-decoration: none;
  color: var(--amber); font-weight: 700; font-size: 12px; letter-spacing: 4px;
  background: linear-gradient(#4e564e, #272d27);
  border: 1px solid #060906; border-top-color: #788278; border-left-color: #6a746a;
}
.enter:hover { background: linear-gradient(#5c645c, #2f352f); color: #ffc95c; }
.enter:active { background: linear-gradient(#272d27, #4e564e); }
.enter:focus-visible { outline: 1px solid var(--amber); outline-offset: 2px; }

.foot {
  padding: 6px 14px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 10px;
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
}
.foot a { color: var(--muted); }
.foot a:hover { color: var(--amber); }

@media (max-width: 480px) { body { padding: 14px; } .body { padding: 18px 12px 14px; } }
@media (prefers-reduced-motion: no-preference) {
  .card { animation: rise .18s ease-out both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
}
`;

export interface GateOptions {
  reason: GateReason;
  /** Access team domain, for the sign-out escape hatch. Omitted in tests. */
  teamDomain?: string;
}

/**
 * The sign-in page itself. One link, no form: Access owns the credentials, and
 * anything this page collected would be theatre.
 */
export function gateHtml({ reason, teamDomain }: GateOptions): string {
  const denied = reason === "denied";

  const status = denied
    ? '<span class="tag bad">NOT ADMITTED</span>'
    : '<span class="tag">LOCKED</span>';

  const message = denied
    ? `<p class="line">That identity is not on the desk.</p>
      <p class="line muted">The sign-in worked, but this terminal admits one identity and yours is not
      it. Sign out, then come back as someone it knows.</p>`
    : `<p class="line">This terminal is private.</p>
      <p class="line muted">Markets, macro and positions for one desk. Sign in with the identity on the
      allow list and the tape picks up where it left off.</p>`;

  const cta = denied ? "TRY ANOTHER" : "ENTER";

  const signOut = teamDomain
    ? `<a href="${esc(teamDomain)}/cdn-cgi/access/logout">sign out</a>`
    : "<span></span>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OS-BLOOM</title>
<style>${CSS}</style>
</head>
<body>
  <div class="bg"><img src="/gate/hero.jpg" alt="" onerror="this.remove()"></div>
  <div class="scrim"></div>

  <main class="card">
    <div class="head"><span class="brand">OS-BLOOM</span>${status}</div>
    <div class="body">
      <div class="rule"></div>
      ${message}
      <a class="enter" href="/enter">${cta}</a>
    </div>
    <div class="foot"><span>CLOUDFLARE ACCESS</span>${signOut}</div>
  </main>
</body>
</html>
`;
}
