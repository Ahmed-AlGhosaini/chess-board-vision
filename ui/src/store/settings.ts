import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface EngineLimit {
  type: "infinite" | "depth" | "time" | "nodes";
  value?: number;
}

export interface EngineSettings {
  multipv: number;
  threads: number;
  hash: number;
  limit: EngineLimit;
  options: Record<string, string | number | boolean>;
}

export const defaultEngineSettings = (): EngineSettings => ({
  multipv: 3,
  threads: Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
  hash: 128,
  limit: { type: "infinite" },
  options: {},
});

export interface Settings {
  colorScheme: "dark" | "light" | "auto";
  primaryColor: string;
  boardTheme: string;
  pieceSet: string;
  coordinates: boolean;
  animation: boolean;
  showDests: boolean;
  showLastMove: boolean;
  sound: boolean;
  volume: number;
  autoQueen: boolean;
  figurine: boolean;
  showEvalBar: boolean;
  engineArrows: number;
  showMaterial: boolean;
  lichessToken: string;
  analysisEngines: string[];
  engineSettings: Record<string, EngineSettings>;
  reportDepth: number;
  reportVariations: boolean;
  explorerSource: string;
  set: (patch: Partial<Settings>) => void;
  setEngineSettings: (id: string, patch: Partial<EngineSettings>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      colorScheme: "dark",
      primaryColor: "blue",
      boardTheme: "brown",
      pieceSet: "cburnett",
      coordinates: true,
      animation: true,
      showDests: true,
      showLastMove: true,
      sound: true,
      volume: 0.6,
      autoQueen: false,
      figurine: false,
      showEvalBar: true,
      engineArrows: 3,
      showMaterial: true,
      lichessToken: "",
      analysisEngines: ["stockfish"],
      engineSettings: {},
      reportDepth: 16,
      reportVariations: true,
      explorerSource: "masters",
      set: (patch) => set(patch),
      setEngineSettings: (id, patch) =>
        set((s) => ({
          engineSettings: { ...s.engineSettings, [id]: { ...defaultEngineSettings(), ...s.engineSettings[id], ...patch } },
        })),
    }),
    {
      name: "chessvision-settings",
      partialize: ({ set: _s, setEngineSettings: _p, ...rest }) => rest,
    },
  ),
);

export function engineSettingsFor(all: Record<string, EngineSettings>, id: string): EngineSettings {
  return { ...defaultEngineSettings(), ...all[id] };
}
