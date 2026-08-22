"use client";

// A wa.me deep link, not the WhatsApp Business API — no account/credential
// setup needed, works the moment it's clicked. Prompts for a number so it
// isn't tied to one saved contact; `message` is prebuilt server-side (a
// plain string prop, not a function, since it's just derived data).
export function WhatsAppShareButton({
  label,
  promptLabel,
  message,
}: {
  label: string;
  promptLabel: string;
  message: string;
}) {
  function handleClick() {
    const number = window.prompt(promptLabel);
    if (!number) return;
    const digits = number.replace(/[^\d]/g, "");
    if (!digits) return;
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-md border border-good bg-good-soft px-3 py-1.5 text-xs font-medium text-good hover:opacity-80"
    >
      {label}
    </button>
  );
}
