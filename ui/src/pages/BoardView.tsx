import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Button, Group, Menu, Modal, ScrollArea, Stack, Tabs, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconArrowsVertical, IconBolt, IconBoltOff, IconBook2, IconCamera, IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight,
  IconCopy, IconDots, IconDownload, IconEdit, IconInfoCircle, IconPencil, IconPlayerPlay, IconReportAnalytics, IconSearch, IconGitBranch,
} from "@tabler/icons-react";
import type { DrawShape } from "chessground/draw";
import { toPgn, parsePgnText } from "../chess/pgn";
import { turnOf, uciSquares, type Color } from "../chess/position";
import {
  addLine, addMove, current, deleteNode, gameFrom, goEnd, goNext, goPrev, goSibling, goStart, goTo, mainline, movesTo, newGame,
  pathTo, promoteVariation, rootFen, toggleNag, truncateAfter, updateNode,
} from "../chess/tree";
import { useAnalysis } from "../engine/useAnalysis";
import { api, type EngineInfo } from "../lib/api";
import { moveSound } from "../lib/sound";
import { useSettings } from "../store/settings";
import { useTabs, type Tab } from "../store/tabs";
import { useUi } from "../store/ui";
import { AnnotationPanel } from "../components/AnnotationPanel";
import { BoardEditor, editorToFen, fenToEditor, type EditorState } from "../components/BoardEditor";
import { Chessboard } from "../components/Chessboard";
import { EnginePanel } from "../components/EnginePanel";
import { EvalBar } from "../components/EvalBar";
import { ExplorerPanel } from "../components/ExplorerPanel";
import { InfoPanel, downloadText, gameFileName } from "../components/InfoPanel";
import { LivePanel } from "../components/LivePanel";
import { MiniBoardPreview, type Preview } from "../components/MiniBoard";
import { MoveList } from "../components/MoveList";
import { PlayerBar } from "../components/PlayerBar";
import { ReportPanel } from "../components/ReportPanel";
import { gameTitle } from "../components/ImportModal";
import { fenError } from "../chess/position";
import { PlayPanel, usePlay } from "./play";
import { PuzzlePanel, puzzleMove, puzzleShapes } from "./puzzle";

let enginesCache: EngineInfo[] | null = null;

function useEngines() {
  const [engines, setEngines] = useState<EngineInfo[]>(enginesCache ?? []);
  useEffect(() => {
    api<EngineInfo[]>("/api/engines").then((l) => {
      enginesCache = l;
      setEngines(l);
    }).catch(() => {});
  }, []);
  return engines;
}

export function BoardView({ tab }: { tab: Tab }) {
  if (tab.type === "play") return <PlayBoard tab={tab} />;
  return <AnalysisBoard tab={tab} />;
}

function PlayBoard({ tab }: { tab: Tab }) {
  const controls = usePlay(tab);
  return <BoardLayout tab={tab} play={controls} />;
}

function AnalysisBoard({ tab }: { tab: Tab }) {
  return <BoardLayout tab={tab} />;
}

