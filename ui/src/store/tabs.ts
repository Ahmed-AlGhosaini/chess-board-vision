import { create } from "zustand";
import { persist } from "zustand/middleware";
import { newGame, type GameState } from "../chess/tree";
import type { Color } from "../chess/position";
import type { MoveClass } from "../chess/eval";

export type TabType = "new" | "analysis" | "play" | "puzzle";

export interface PlayState {
  engine: string;
  level: number;
  /** colour the engine plays; null = two humans on one board */
  engineColor: Color | null;
  clock: { initial: number; increment: number } | null; // ms
  times: Record<Color, number>; // ms left
  status: "playing" | "over";
  result?: string;
  reason?: string;
}

export interface PuzzleState {
  id: string;
  rating: number;
  themes: string[];
  solution: string[];
  startNode: string;
  step: number; // solution moves already played
  status: "solving" | "solved" | "failed" | "loading" | "error";
  error?: string;
  hint: number; // 0 none, 1 piece highlighted, 2 arrow shown
  streak: number;
  history: { id: string; rating: number; solved: boolean }[];
}

export interface Report {
  status: "running" | "done" | "error";
  progress: number;
  total: number;
  error?: string;
  nodeIds: string[];
  accuracy?: { white: number; black: number };
  cpl?: { white: number; black: number };
  classes?: Record<string, MoveClass>;
}

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  game: GameState;
  orientation: Color;
  analysisOn: boolean;
  play?: PlayState;
  puzzle?: PuzzleState;
  report?: Report;
  source?: string; // e.g. "screenshot"
}

export type Page = "boards" | "databases" | "engines" | "settings";

interface TabsStore {
  tabs: Tab[];
  active: string | null;
  page: Page;
  setPage: (p: Page) => void;
  openTab: (init?: Partial<Tab>) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  updateTab: (id: string, fn: (t: Tab) => Partial<Tab>) => void;
  updateGame: (id: string, fn: (g: GameState) => GameState) => void;
  moveTab: (from: number, to: number) => void;
}

const tabId = () => Math.random().toString(36).slice(2, 10);

export function blankTab(init: Partial<Tab> = {}): Tab {
  return { id: tabId(), type: "new", title: "New Tab", game: newGame(), orientation: "white", analysisOn: false, ...init };
}

export const useTabs = create<TabsStore>()(
  persist(
    (set) => ({
      tabs: [],
      active: null,
      page: "boards",
      setPage: (page) => set({ page }),
      openTab: (init) => {
        const tab = blankTab(init);
        set((s) => ({ tabs: [...s.tabs, tab], active: tab.id, page: "boards" }));
        return tab.id;
      },
      closeTab: (id) =>
        set((s) => {
          const i = s.tabs.findIndex((t) => t.id === id);
          const tabs = s.tabs.filter((t) => t.id !== id);
          const active = s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active;
          return { tabs, active };
        }),
      setActive: (id) => set({ active: id, page: "boards" }),
      updateTab: (id, fn) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) })),
      updateGame: (id, fn) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, game: fn(t.game) } : t)) })),
      moveTab: (from, to) =>
        set((s) => {
          const tabs = [...s.tabs];
          const [t] = tabs.splice(from, 1);
          tabs.splice(to, 0, t);
          return { tabs };
        }),
    }),
    {
      name: "chessvision-tabs",
      version: 1,
      partialize: (s) => ({
        // a report that was still running when the page closed cannot resume
        tabs: s.tabs.map((t) => (t.report?.status === "running" ? { ...t, report: undefined } : t)),
        active: s.active,
      }),
    },
  ),
);

export const useActiveTab = () => useTabs((s) => s.tabs.find((t) => t.id === s.active) ?? null);
