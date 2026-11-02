import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Anchor, Badge, Button, CopyButton, Grid, Group, Loader, Modal, SegmentedControl, Stack, Text, ThemeIcon,
} from "@mantine/core";
import { Dropzone, IMAGE_MIME_TYPE } from "@mantine/dropzone";
import {
  IconAlertTriangle, IconCamera, IconCheck, IconChessKnight, IconCopy, IconCrop, IconExternalLink, IconPhoto, IconPlayerPlay, IconRefresh, IconSearch,
} from "@tabler/icons-react";
import type { Key } from "chessground/types";
import { fenError, type Color } from "../chess/position";
import { newGame } from "../chess/tree";
import { api } from "../lib/api";
import { useTabs } from "../store/tabs";
import { useUi } from "../store/ui";
import { BoardEditor, editorToFen, possibleCastling, type EditorState } from "./BoardEditor";

interface VisionResult {
  ok: boolean;
  error?: string;
  width: number;
  height: number;
  bbox?: [number, number, number, number];
  grid?: (string | null)[][];
  confidence?: number[][];
  whiteAtBottom?: boolean;
  warnings?: string[];
}

const UNSURE = 0.8;
const fenLetter = (code: string) => (code[0] === "w" ? code[1] : code[1].toLowerCase());

/** Picture-layout grid (row 0 = top of the image) -> FEN piece placement. */
export function gridToPlacement(grid: (string | null)[][], whiteAtBottom: boolean): string {
  const rows = whiteAtBottom ? grid : [...grid].reverse().map((r) => [...r].reverse());
  return rows
    .map((row) => {
      let s = "";
      let empty = 0;
      for (const cell of row) {
        if (!cell) empty++;
        else {
          if (empty) s += empty;
          empty = 0;
          s += fenLetter(cell);
        }
      }
      return s + (empty || "");
    })
    .join("/");
}

/** Board square shown at picture row/col. */
function squareAt(row: number, col: number, whiteAtBottom: boolean): Key {
  const file = whiteAtBottom ? col : 7 - col;
  const rank = whiteAtBottom ? 7 - row : row;
  return `${String.fromCharCode(97 + file)}${rank + 1}` as Key;
}

