import { create } from "zustand";
import type { Color } from "../chess/position";

interface UiStore {
  screenshot: { open: boolean; file?: File };
  play: { open: boolean; fen?: string; orientation?: Color };
  importOpen: boolean;
  liveOpen: boolean;
  tabOffer: string | null; // a browser tab chosen in the extension, waiting in the capture dialog (live/tabFrames.ts)
  shortcutsOpen: boolean;
  openScreenshot: (file?: File) => void;
  closeScreenshot: () => void;
  openPlay: (fen?: string, orientation?: Color) => void;
  closePlay: () => void;
  setImportOpen: (open: boolean) => void;
  setLiveOpen: (open: boolean) => void;
  setTabOffer: (session: string | null) => void;
  setShortcutsOpen: (open: boolean) => void;
}

export const useUi = create<UiStore>()((set) => ({
  screenshot: { open: false },
  play: { open: false },
  importOpen: false,
  liveOpen: false,
  tabOffer: null,
  shortcutsOpen: false,
  openScreenshot: (file) => set({ screenshot: { open: true, file } }),
  closeScreenshot: () => set({ screenshot: { open: false } }),
  openPlay: (fen, orientation) => set({ play: { open: true, fen, orientation } }),
  closePlay: () => set({ play: { open: false } }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setLiveOpen: (liveOpen) => set({ liveOpen }),
  setTabOffer: (tabOffer) => set(tabOffer ? { tabOffer, liveOpen: true } : { tabOffer }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));
