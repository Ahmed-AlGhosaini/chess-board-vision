import { create } from "zustand";
import type { Color } from "../chess/position";

interface UiStore {
  screenshot: { open: boolean; file?: File };
  play: { open: boolean; fen?: string; orientation?: Color };
  importOpen: boolean;
  liveOpen: boolean;
  shortcutsOpen: boolean;
  openScreenshot: (file?: File) => void;
  closeScreenshot: () => void;
  openPlay: (fen?: string, orientation?: Color) => void;
  closePlay: () => void;
  setImportOpen: (open: boolean) => void;
  setLiveOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
}

export const useUi = create<UiStore>()((set) => ({
  screenshot: { open: false },
  play: { open: false },
  importOpen: false,
  liveOpen: false,
  shortcutsOpen: false,
  openScreenshot: (file) => set({ screenshot: { open: true, file } }),
  closeScreenshot: () => set({ screenshot: { open: false } }),
  openPlay: (fen, orientation) => set({ play: { open: true, fen, orientation } }),
  closePlay: () => set({ play: { open: false } }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setLiveOpen: (liveOpen) => set({ liveOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));
