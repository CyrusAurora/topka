// The registration page (master design D6/J1): an email and a password of at least ten characters, plus
// an invite code only when the instance runs REGISTRATION_MODE=invite (the loader asks the api). Failure
// copy is per reason; the api remains the authority. Success lands on 今日 (/).
import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/register";
import { pageMeta } from "../lib/seo";
import { localeOf, messages, problemMessage, useLocale, useT } from "../lib/i18n";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";
import { apiGet } from "../lib/api.server";

export const meta: Route.MetaFunction = ({ matches }) => {
  const locale = localeOf(matches);
  const t = messages(locale);
  return pageMeta({ title: t.account.register.metaTitle, description: t.account.register.metaDescription(SITE.name), path: "/register", noindex: true, locale });
};

export async function loader({ request }: Route.LoaderArgs) {
  // Unreachable api: show the open form; the api still refuses a missing invite if one is required.
  const mode = await apiGet<{ inviteRequired?: boolean }>("/api/auth/registration", { signal: request.signal }).catch(() => ({ inviteRequired: false }));
  return { inviteRequired: mode.inviteRequired === true };
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

const MIN_PASSWORD_LENGTH = 10;

export default function RegisterPage() {
  const t = useT();
  const locale = useLocale();
  const strings = t.chrome;
  const { inviteRequired } = useLoaderData<typeof loader>();
  const [code, setCode] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "error"; message?: string }>({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    if (!navigator.onLine) return setState({ kind: "error", message: t.account.offline });
    if ([...password].length < MIN_PASSWORD_LENGTH) return setState({ kind: "error", message: t.account.register.passwordTooShort(MIN_PASSWORD_LENGTH) });
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), email, password, website }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; status?: number; retryAfter?: number };
        return setState({ kind: "error", message: problemMessage(locale, problem, t.account.register.failed) });
      }
      window.location.assign("/");
    } catch {
      setState({ kind: "error", message: t.account.offline });
    }
  };

  const field = "mt-2 h-11 w-full rounded-full border border-line-strong bg-surface px-4 text-[14.5px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent";
  const canSend = (!inviteRequired || code.trim() !== "") && email.trim() !== "" && password !== "" && state.kind !== "sending";
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center justify-center gap-2">
          <Wordmark size={26} className="text-ink" />
        </div>
        <h1 className="mt-6 text-center text-[17px] font-semibold text-ink">{inviteRequired ? t.account.register.headingInvite : t.account.register.headingOpen}</h1>
        <p className="mt-2 text-center text-[13px] leading-relaxed text-ink-3">
          {inviteRequired ? t.account.register.subInvite : t.account.register.subOpen}
        </p>
        <form onSubmit={submit} className="card mt-6 p-6">
          {inviteRequired && (
            <div className="mb-4">
              <label htmlFor="code" className="block text-[13px] font-medium text-ink-2">
                {t.account.register.inviteLabel}
              </label>
              <input id="code" name="code" type="text" required autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder={t.account.register.invitePlaceholder} className={field} />
            </div>
          )}
          {/* Honeypot: hidden from people and screen readers; a bot that fills it is refused. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label htmlFor="website">{t.account.register.website}</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-ink-2">
              {strings.emailLabel}
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={field} />
          </div>
          <div className="mt-4">
            <label htmlFor="password" className="block text-[13px] font-medium text-ink-2">
              {strings.passwordLabel} <span className="font-normal text-ink-4">{t.account.register.passwordHint(MIN_PASSWORD_LENGTH)}</span>
            </label>
            <input id="password" name="password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
          </div>
          {state.kind === "error" && (
            <p role="alert" className="mt-4 text-[12.5px] leading-relaxed text-hot">
              {state.message}
            </p>
          )}
          <button type="submit" disabled={!canSend} className={`${buttonClass("primary", "lg")} mt-5 w-full`}>
            {state.kind === "sending" ? strings.registering : strings.registerButton}
          </button>
          <p className="mt-4 text-center text-[12.5px] text-ink-3">
            {t.account.register.haveAccount}
            <Link to="/login" className="text-accent hover:underline">
              {t.account.register.signInLink}
            </Link>
          </p>
        </form>
        <p className="mt-6 text-center text-[12px] text-ink-4">
          <Link to="/" className="hover:text-ink-2">
            {t.account.backTo(SITE.name)}
          </Link>
        </p>
      </div>
    </div>
  );
}