function BoardLayout({ tab, play }: { tab: Tab; play?: ReturnType<typeof usePlay> }) {
  const updateGame = useTabs((s) => s.updateGame);
  const updateTab = useTabs((s) => s.updateTab);
  const openTab = useTabs((s) => s.openTab);
  const openScreenshot = useUi((s) => s.openScreenshot);
  const openPlay = useUi((s) => s.openPlay);
  const settings = useSettings();
  const engines = useEngines();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [hoverMove, setHoverMove] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>("analysis");
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [editOrientation, setEditOrientation] = useState<Color>(tab.orientation);

  const g = tab.game;
  const node = current(g);
  const isPlay = tab.type === "play";
  const playing = isPlay && tab.play?.status === "playing";
  const puzzle = tab.type === "puzzle" ? tab.puzzle : undefined;
  const solving = puzzle?.status === "solving";
  const engineAllowed = !playing && !solving && !(puzzle?.status === "loading");

  const engineIds = useMemo(() => {
    const ids = settings.analysisEngines.filter((id) => engines.some((e) => e.id === id));
    return ids.length ? ids : engines.slice(0, 1).map((e) => e.id);
  }, [settings.analysisEngines, engines]);
  const moves = useMemo(() => movesTo(g, g.cursor), [g]);
  const results = useAnalysis(tab.id, engineIds, { rootFen: rootFen(g), moves, fen: node.fen }, tab.analysisOn && engineAllowed);
  const primary = engineIds.map((id) => results[id]).find(Boolean);
  const evalScore = engineAllowed ? (primary?.lines[0]?.score ?? node.score) : undefined;

  const setGame = (fn: Parameters<typeof updateGame>[1]) => updateGame(tab.id, fn);

  const onMove = (uci: string) => {
    if (play) {
      if (play.humanToMove && play.atEnd) play.commit(uci);
      return;
    }
    if (puzzle) return puzzleMove(tab, uci);
    const r = addMove(g, uci);
    if (!r) return;
    moveSound(r);
    setGame(() => r.game);
  };

  const step = (fn: typeof goNext) => {
    const next = fn(g);
    if (next.cursor !== g.cursor) {
      const n = next.nodes[next.cursor];
      if (fn === goNext && n.san) moveSound({ capture: n.san.includes("x"), check: n.san.includes("+") || n.san.includes("#") });
      setGame(() => next);
    }
  };

  const toggleEngine = (on?: boolean) => updateTab(tab.id, (t) => ({ analysisOn: on ?? !t.analysisOn }));
  const flip = () => updateTab(tab.id, (t) => ({ orientation: t.orientation === "white" ? "black" : "white" }));

  useHotkeys([
    ["ArrowLeft", () => step(goPrev)],
    ["ArrowRight", () => step(goNext)],
    ["ArrowUp", () => step((x) => goSibling(x, -1))],
    ["ArrowDown", () => step((x) => goSibling(x, 1))],
    ["Home", () => step(goStart)],
    ["End", () => step(goEnd)],
    ["f", flip],
    ["e", () => engineAllowed && toggleEngine()],
    ["mod+Backspace", () => !isPlay && node.parent && setGame((x) => deleteNode(x, x.cursor))],
  ]);

  // wheel over the board steps through moves
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 4) return;
    step(e.deltaY > 0 ? goNext : goPrev);
  };

  // ---------- board decorations ----------
  const autoShapes = useMemo<DrawShape[]>(() => {
    const shapes: DrawShape[] = [];
    if (engineAllowed && tab.analysisOn && primary && settings.engineArrows > 0) {
      primary.lines.slice(0, settings.engineArrows).forEach((l, i) => {
        if (!l.pv[0]) return;
        const [o, d] = uciSquares(l.pv[0]);
        shapes.push({ orig: o, dest: d, brush: `engine${Math.min(i + 1, 3)}` });
      });
      // a second engine's best move, if it differs
      const second = engineIds.slice(1).map((id) => results[id]).find(Boolean);
      const alt = second?.lines[0]?.pv[0];
      if (alt && alt !== primary.lines[0]?.pv[0]) {
        const [o, d] = uciSquares(alt);
        shapes.push({ orig: o, dest: d, brush: "engineAlt" });
      }
    }
    // game report: where the engine wanted to go instead
    if (!engineAllowed || !tab.analysisOn) {
      const parent = node.parent ? g.nodes[node.parent] : null;
      if (!playing && parent?.best && parent.best !== node.uci && (node.nags ?? []).some((n) => [2, 4, 6].includes(n))) {
        const [o, d] = uciSquares(parent.best);
        shapes.push({ orig: o, dest: d, brush: "hint" });
      }
    }
    if (hoverMove) {
      const [o, d] = uciSquares(hoverMove);
      shapes.push({ orig: o, dest: d, brush: "paleGreen" });
    }
    if (puzzle) shapes.push(...puzzleShapes(tab));
    return shapes;
  }, [primary, settings.engineArrows, tab.analysisOn, engineAllowed, hoverMove, puzzle, node, g, engineIds, results, playing, tab]);

  // ---------- who may move ----------
  let movable: Color | "both" | null = "both";
  if (play) movable = play.humanToMove && play.atEnd ? (tab.play!.engineColor ? (tab.play!.engineColor === "white" ? "black" : "white") : "both") : null;
  if (puzzle && solving) {
    const expectedNode = mainline(g, puzzle.startNode)[puzzle.step];
    movable = g.cursor === expectedNode && puzzle.step % 2 === 0 ? turnOf(node.fen) : null;
  }

  // ---------- actions ----------
  const openGame = async (source: string, id: string) => {
    try {
      let pgn: string;
      if (source.startsWith("db:")) pgn = (await api(`/api/databases/${encodeURIComponent(source.slice(3))}/games/${id}`)).pgn;
      else pgn = await api<string>(`/api/lichess/game/${id}?masters=${source === "masters"}`);
      const game = parsePgnText(typeof pgn === "string" ? pgn : String(pgn))[0];
      if (!game) throw new Error("Could not read the game");
      openTab({ type: "analysis", title: gameTitle(game), game });
    } catch (e: any) {
      notifications.show({ color: "red", title: "Could not open game", message: e.message });
    }
  };

  const applyEdit = () => {
    if (!editing) return;
    const fen = editorToFen(editing);
    updateTab(tab.id, (t) => ({
      game: newGame(fen, { ...t.game.headers, Result: "*" }), orientation: editOrientation, report: undefined,
      type: t.type === "new" ? "analysis" : t.type,
    }));
    setEditing(null);
  };

  const copyLine = (id: string) => {
    const ids = pathTo(g, id).slice(1);
    let line = newGame(rootFen(g), g.headers);
    line = addLine(line, ids.map((x) => g.nodes[x].uci!), line.root);
    void navigator.clipboard.writeText(toPgn(line, { comments: false }));
    notifications.show({ message: "Line copied as PGN" });
  };

  const isLive = tab.type === "live";
  const playerName = (side: "White" | "Black") => {
    const name = g.headers[side] && g.headers[side] !== "?" ? g.headers[side] : side;
    if (!isLive) return name;
    const title = g.headers[`${side}Title`];
    const elo = g.headers[`${side}Elo`];
    return `${title ? title + " " : ""}${name}${elo && elo !== "?" ? ` (${elo})` : ""}`;
  };
  const whiteName = playerName("White");
  const blackName = playerName("Black");
  // a live game's clock runs for the side to move, while the newest move is shown
  const liveTail = isLive && tab.live?.status === "live" && !!tab.live.clockAt && !node.children.length && !!node.parent;
  const top: Color = tab.orientation === "white" ? "black" : "white";
  const clockFor = (c: Color) => {
    if (play && tab.play?.clock) return play.times[c];
    const n = [...pathTo(g, g.cursor)].reverse().map((id) => g.nodes[id]).find((x) => x.uci && x.clock !== undefined && turnOf(x.fen) !== c);
    return n?.clock !== undefined ? n.clock * 1000 : null;
  };
  const bar = (c: Color) => (
    <PlayerBar color={c} name={c === "white" ? whiteName : blackName} fen={node.fen} clockMs={clockFor(c)}
      running={!!play && playing && play.turn === c} isEngine={tab.play?.engineColor === c}
      tickingSince={liveTail && turnOf(node.fen) === c ? tab.live!.clockAt : undefined} />
  );

  const showSidePanels = !playing && !(tab.type === "puzzle" && (!puzzle || solving || puzzle.status === "loading"));

  return (
    <div className="board-layout">
      <div className="board-column">
        {bar(top)}
        <div className="board-row">
          {settings.showEvalBar && engineAllowed && <EvalBar score={evalScore} orientation={tab.orientation} />}
          <div className="board-square" onWheel={onWheel}>
            <Chessboard fen={node.fen} orientation={tab.orientation} lastMove={node.uci} movable={movable} onMove={onMove}
              shapes={node.shapes} autoShapes={autoShapes} onShapes={(s) => setGame((x) => updateNode(x, x.cursor, { shapes: s }))} />
          </div>
        </div>
        {bar(tab.orientation)}
        <Group justify="space-between" className="board-toolbar" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            <Tooltip label="Flip board (F)"><ActionIcon variant="default" size="lg" onClick={flip}><IconArrowsVertical size={18} /></ActionIcon></Tooltip>
            {!isPlay && !puzzle && (
              <Tooltip label="Edit position">
                <ActionIcon variant="default" size="lg" onClick={() => { setEditing(fenToEditor(node.fen)); setEditOrientation(tab.orientation); }}>
                  <IconPencil size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Import position from screenshot">
              <ActionIcon variant="default" size="lg" onClick={() => openScreenshot()}><IconCamera size={18} /></ActionIcon>
            </Tooltip>
            <Tooltip label="Copy FEN">
              <ActionIcon variant="default" size="lg" onClick={() => { void navigator.clipboard.writeText(node.fen); notifications.show({ message: "FEN copied" }); }}>
                <IconCopy size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <Group gap={4} wrap="nowrap">
            <ActionIcon variant="default" size="lg" onClick={() => step(goStart)} aria-label="Start"><IconChevronsLeft size={18} /></ActionIcon>
            <ActionIcon variant="default" size="lg" onClick={() => step(goPrev)} aria-label="Previous"><IconChevronLeft size={18} /></ActionIcon>
            <ActionIcon variant="default" size="lg" onClick={() => step(goNext)} aria-label="Next"><IconChevronRight size={18} /></ActionIcon>
            <ActionIcon variant="default" size="lg" onClick={() => step(goEnd)} aria-label="End"><IconChevronsRight size={18} /></ActionIcon>
          </Group>
          <Group gap={4} wrap="nowrap">
            {engineAllowed && (
              <Tooltip label={tab.analysisOn ? "Stop engine (E)" : "Start engine (E)"}>
                <ActionIcon variant={tab.analysisOn ? "filled" : "default"} size="lg" onClick={() => toggleEngine()}>
                  {tab.analysisOn ? <IconBolt size={18} /> : <IconBoltOff size={18} />}
                </ActionIcon>
              </Tooltip>
            )}
            <Menu position="top-end" shadow="md">
              <Menu.Target><ActionIcon variant="default" size="lg"><IconDots size={18} /></ActionIcon></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconPlayerPlay size={14} />} onClick={() => openPlay(node.fen, tab.orientation)}>Play vs engine from here</Menu.Item>
                <Menu.Item leftSection={<IconGitBranch size={14} />}
                  onClick={() => openTab({ type: "analysis", title: "Analysis", game: gameFrom(g, g.cursor), orientation: tab.orientation })}>
                  New analysis from this position
                </Menu.Item>
                <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => downloadText(gameFileName(g), toPgn(g))}>Download PGN</Menu.Item>
                <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => { void navigator.clipboard.writeText(toPgn(g)); notifications.show({ message: "PGN copied" }); }}>Copy PGN</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </div>

      <div className="side-column">
        {play && <PlayPanel tab={tab} controls={play} />}
        {isLive && tab.live && <LivePanel tab={tab} />}
        {tab.type === "puzzle" && <PuzzlePanel tab={tab} />}
        {showSidePanels && (
          <Tabs value={panel} onChange={setPanel} className="side-tabs" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="analysis" leftSection={<IconSearch size={14} />}>Analysis</Tabs.Tab>
              <Tabs.Tab value="report" leftSection={<IconReportAnalytics size={14} />}>Report</Tabs.Tab>
              <Tabs.Tab value="explorer" leftSection={<IconBook2 size={14} />}>Explorer</Tabs.Tab>
              <Tabs.Tab value="annotate" leftSection={<IconEdit size={14} />}>Annotate</Tabs.Tab>
              <Tabs.Tab value="info" leftSection={<IconInfoCircle size={14} />}>Info</Tabs.Tab>
            </Tabs.List>
            <ScrollArea className="side-tab-body" type="auto">
              <Tabs.Panel value="analysis" p="xs">
                <EnginePanel engines={engines} results={results} active={tab.analysisOn} onToggle={toggleEngine} fen={node.fen}
                  onPlayLine={(ucis) => setGame((x) => addLine(x, ucis))} setPreview={setPreview} />
              </Tabs.Panel>
              <Tabs.Panel value="report" p="xs">
                <ReportPanel tab={tab} onSelect={(id) => setGame((x) => goTo(x, id))} />
              </Tabs.Panel>
              <Tabs.Panel value="explorer" p="xs">
                <ExplorerPanel fen={node.fen} onMove={onMove} onHover={setHoverMove} onOpenGame={openGame} />
              </Tabs.Panel>
              <Tabs.Panel value="annotate" p="xs">
                <AnnotationPanel node={node}
                  onToggleNag={(nag, group) => setGame((x) => toggleNag(x, x.cursor, nag, group))}
                  onComment={(text) => setGame((x) => updateNode(x, x.cursor, { comment: text || undefined }))}
                  onClearShapes={() => setGame((x) => updateNode(x, x.cursor, { shapes: [] }))} />
              </Tabs.Panel>
              <Tabs.Panel value="info" p="xs">
                <InfoPanel game={g} fen={node.fen} onHeaders={(h) => {
                  setGame((x) => ({ ...x, headers: h }));
                  updateTab(tab.id, (t) => ({ title: t.type === "analysis" ? gameTitle({ ...t.game, headers: h }) : t.title }));
                }} />
              </Tabs.Panel>
            </ScrollArea>
          </Tabs>
        )}
        <div className="moves-box">
          <MoveList game={g} result={g.headers.Result}
            actions={{
              onSelect: (id) => setGame((x) => goTo(x, id)),
              onDelete: isPlay || solving ? undefined : (id) => setGame((x) => deleteNode(x, id)),
              onPromote: isPlay || solving ? undefined : (id, toMain) => setGame((x) => promoteVariation(x, id, toMain)),
              onTruncate: isPlay || solving ? undefined : (id) => setGame((x) => truncateAfter(x, id)),
              onCopyLine: copyLine,
            }} />
        </div>
      </div>

      <MiniBoardPreview preview={preview} orientation={tab.orientation} />

      <Modal opened={!!editing} onClose={() => setEditing(null)} title="Edit position" size="min(640px, 96vw)" centered>
        {editing && (
          <Stack>
            <BoardEditor value={editing} onChange={setEditing} orientation={editOrientation} onOrientation={setEditOrientation} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={applyEdit} disabled={!!fenError(editorToFen(editing))}>
                {Object.keys(g.nodes).length > 1 ? "Start new game from this position" : "Apply"}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </div>
  );
}
