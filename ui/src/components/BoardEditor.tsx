import { useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Button, Checkbox, Group, SegmentedControl, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { IconArrowsVertical, IconEraser, IconHandFinger, IconRefresh, IconTrash } from "@tabler/icons-react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { DrawShape } from "chessground/draw";
import type { Key, Piece as CgPiece } from "chessground/types";
import { fenError, type Color } from "../chess/position";
import { Piece, type Role } from "./Piece";

export interface EditorState {
  placement: string;
  turn: Color;
  castling: { K: boolean; Q: boolean; k: boolean; q: boolean };
}

export const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
const ROLES: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];

function pieceAt(placement: string, square: string): string | null {
  const rows = placement.split("/");
  const rank = 8 - Number(square[1]);
  const file = square.charCodeAt(0) - 97;
  let col = 0;
  for (const ch of rows[rank] ?? "") {
    if (/\d/.test(ch)) col += Number(ch);
    else {
      if (col === file) return ch;
      col++;
    }
  }
  return null;
}

/** Castling rights that are still possible with the current piece placement. */
export function possibleCastling(placement: string) {
  return {
    K: pieceAt(placement, "e1") === "K" && pieceAt(placement, "h1") === "R",
    Q: pieceAt(placement, "e1") === "K" && pieceAt(placement, "a1") === "R",
    k: pieceAt(placement, "e8") === "k" && pieceAt(placement, "h8") === "r",
    q: pieceAt(placement, "e8") === "k" && pieceAt(placement, "a8") === "r",
  };
}

export function editorToFen(s: EditorState): string {
  const ok = possibleCastling(s.placement);
  const c = (["K", "Q", "k", "q"] as const).filter((k) => s.castling[k] && ok[k]).join("") || "-";
  return `${s.placement} ${s.turn === "white" ? "w" : "b"} ${c} - 0 1`;
}

export function fenToEditor(fen: string): EditorState {
  const [placement, turn = "w", castling = "-"] = fen.trim().split(/\s+/);
  return {
    placement,
    turn: turn === "b" ? "black" : "white",
    castling: { K: castling.includes("K"), Q: castling.includes("Q"), k: castling.includes("k"), q: castling.includes("q") },
  };
}

type Tool = "pointer" | "trash" | `${Color}-${Role}`;

