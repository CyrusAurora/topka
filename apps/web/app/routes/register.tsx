// The registration page (master design D6/J1): an email and a password of at least ten characters, plus
// an invite code only when the instance runs REGISTRATION_MODE=invite (the loader asks the api). Failure
// copy is per reason; the api remains the authority. Success lands on 今日 (/).
import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/register";
import { pageMeta } from "../lib/seo";
import { chromeStrings } from "../lib/i18n";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";
import { apiGet } from "../lib/api.server";

export const meta: Route.MetaFunction = () => pageMeta({ title: "注册", description: `注册 ${SITE.name} 账号。`, path: "/register", noindex: true });

export async function loader({ request }: Route.LoaderArgs) {
  // Unreachable api: show the open form; the api still refuses a missing invite if one is required.
  const mode = await apiGet<{ inviteRequired?: boolean }>("/api/auth/registration", { signal: request.signal }).catch(() => ({ inviteRequired: false }));
  return { inviteRequired: mode.inviteRequired === true };
}

export function headers() {
  return { "Cache-Control": "no-store" };
}

const MIN_PASSWORD_LENGTH = 10;
const OFFLINE = "没网，稍后再试。";

export default function RegisterPage() {
  const strings = chromeStrings("zh-CN");
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
    if (!navigator.onLine) return setState({ kind: "error", message: OFFLINE });
    if ([...password].length < MIN_PASSWORD_LENGTH) return setState({ kind: "error", message: `密码至少 ${MIN_PASSWORD_LENGTH} 位。` });
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), email, password, website }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        return setState({ kind: "error", message: problem.detail ?? "注册失败，请稍后再试。" });
      }
      window.location.assign("/");
    } catch {
      setState({ kind: "error", message: OFFLINE });
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
        <h1 className="mt-6 text-center text-[17px] font-semibold text-ink">{inviteRequired ? "注册采用邀请码制" : "注册账号"}</h1>
        <p className="mt-2 text-center text-[13px] leading-relaxed text-ink-3">
          {inviteRequired ? "受邀用户凭邀请码创建账号，账号只属于你自己。" : "用邮箱和密码创建账号，账号只属于你自己。注册后可在设置里填你自己的模型 Key。"}
        </p>
        <form onSubmit={submit} className="card mt-6 p-6">
          {inviteRequired && (
            <div className="mb-4">
              <label htmlFor="code" className="block text-[13px] font-medium text-ink-2">
                邀请码
              </label>
              <input id="code" name="code" type="text" required autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="向邀请你的人要" className={field} />
            </div>
          )}
          {/* Honeypot: hidden from people and screen readers; a bot that fills it is refused. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label htmlFor="website">网站</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-ink-2">
              邮箱
            </label>
            <input id="email" name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={field} />
          </div>
          <div className="mt-4">
            <label htmlFor="password" className="block text-[13px] font-medium text-ink-2">
              密码 <span className="font-normal text-ink-4">（至少 {MIN_PASSWORD_LENGTH} 位）</span>
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
            已经有账号？
            <Link to="/login" className="text-accent hover:underline">
              去登录
            </Link>
          </p>
        </form>
        <p className="mt-6 text-center text-[12px] text-ink-4">
          <Link to="/" className="hover:text-ink-2">
            回到 {SITE.name}
          </Link>
        </p>
      </div>
    </div>
  );
}
