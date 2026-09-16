import Link from "next/link";
import { ui } from "@/lib/ui";

// Deliberately says nothing about WHAT was refused.
//
// This page used to read `?module=` from the URL and print it back
// ("Your account doesn't have access to users"). Two problems with that,
// both found by an end-to-end pass. It named the resource a caller had
// been refused, which is more than a refusal needs to say. And it
// reflected arbitrary text from the query string into a trusted-looking
// sentence, so anyone could send a link reading "doesn't have access to
// <whatever they typed>". React escapes it, so it was never script
// injection — but it was still the app vouching for words it did not
// write.
//
// What this page does NOT do is pretend the route is missing. The module
// screens (users, audit log, permissions…) are the app's own navigation,
// the same for every tenant, so a 404 would hide nothing and would tell a
// signed-in operator their link is broken when it is not. Per-RECORD
// refusals are a different case and are already opaque: a record outside
// the caller's site is looked up with the scope inside the query and
// comes back as a genuine not-found (AGENTS.md rule 2).
export default function AccessDeniedPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className={ui.eyebrow}>Access denied</div>
      <h1 className={ui.h1}>You can&apos;t open this page</h1>
      <p className={`${ui.intro} max-w-xl`}>
        Your account&apos;s role doesn&apos;t include access to it. If you need it, ask an administrator.
      </p>
      <Link href="/" className={`${ui.button} self-start`}>
        Back to dashboard
      </Link>
    </div>
  );
}