export function BoardEditor({ value, onChange, orientation, onOrientation, highlight, autoShapes }: {
  value: EditorState;
  onChange: (s: EditorState) => void;
  orientation: Color;
  onOrientation?: (c: Color) => void;
  highlight?: Map<Key, string>;
  autoShapes?: DrawShape[];
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [tool, setTool] = useState<Tool>("pointer");
  const [fenText, setFenText] = useState(editorToFen(value));
  const painting = useRef<{ last?: Key; erase: boolean } | null>(null);

  const emit = () => {
    if (!api.current) return;
    const placement = api.current.getFen();
    const ok = possibleCastling(placement);
    const prev = valueRef.current;
    // a right becomes available again only when the user ticks it; it is dropped as soon as it becomes impossible
    const castling = { K: prev.castling.K && ok.K, Q: prev.castling.Q && ok.Q, k: prev.castling.k && ok.k, q: prev.castling.q && ok.q };
    onChangeRef.current({ ...prev, placement, castling });
  };

  useEffect(() => {
    if (!el.current) return;
    api.current = Chessground(el.current, {
      fen: value.placement,
      orientation,
      coordinates: true,
      animation: { enabled: false },
      movable: { free: true, color: "both" },
      premovable: { enabled: false },
      draggable: { deleteOnDropOff: true, showGhost: true },
      highlight: { lastMove: false, check: false, custom: highlight },
      drawable: { enabled: false, visible: true, autoShapes: autoShapes ?? [] },
      events: { change: emit },
    });
    const ro = new ResizeObserver(() => api.current?.redrawAll());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      api.current?.destroy();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (api.current && api.current.getFen() !== value.placement) api.current.set({ fen: value.placement });
    setFenText(editorToFen(value));
  }, [value]);

  useEffect(() => {
    api.current?.set({ orientation });
  }, [orientation]);

  useEffect(() => {
    api.current?.set({ highlight: { custom: highlight } });
  }, [highlight]);

  useEffect(() => {
    api.current?.setAutoShapes(autoShapes ?? []);
  }, [autoShapes]);

  const applyTool = (key: Key, first: boolean) => {
    if (!api.current) return;
    const existing = api.current.state.pieces.get(key);
    if (tool === "trash") {
      if (existing) api.current.setPieces(new Map([[key, undefined]]));
    } else if (tool !== "pointer") {
      const [color, role] = tool.split("-") as [Color, Role];
      const same = existing && existing.role === role && existing.color === color;
      if (same && first) {
        painting.current = { erase: true, last: key };
        api.current.setPieces(new Map([[key, undefined]]));
      } else if (painting.current?.erase) {
        if (same) api.current.setPieces(new Map([[key, undefined]]));
      } else if (!same) api.current.setPieces(new Map([[key, { role, color } as CgPiece]]));
    }
    emit();
  };

  const onOverlayDown = (e: React.PointerEvent) => {
    const key = api.current?.getKeyAtDomPos([e.clientX, e.clientY]);
    if (!key) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    painting.current = { last: key, erase: false };
    applyTool(key, true);
  };

  const onOverlayMove = (e: React.PointerEvent) => {
    if (!painting.current) return;
    const key = api.current?.getKeyAtDomPos([e.clientX, e.clientY]);
    if (!key || key === painting.current.last) return;
    painting.current.last = key;
    applyTool(key, false);
  };

  const palette = (color: Color) => (
    <Group gap={4} justify="center" className="spare-pieces">
      {ROLES.map((role) => {
        const t = `${color}-${role}` as Tool;
        return (
          <div key={role} className={`spare ${tool === t ? "selected" : ""}`} title={`${color} ${role}`}
            onMouseDown={(e) => {
              setTool(t);
              if (e.button === 0 && api.current) api.current.dragNewPiece({ role, color }, e.nativeEvent, true);
            }}>
            <Piece role={role} color={color} size="100%" />
          </div>
        );
      })}
    </Group>
  );

  const setPlacement = (placement: string, castling = valueRef.current.castling) =>
    onChange({ ...valueRef.current, placement, castling });

  const fen = editorToFen(value);
  const error = fenError(fen);
  const can = possibleCastling(value.placement);
  const top: Color = orientation === "white" ? "black" : "white";

  return (
    <Stack gap="xs">
      {palette(top)}
      <div className="board-box editor-board">
        <div ref={el} className="cg-wrap" style={{ width: "100%", height: "100%" }} />
        {tool !== "pointer" && (
          <div className="editor-overlay" onPointerDown={onOverlayDown} onPointerMove={onOverlayMove}
            onPointerUp={() => (painting.current = null)} onContextMenu={(e) => e.preventDefault()} />
        )}
      </div>
      {palette(orientation)}
      <Group gap="xs" justify="space-between">
        <Group gap={4}>
          <Tooltip label="Move pieces (drag them; drag off the board to remove)">
            <ActionIcon variant={tool === "pointer" ? "filled" : "default"} onClick={() => setTool("pointer")} size="lg"><IconHandFinger size={18} /></ActionIcon>
          </Tooltip>
          <Tooltip label="Remove pieces (click or drag over squares)">
            <ActionIcon variant={tool === "trash" ? "filled" : "default"} color={tool === "trash" ? "red" : undefined} onClick={() => setTool("trash")} size="lg"><IconEraser size={18} /></ActionIcon>
          </Tooltip>
          {onOrientation && (
            <Tooltip label="Flip board">
              <ActionIcon variant="default" size="lg" onClick={() => onOrientation(orientation === "white" ? "black" : "white")}><IconArrowsVertical size={18} /></ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Group gap={4}>
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />}
            onClick={() => setPlacement(START_PLACEMENT, { K: true, Q: true, k: true, q: true })}>Start position</Button>
          <Button size="xs" variant="default" leftSection={<IconTrash size={14} />} onClick={() => setPlacement("8/8/8/8/8/8/8/8")}>Clear</Button>
        </Group>
      </Group>
      <Group justify="space-between" align="center">
        <SegmentedControl size="xs" value={value.turn} onChange={(v) => onChange({ ...value, turn: v as Color })}
          data={[{ value: "white", label: "White to move" }, { value: "black", label: "Black to move" }]} />
        <Group gap="sm">
          <Text size="xs" c="dimmed">Castling</Text>
          {(["K", "Q", "k", "q"] as const).map((k) => (
            <Checkbox key={k} size="xs" label={{ K: "O-O", Q: "O-O-O", k: "o-o", q: "o-o-o" }[k]} disabled={!can[k]}
              checked={value.castling[k] && can[k]} onChange={(e) => onChange({ ...value, castling: { ...value.castling, [k]: e.currentTarget.checked } })}
              title={k === k.toUpperCase() ? "White" : "Black"} />
          ))}
        </Group>
      </Group>
      <TextInput size="xs" value={fenText} styles={{ input: { fontFamily: "monospace" } }}
        onChange={(e) => {
          const t = e.currentTarget.value;
          setFenText(t);
          const parts = t.trim().split(/\s+/);
          if (parts[0] && !fenError(t.trim().split(/\s+/).length >= 4 ? t.trim() : `${parts[0]} ${parts[1] ?? "w"} ${parts[2] ?? "-"} - 0 1`)) onChange(fenToEditor(t));
        }} />
      {error && <Alert color="orange" p={6}><Text size="xs">{error}</Text></Alert>}
    </Stack>
  );
}

