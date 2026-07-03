import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";

import { authClient, useSession } from "@/lib/authClient";

const DISMISS_KEY = "mega-crm:verify-email-banner-dismissed";

/**
 * D-02 soft-verification banner: the app stays usable before verifying, but
 * this banner nudges the user with a resend action. Dismissible for the
 * browser session (sessionStorage — cleared when the tab closes, persists
 * across reloads within it).
 */
export function VerifyEmailBanner() {
  const { data: session } = useSession();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === "1");
  const [sending, setSending] = useState(false);

  if (!session || session.user.emailVerified || dismissed) {
    return null;
  }

  async function handleResend() {
    setSending(true);
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: session!.user.email,
        callbackURL: `${window.location.origin}/`,
      });
      if (error) {
        toast.error("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.");
      } else {
        toast.success("Письмо отправлено");
      }
    } finally {
      setSending(false);
    }
  }

  function handleDismiss() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <p>
        Подтвердите email — без этого нельзя подключить SendGrid.{" "}
        <button
          type="button"
          onClick={handleResend}
          disabled={sending}
          className="font-semibold underline underline-offset-4 disabled:opacity-60"
        >
          {sending ? "Отправляем…" : "Отправить письмо ещё раз"}
        </button>
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Скрыть"
        className="shrink-0 text-amber-800/70 hover:text-amber-800"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default VerifyEmailBanner;
