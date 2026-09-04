"use client";
import { create } from "zustand";

export type Locale = "en" | "zh";

const dict = {
  en: {
    dashboard: "Dashboard",
    hosts: "Hosts",
    credentials: "Credentials",
    terminal: "Terminal",
    sessions: "Sessions",
    providers: "Model Providers",
    audit: "Audit Log",
    settings: "Settings",
    logout: "Sign out",
    login: "Sign in",
    email: "Email",
    password: "Password",
    connect: "Connect",
    newTab: "New tab",
    close: "Close",
    approve: "Approve",
    reject: "Reject",
    production: "PRODUCTION",
    mode: "Mode",
    model: "Model",
    latency: "Latency",
    agent: "AI Agent",
    context: "Context",
    approvals: "Approvals",
    send: "Send",
    askPlaceholder: "Ask the agent about this host… e.g. “analyze the latest errors”",
    noSession: "Open a terminal to attach the agent to a host.",
    approvalRequired: "Approval required",
    targetHost: "Target host",
    command: "Command",
    workingDir: "Working directory",
    user: "User",
    risk: "Risk",
    impact: "Impact / findings",
    rollback: "Rollback suggestion",
    trustKey: "Trust fingerprint & reconnect",
    theme: "Theme",
    language: "Language",
  },
  zh: {
    dashboard: "仪表盘",
    hosts: "主机",
    credentials: "凭据",
    terminal: "终端",
    sessions: "会话",
    providers: "模型供应商",
    audit: "审计日志",
    settings: "设置",
    logout: "退出登录",
    login: "登录",
    email: "邮箱",
    password: "密码",
    connect: "连接",
    newTab: "新标签",
    close: "关闭",
    approve: "批准",
    reject: "拒绝",
    production: "生产环境",
    mode: "模式",
    model: "模型",
    latency: "延迟",
    agent: "AI 助手",
    context: "上下文",
    approvals: "审批",
    send: "发送",
    askPlaceholder: "向助手提问… 例如“分析最近的错误日志”",
    noSession: "先打开一个终端，助手会附着到该主机。",
    approvalRequired: "需要审批",
    targetHost: "目标主机",
    command: "命令",
    workingDir: "工作目录",
    user: "用户",
    risk: "风险",
    impact: "影响 / 策略发现",
    rollback: "回滚建议",
    trustKey: "信任指纹并重新连接",
    theme: "主题",
    language: "语言",
  },
} as const;

export type Key = keyof (typeof dict)["en"];

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useI18n = create<I18nState>((set) => ({
  locale: (typeof window !== "undefined" && (localStorage.getItem("locale") as Locale)) || "en",
  setLocale: (locale) => {
    localStorage.setItem("locale", locale);
    set({ locale });
  },
}));

export function useT() {
  const locale = useI18n((s) => s.locale);
  return (k: Key) => dict[locale][k];
}
