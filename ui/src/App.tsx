import { useEffect, useState } from "react";
import {
  ActionIcon, AppShell, Group, Kbd, MantineProvider, Modal, Stack, Table, Text, Tooltip, createTheme, useMantineColorScheme,
} from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications, notifications } from "@mantine/notifications";
import { useHotkeys } from "@mantine/hooks";
import {
  IconCamera, IconChess, IconCpu, IconDatabase, IconKeyboard, IconPlus, IconPuzzle, IconRobot, IconSettings, IconX, IconFileImport, IconPlugConnectedX,
} from "@tabler/icons-react";
import { engineSocket } from "./lib/api";
import { themeCss } from "./lib/themes";
import { useSettings } from "./store/settings";
import { useActiveTab, useTabs, type Page, type Tab } from "./store/tabs";
import { useUi } from "./store/ui";
import { ImportModal, importText } from "./components/ImportModal";
import { PlaySetup } from "./components/PlaySetup";
import { ScreenshotImport } from "./components/ScreenshotImport";
import { BoardView } from "./pages/BoardView";
import { DatabasesPage } from "./pages/Databases";
import { EnginesPage } from "./pages/Engines";
import { NewTabPage } from "./pages/NewTab";
import { SettingsPage } from "./pages/Settings";

const TAB_ICONS = { new: IconPlus, analysis: IconChess, play: IconRobot, puzzle: IconPuzzle } as const;

function ThemeStyles() {
  const boardTheme = useSettings((s) => s.boardTheme);
  const pieceSet = useSettings((s) => s.pieceSet);
  return <style>{themeCss(boardTheme, pieceSet)}</style>;
}

function ColorSchemeSync() {
  const scheme = useSettings((s) => s.colorScheme);
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => setColorScheme(scheme), [scheme, setColorScheme]);
  return null;
}

function NavButton({ icon: Icon, label, active, onClick }: { icon: typeof IconChess; label: string; active?: boolean; onClick: () => void }) {
  return (
    <Tooltip label={label} position="right" withArrow>
      <ActionIcon variant={active ? "light" : "subtle"} color={active ? undefined : "gray"} size={44} radius="md" onClick={onClick} aria-label={label}>
        <Icon size={24} stroke={1.6} />
      </ActionIcon>
    </Tooltip>
  );
}

function TabBar() {
  const { tabs, active, setActive, closeTab, openTab, moveTab } = useTabs();
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <div className="tab-bar">
      {tabs.map((t: Tab, i) => {
        const Icon = TAB_ICONS[t.type];
        return (
          <div key={t.id} className={`tab ${t.id === active ? "active" : ""}`} draggable
            onDragStart={() => setDragging(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragging !== null && dragging !== i) moveTab(dragging, i); setDragging(null); }}
            onClick={() => setActive(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)} title={t.title}>
            {t.source === "screenshot" ? <IconCamera size={14} /> : <Icon size={14} />}
            <span className="tab-title">{t.title}</span>
            <ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }} aria-label="Close tab">
              <IconX size={12} />
            </ActionIcon>
          </div>
        );
      })}
      <Tooltip label="New tab">
        <ActionIcon variant="subtle" color="gray" onClick={() => openTab()} aria-label="New tab"><IconPlus size={16} /></ActionIcon>
      </Tooltip>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["← / →", "Previous / next move"], ["↑ / ↓", "Switch between variations"], ["Home / End", "First / last move"],
  ["Mouse wheel on board", "Step through moves"], ["F", "Flip the board"], ["E", "Start / stop the engine"],
  ["Ctrl+V", "Paste a screenshot, PGN or FEN"], ["Ctrl+Backspace", "Delete the current move"],
  ["Right-click drag", "Draw arrows and circles (Shift / Alt / Ctrl for colours)"], ["?", "This help"],
];

