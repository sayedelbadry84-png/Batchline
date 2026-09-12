import type { NextConfig } from "next";

// Security audit (2026-09-12): the app shipped with no application-level
// security headers at all — no clickjacking defence, no MIME-sniffing
// defence, no referrer policy, no feature policy.
//
// What is here is deliberately the set that can be turned on without
// guessing about this app's runtime, and what is NOT here is called out
// below rather than shipped half-configured.
const securityHeaders = [
  // Clickjacking. The app embeds nothing and is embedded nowhere (no
  // <iframe> anywhere in src/), so the strictest value is also the
  // correct one. frame-ancestors is the modern form; X-Frame-Options is
  // kept for older browsers that ignore CSP.
  { key: "Content-Security-Policy", value: ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join("; ") },
  { key: "X-Frame-Options", value: "DENY" },
  // Stops a browser second-guessing Content-Type — relevant here because
  // /api/files streams user-uploaded delivery photos.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Full URLs of this app leak record ids (…/production/<ticketId>). Send
  // the origin only, and only to same-protocol destinations.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Everything the app does not use is denied outright. `camera=(self)`
  // is NOT an oversight: the driver's delivery-photo input is
  // `capture="environment"`, which some browsers gate on this policy —
  // denying it would break photo capture on the one screen that needs it.
  {
    key: "Permissions-Policy",
    value: ["accelerometer=()", "autoplay=()", "camera=(self)", "display-capture=()", "encrypted-media=()", "fullscreen=(self)", "geolocation=()", "gyroscope=()", "magnetometer=()", "microphone=()", "midi=()", "payment=()", "usb=()", "xr-spatial-tracking=()"].join(", "),
  },
];

// Deliberately NOT set here, with the reason, so the next person does not
// assume they were forgotten:
//
// * `script-src` / `style-src`. A useful value needs a per-request nonce,
//   which needs middleware this app does not have, and the root layout
//   emits an inline <style> for the per-site accent colour
//   (accentThemeCss) that a nonce-less policy would have to allow with
//   'unsafe-inline' — which buys nothing against XSS. Shipping a
//   permissive script-src would look like protection while providing
//   none, so the directive is left off until the nonce is plumbed.
//
// * `Strict-Transport-Security`. Vercel already sends HSTS for its own
//   domains, and setting it here would also apply to any custom hostname
//   this project serves. A hostname that is not fully HTTPS becomes
//   unreachable for max-age seconds, and that is not a mistake anyone can
//   undo from the browser side. Add it once every production hostname is
//   confirmed HTTPS-only — see prisma/MIGRATIONS.md for how this repo
//   treats irreversible operations.
const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
