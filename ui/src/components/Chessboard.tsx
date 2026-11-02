import { useEffect, useMemo, useRef, useState } from "react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Key } from "chessground/types";
import { checkColor, dests, isPromotion, tryPos, turnOf, uciSquares, type Color } from "../chess/position";
import type { Shape } from "../chess/tree";
import { useSettings } from "../store/settings";
import { Piece, type Role } from "./Piece";

export interface ChessboardProps {
  fen: string;
  orientation: Color;
  lastMove?: string;
  /** which side may move pieces; null = nobody (view only interaction) */
  movable?: Color | "both" | null;
  onMove?: (uci: string) => void;
  shapes?: Shape[];
  onShapes?: (shapes: Shape[]) => void;
  autoShapes?: DrawShape[];
  viewOnly?: boolean;
  coordinates?: boolean;
  highlight?: Map<Key, string>;
}

const BRUSHES = {
  engine1: { key: "e1", color: "#003088", opacity: 0.8, lineWidth: 11 },
  engine2: { key: "e2", color: "#003088", opacity: 0.55, lineWidth: 8 },
  engine3: { key: "e3", color: "#003088", opacity: 0.35, lineWidth: 6 },
  engineAlt: { key: "ea", color: "#882020", opacity: 0.6, lineWidth: 9 },
  hint: { key: "hi", color: "#15781B", opacity: 0.9, lineWidth: 12 },
  warn: { key: "wa", color: "#e8590c", opacity: 1, lineWidth: 6 },
};

export function Chessboard(props: ChessboardProps) {
  const { fen, orientation, lastMove, movable = "both", shapes, autoShapes, viewOnly, highlight } = props;
  const settings = useSettings();
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [promo, setPromo] = useState<{ orig: Key; dest: Key } | null>(null);

  const turn = turnOf(fen);
  const legal = useMemo(() => {
    const pos = tryPos(fen);
    return pos ? dests(pos) : new Map<Key, Key[]>();
  }, [fen]);
  const canMove = !viewOnly && movable !== null && (movable === "both" || movable === turn);

  function resync() {
    // the board moved a piece the parent did not accept (illegal for a puzzle, cancelled promotion, ...)
    setTimeout(() => {
      if (api.current && api.current.getFen() !== propsRef.current.fen.split(" ")[0])
        api.current.set({ fen: propsRef.current.fen, lastMove: propsRef.current.lastMove ? uciSquares(propsRef.current.lastMove) : undefined });
    }, 60);
  }

  function onBoardMove(orig: Key, dest: Key) {
    const p = propsRef.current;
    if (isPromotion(p.fen, orig, dest)) {
      if (useSettings.getState().autoQueen) p.onMove?.(orig + dest + "q");
      else {
        setPromo({ orig, dest });
        return;
      }
    } else p.onMove?.(orig + dest);
    resync();
  }

  const config = (): Config => ({
    fen,
    orientation,
    turnColor: turn,
    check: checkColor(fen),
    lastMove: lastMove ? uciSquares(lastMove) : undefined,
    viewOnly: !!viewOnly,
    coordinates: props.coordinates ?? settings.coordinates,
    animation: { enabled: settings.animation, duration: 200 },
    highlight: { lastMove: settings.showLastMove, check: true, custom: highlight },
    movable: {
      free: false,
      color: canMove ? (movable === "both" ? turn : movable!) : undefined,
      dests: canMove ? legal : new Map(),
      showDests: settings.showDests,
      events: { after: onBoardMove },
    },
    premovable: { enabled: false },
    draggable: { enabled: true, showGhost: true },
    drawable: {
      enabled: true,
      visible: true,
      shapes: (shapes ?? []) as DrawShape[],
      autoShapes: autoShapes ?? [],
      brushes: BRUSHES as any,
      onChange: (s) => propsRef.current.onShapes?.(s.map((x) => ({ orig: x.orig, dest: x.dest, brush: x.brush ?? "green" }))),
    },
  });

  useEffect(() => {
    if (!el.current) return;
    api.current = Chessground(el.current, config());
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
    api.current?.set(config());
    setPromo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, orientation, lastMove, canMove, movable, viewOnly, settings.coordinates, settings.animation, settings.showDests, settings.showLastMove, highlight, props.coordinates]);

  useEffect(() => {
    api.current?.setShapes((shapes ?? []) as DrawShape[]);
  }, [shapes]);

  useEffect(() => {
    api.current?.setAutoShapes(autoShapes ?? []);
  }, [autoShapes]);

  const promoChoice = (role: Role | null) => {
    const p = promo;
    setPromo(null);
    if (p && role) propsRef.current.onMove?.(p.orig + p.dest + role[0].replace("k", "n"));
    resync();
  };

  let promoBox = null;
  if (promo) {
    const file = promo.dest.charCodeAt(0) - 97;
    const col = orientation === "white" ? file : 7 - file;
    const atTop = (promo.dest[1] === "8") === (orientation === "white");
    const roles: Role[] = ["queen", "knight", "rook", "bishop"];
    promoBox = (
      <div className="promotion-overlay" onClick={() => promoChoice(null)}>
        {roles.map((r, i) => (
          <div
            key={r}
            className="promotion-choice"
            style={{ left: `${col * 12.5}%`, top: `${(atTop ? i : 7 - i) * 12.5}%` }}
            onClick={(e) => {
              e.stopPropagation();
              promoChoice(r);
            }}
          >
            <Piece role={r} color={turn} size="100%" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="board-box">
      <div ref={el} className="cg-wrap" style={{ width: "100%", height: "100%" }} />
      {promoBox}
    </div>
  );
}
