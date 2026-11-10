// UI strings: account. `zh` is the Chinese copy as the product has it; `en` the same keys in English.
import type { Shape } from "./shape.ts";

export const zh = {
  offline: "没网，稍后再试。",
  backTo: (site: string) => `回到 ${site}`,
  login: {
    metaTitle: "登录",
    metaDescription: (site: string) => `登录 ${site}，回到你的追踪项目和有出处的更新。`,
    heading: "先选项目和要看的页面，再回到有出处的更新。",
    failed: "登录失败，请稍后再试。",
    noAccount: "还没有账号？",
    registerLink: "注册",
  },
  register: {
    metaTitle: "注册",
    metaDescription: (site: string) => `注册 ${site} 账号。`,
    passwordTooShort: (n: number) => `密码至少 ${n} 位。`,
    failed: "注册失败，请稍后再试。",
    headingInvite: "注册采用邀请码制",
    headingOpen: "注册账号",
    subInvite: "受邀用户凭邀请码创建账号，账号只属于你自己。",
    subOpen: "用邮箱和密码创建账号，账号只属于你自己。注册后可在设置里填你自己的模型 Key。",
    inviteLabel: "邀请码",
    invitePlaceholder: "向邀请你的人要",
    website: "网站",
    passwordHint: (n: number) => `（至少 ${n} 位）`,
    haveAccount: "已经有账号？",
    signInLink: "去登录",
  },
};

export const en: Shape<typeof zh> = {
  offline: "You are offline. Please try again later.",
  backTo: (site) => `Back to ${site}`,
  login: {
    metaTitle: "Sign in",
    metaDescription: (site) => `Sign in to ${site} and get back to your tracking projects and sourced updates.`,
    heading: "Pick the projects and pages you want, then get back to sourced updates.",
    failed: "Could not sign in. Please try again later.",
    noAccount: "No account yet? ",
    registerLink: "Register",
  },
  register: {
    metaTitle: "Create account",
    metaDescription: (site) => `Create your ${site} account.`,
    passwordTooShort: (n) => `Password must be at least ${n} characters.`,
    failed: "Could not create the account. Please try again later.",
    headingInvite: "Invite-only registration",
    headingOpen: "Create account",
    subInvite: "Invited users create an account with an invite code. The account is yours alone.",
    subOpen: "Create an account with your email and a password. The account is yours alone — you can add your own model key in Settings later.",
    inviteLabel: "Invite code",
    invitePlaceholder: "Ask the person who invited you",
    website: "Website",
    passwordHint: (n) => `(at least ${n} characters)`,
    haveAccount: "Already have an account? ",
    signInLink: "Sign in",
  },
};