export function ScreenshotImport() {
  const { open, file: initialFile } = useUi((s) => s.screenshot);
  const close = useUi((s) => s.closeScreenshot);
  const openPlay = useUi((s) => s.openPlay);
  const openTab = useTabs((s) => s.openTab);

  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [result, setResult] = useState<VisionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whiteAtBottom, setWhiteAtBottom] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [edited, setEdited] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const turnRef = useRef<Color>("white");
  const shotRef = useRef<HTMLDivElement>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    setEditor(null);
    setError(null);
    setCropMode(false);
    setDrag(null);
    setEdited(false);
  };

  const recognize = useCallback(async (f: File, bbox?: number[]) => {
    setLoading(true);
    setError(null);
    try {
      const q = bbox ? `?bbox=${bbox.map((v) => Math.round(v)).join(",")}` : "";
      const r = await api<VisionResult>(`/api/vision/recognize${q}`, { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
      setResult(r);
      if (r.ok && r.grid) {
        const wab = !!r.whiteAtBottom;
        setWhiteAtBottom(wab);
        const placement = gridToPlacement(r.grid, wab);
        setEditor({ placement, turn: turnRef.current, castling: possibleCastling(placement) });
        setEdited(false);
        setCropMode(false);
      } else {
        setEditor(null);
        setCropMode(true);
      }
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const accept = useCallback((f: File) => {
    reset();
    setFile(f);
    void recognize(f);
  }, [recognize]);

  useEffect(() => {
    if (open && initialFile) accept(initialFile);
    if (!open) reset();
  }, [open, initialFile, accept]);

  useEffect(() => {
    if (!file) return setImgUrl(null);
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Ctrl+V while the dialog is open
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) {
        e.preventDefault();
        e.stopPropagation();
        accept(f);
      }
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [open, accept]);

  const setOrientation = (wab: boolean) => {
    setWhiteAtBottom(wab);
    if (result?.grid && editor) {
      const placement = gridToPlacement(result.grid, wab);
      setEditor({ ...editor, placement, castling: possibleCastling(placement) });
      setEdited(false);
    }
  };

  const unsure = useMemo(() => {
    const out: { row: number; col: number; key: Key }[] = [];
    result?.confidence?.forEach((row, r) => row.forEach((c, col) => {
      if (c < UNSURE) out.push({ row: r, col, key: squareAt(r, col, whiteAtBottom) });
    }));
    return out;
  }, [result, whiteAtBottom]);

  const highlight = useMemo(() => new Map<Key, string>(unsure.map((u) => [u.key, "uncertain"])), [unsure]);

  const fen = editor ? editorToFen(editor) : null;
  const problem = fen ? fenError(fen) : null;
  const orientation: Color = whiteAtBottom ? "white" : "black";

  const analyze = () => {
    if (!fen) return;
    openTab({
      type: "analysis", title: "Screenshot", source: "screenshot", orientation, analysisOn: true,
      game: newGame(fen, { Event: "Screenshot import" }),
    });
    close();
  };

  const play = () => {
    if (!fen) return;
    close();
    openPlay(fen, orientation);
  };

  // ---- manual board box (when detection fails or is off) ----
  const toImage = (e: React.PointerEvent) => {
    const rect = shotRef.current!.getBoundingClientRect();
    const sx = result!.width / rect.width;
    const sy = result!.height / rect.height;
    return { x: Math.max(0, Math.min(result!.width, (e.clientX - rect.left) * sx)), y: Math.max(0, Math.min(result!.height, (e.clientY - rect.top) * sy)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!cropMode || !result) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toImage(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toImage(e);
    // keep the box square, like a chessboard
    const side = Math.max(Math.abs(p.x - drag.x0), Math.abs(p.y - drag.y0));
    setDrag({ ...drag, x1: drag.x0 + Math.sign(p.x - drag.x0 || 1) * side, y1: drag.y0 + Math.sign(p.y - drag.y0 || 1) * side });
  };
  const onUp = () => {
    if (!drag || !file) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w >= 32 && h >= 32) void recognize(file, [x, y, w, h]);
  };

  const box = drag
    ? [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)]
    : result?.bbox;

  return (
    <Modal opened={open} onClose={close} size={file ? "min(1180px, 96vw)" : "lg"} centered
      title={<Group gap="xs"><IconCamera size={20} /><Text fw={600}>Import a position from a screenshot</Text></Group>}>
      {!file && (
        <Stack>
          <Dropzone onDrop={(files) => files[0] && accept(files[0])} accept={IMAGE_MIME_TYPE} maxFiles={1} multiple={false}>
            <Stack align="center" gap="xs" py="xl" style={{ pointerEvents: "none" }}>
              <ThemeIcon size={56} radius="xl" variant="light"><IconPhoto size={30} /></ThemeIcon>
              <Text size="lg" fw={600}>Drop a screenshot of a chessboard here</Text>
              <Text size="sm" c="dimmed">or click to choose a file. You can also press <b>Ctrl+V</b> to paste one from the clipboard.</Text>
            </Stack>
          </Dropzone>
          <Text size="xs" c="dimmed">
            Works with 2D boards from Lichess, Chess.com, books, videos and most apps, in any colour theme and from either side.
            The board is found automatically, every square is read by a small neural network, and you can correct anything before analysing.
          </Text>
        </Stack>
      )}
      {file && (
        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={600}>Screenshot</Text>
                <Group gap={4}>
                  <Button size="compact-xs" variant={cropMode ? "filled" : "default"} leftSection={<IconCrop size={12} />}
                    onClick={() => setCropMode((c) => !c)} disabled={!result}>
                    {cropMode ? "Drag a box around the board" : "Wrong area? Select the board"}
                  </Button>
                  <Button size="compact-xs" variant="default" leftSection={<IconRefresh size={12} />} onClick={reset}>Other image</Button>
                </Group>
              </Group>
              <div className={`shot-wrap ${cropMode ? "crop" : ""}`}>
                <div ref={shotRef} className="shot-inner" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                  {imgUrl && <img src={imgUrl} alt="screenshot" draggable={false} />}
                  {result && (
                    <svg viewBox={`0 0 ${result.width} ${result.height}`} preserveAspectRatio="none" className="shot-overlay">
                      {box && (
                        <g>
                          <rect x={box[0]} y={box[1]} width={box[2]} height={box[3]} className="shot-box" vectorEffect="non-scaling-stroke" />
                          {!drag && result.bbox && Array.from({ length: 7 }, (_, i) => (
                            <g key={i} className="shot-grid">
                              <line x1={box[0] + ((i + 1) * box[2]) / 8} y1={box[1]} x2={box[0] + ((i + 1) * box[2]) / 8} y2={box[1] + box[3]} vectorEffect="non-scaling-stroke" />
                              <line x1={box[0]} y1={box[1] + ((i + 1) * box[3]) / 8} x2={box[0] + box[2]} y2={box[1] + ((i + 1) * box[3]) / 8} vectorEffect="non-scaling-stroke" />
                            </g>
                          ))}
                          {!drag && result.bbox && unsure.map((u) => (
                            <rect key={u.key} className="shot-unsure" vectorEffect="non-scaling-stroke"
                              x={box[0] + (u.col * box[2]) / 8} y={box[1] + (u.row * box[3]) / 8} width={box[2] / 8} height={box[3] / 8} />
                          ))}
                        </g>
                      )}
                    </svg>
                  )}
                  {loading && <div className="shot-loading"><Loader /><Text size="sm" mt="xs">Reading the board…</Text></div>}
                </div>
              </div>
              {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}
              {result && !result.ok && <Alert color="orange" icon={<IconAlertTriangle size={16} />}>{result.error}</Alert>}
              {result?.ok && (
                <Stack gap={6}>
                  <Group gap="xs">
                    <Text size="sm">Which side is at the bottom of the screenshot?</Text>
                    <SegmentedControl size="xs" value={whiteAtBottom ? "white" : "black"} onChange={(v) => setOrientation(v === "white")}
                      data={[{ value: "white", label: "White" }, { value: "black", label: "Black" }]} />
                  </Group>
                  {unsure.length > 0 ? (
                    <Text size="xs" c="orange">
                      Not sure about {unsure.map((u) => u.key).join(", ")}: they are outlined on both boards. Please check them.
                    </Text>
                  ) : (
                    <Group gap={4}><IconCheck size={14} color="var(--mantine-color-green-6)" /><Text size="xs" c="dimmed">All 64 squares read with high confidence.</Text></Group>
                  )}
                </Stack>
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            {editor ? (
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="sm" fw={600}>Recognised position {edited && <Badge size="xs" variant="light" ml={4}>edited</Badge>}</Text>
                  <Text size="xs" c="dimmed">Fix any square by dragging pieces or using the palettes</Text>
                </Group>
                <div className="editor-holder">
                  <BoardEditor value={editor} orientation={orientation} highlight={highlight}
                    onChange={(s) => {
                      turnRef.current = s.turn;
                      if (s.placement !== editor.placement) setEdited(true);
                      setEditor(s);
                    }} />
                </div>
                <Alert variant="light" color={editor.turn === "white" ? "gray" : "dark"} p="xs">
                  <Text size="xs">A screenshot cannot show whose turn it is. Pick <b>White to move</b> or <b>Black to move</b> above before analysing.</Text>
                </Alert>
                <Group gap="xs">
                  <Button leftSection={<IconSearch size={16} />} onClick={analyze} disabled={!!problem}>Analyse position</Button>
                  <Button variant="light" leftSection={<IconPlayerPlay size={16} />} onClick={play} disabled={!!problem}>Play from here</Button>
                  <CopyButton value={fen ?? ""}>
                    {({ copied, copy }) => (
                      <Button variant="default" leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>{copied ? "Copied" : "FEN"}</Button>
                    )}
                  </CopyButton>
                  {fen && !problem && (
                    <Anchor size="xs" href={`https://lichess.org/analysis/standard/${fen.replace(/ /g, "_")}`} target="_blank">
                      <Group gap={2}>Lichess <IconExternalLink size={12} /></Group>
                    </Anchor>
                  )}
                </Group>
              </Stack>
            ) : (
              <Stack align="center" justify="center" h="100%" mih={300} c="dimmed">
                {loading ? <Loader /> : <IconChessKnight size={48} stroke={1} />}
                <Text size="sm" ta="center">
                  {loading ? "Locating the board and reading the pieces…" : "Select the board on the screenshot to read the position."}
                </Text>
              </Stack>
            )}
          </Grid.Col>
        </Grid>
      )}
    </Modal>
  );
}