function Shell() {
  const page = useTabs((s) => s.page);
  const setPage = useTabs((s) => s.setPage);
  const tabs = useTabs((s) => s.tabs);
  const openTab = useTabs((s) => s.openTab);
  const tab = useActiveTab();
  const ui = useUi();
  const [online, setOnline] = useState(true);

  useEffect(() => engineSocket.onStatus(setOnline), []);
  useEffect(() => {
    if (!tabs.length) openTab();
  }, [tabs.length, openTab]);

  // paste a screenshot, PGN or FEN from anywhere
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (useUi.getState().screenshot.open) return;
      const image = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"))?.getAsFile();
      if (image) {
        e.preventDefault();
        ui.openScreenshot(image);
        return;
      }
      const text = e.clipboardData?.getData("text/plain");
      if (text?.trim()) {
        const r = importText(text);
        if (!r.opened) notifications.show({ color: "orange", message: r.error });
        else if (r.error) notifications.show({ message: r.error });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ui]);

  useHotkeys([["shift+?", () => ui.setShortcutsOpen(true)]]);

  const go = (p: Page) => setPage(p);

  return (
    <AppShell navbar={{ width: 64, breakpoint: 0 }} padding={0}>
      <AppShell.Navbar p={10} className="sidebar">
        <Stack justify="space-between" h="100%" align="center">
          <Stack gap={6} align="center">
            <div className="logo">♞</div>
            <NavButton icon={IconChess} label="Boards" active={page === "boards"} onClick={() => go("boards")} />
            <NavButton icon={IconCamera} label="Import screenshot" onClick={() => ui.openScreenshot()} />
            <NavButton icon={IconFileImport} label="Import PGN / FEN" onClick={() => ui.setImportOpen(true)} />
            <NavButton icon={IconDatabase} label="Databases" active={page === "databases"} onClick={() => go("databases")} />
            <NavButton icon={IconCpu} label="Engines" active={page === "engines"} onClick={() => go("engines")} />
          </Stack>
          <Stack gap={6} align="center">
            {!online && (
              <Tooltip label="Not connected to the local server (python app.py)" position="right">
                <IconPlugConnectedX color="var(--mantine-color-red-6)" />
              </Tooltip>
            )}
            <NavButton icon={IconKeyboard} label="Keyboard shortcuts" onClick={() => ui.setShortcutsOpen(true)} />
            <NavButton icon={IconSettings} label="Settings" active={page === "settings"} onClick={() => go("settings")} />
          </Stack>
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main className="main">
        {page === "boards" && (
          <div className="boards-page">
            <TabBar />
            <div className="tab-content">
              {tab && tab.type === "new" && <NewTabPage tab={tab} />}
              {tab && tab.type !== "new" && <BoardView key={tab.id} tab={tab} />}
            </div>
          </div>
        )}
        {page === "databases" && <DatabasesPage />}
        {page === "engines" && <EnginesPage />}
        {page === "settings" && <SettingsPage />}
      </AppShell.Main>
      <ScreenshotImport />
      <ImportModal />
      <PlaySetup />
      <Modal opened={ui.shortcutsOpen} onClose={() => ui.setShortcutsOpen(false)} title="Keyboard shortcuts" centered>
        <Table>
          <Table.Tbody>
            {SHORTCUTS.map(([k, d]) => (
              <Table.Tr key={k}>
                <Table.Td><Group gap={4}>{k.split(" / ").map((x, i) => <span key={i}>{i > 0 && " / "}<Kbd>{x}</Kbd></span>)}</Group></Table.Td>
                <Table.Td><Text size="sm">{d}</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Modal>
    </AppShell>
  );
}

export default function App() {
  const primaryColor = useSettings((s) => s.primaryColor);
  const theme = createTheme({ primaryColor, fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", defaultRadius: "md" });
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <ColorSchemeSync />
      <ThemeStyles />
      <ModalsProvider>
        <Notifications position="bottom-right" />
        <Shell />
      </ModalsProvider>
    </MantineProvider>
  );
}
