"use client";
import { create } from "zustand";

export interface Tab {
  id: string; // session id
  hostId: string;
  hostName: string;
  environment: string;
  status: "connecting" | "active" | "closed" | "error";
  latencyMs: number | null;
  lastSeq: number;
  title: string;
}

interface TerminalState {
  tabs: Tab[];
  activeId: string | null;
  split: boolean;
  addTab: (t: Tab) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  toggleSplit: () => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  tabs: [],
  activeId: null,
  split: false,
  addTab: (t) => set((s) => ({ tabs: [...s.tabs, t], activeId: t.id })),
  updateTab: (id, patch) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return { tabs, activeId: s.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeId };
    }),
  setActive: (id) => set({ activeId: id }),
  toggleSplit: () => set((s) => ({ split: !s.split })),
}));
