// The sign-in page (master design J1): an anonymous page with per-reason error copy. The form posts
// JSON to the api, which sets the session cookie; the account pages themselves never touch a session.
import { SITE } from "@topka/industry/site";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { pageMeta } from "../lib/seo";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";

export const meta: Route.MetaFunction = () => pageMeta({ title: "登录", description: `登录 ${SITE.name}，回到你的追踪项目和有出处的更新。`, path: "/login", noindex: true });

export function headers() {
  return { "Cache-Control": "no-store" };
}

/** Only same-site paths may follow a sign-in; anything else lands on the home page. */
function safeNext(target: string | null): string {
  return target && /^\/(?!\/)/.test(target) ? target : "/";
}

export default function LoginPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "error"; message?: string }>({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.kind === "sending") return;
    setState({ kind: "sending" });
    if (!navigator.onLine) return setState({ kind: "error", message: OFFLINE });
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { detail?: string };
        return setState({ kind: "error", message: problem.detail ?? "登录失败，请稍后再试。" });
      }
      window.location.assign(safeNext(params.get("next")));
    } catch {
      setState({ kind: "error", message: OFFLINE });
    }
  };

  const field = "mt-2 h-11 w-full rounded-full border border-line-strong bg-surface px-4 text-[14.5px] text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-accent";
  const canSend = email.trim() !== "" && password !== "" && state.kind !== "sending";
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center justify-center gap-2">
          <Wordmark size={26} className="text-ink" />
        </div>
        <h1 className="mt-6 text-center text-[17px] font-semibold text-ink">先选项目和要看的页面，再回到有出处的更新。</h1>
        <form onSubmit={submit} className="card mt-6 p-6">
          <div>
            <label htmlFor="email" className="block text-[13px] font-medium text-ink-2">
              邮箱
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={field}
            />
          </div>
          <div className="mt-4">
            <label htmlFor="password" className="block text-[13px] font-medium text-ink-2">
              密码
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </div>
          {state.kind === "error" && (
            <p role="alert" className="mt-4 text-[12.5px] leading-relaxed text-hot">
              {state.message}
            </p>
          )}
          <button type="submit" disabled={!canSend} className={`${buttonClass("primary", "lg")} mt-5 w-full`}>
            {state.kind === "sending" ? "正在登录…" : "登录"}
          </button>
          <p className="mt-4 text-center text-[12.5px] text-ink-3">
            还没有账号？
            <Link to="/register" className="text-accent hover:underline">
              注册
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

const OFFLINE = "没网，稍后再试。";
