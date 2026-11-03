import { useRef, useState } from "react";
import { Loader, Text } from "@mantine/core";

export interface UnsureSquare {
  row: number;
  col: number;
  key: string;
}

/**
 * A picture with the detected board drawn on it (box, grid, uncertain squares).
 * In crop mode the user drags a square box around the board instead.
 */
export function BoardBox({ src, size, bbox, unsure = [], cropMode, loading, loadingText = "Reading the board…", onSelect }: {
  src: string | null;
  size?: { width: number; height: number }; // picture size in pixels
  bbox?: number[] | null;
  unsure?: UnsureSquare[];
  cropMode: boolean;
  loading?: boolean;
  loadingText?: string;
  onSelect: (box: number[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const toImage = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const sx = size!.width / rect.width;
    const sy = size!.height / rect.height;
    return { x: Math.max(0, Math.min(size!.width, (e.clientX - rect.left) * sx)), y: Math.max(0, Math.min(size!.height, (e.clientY - rect.top) * sy)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!cropMode || !size) return;
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
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w >= 32 && h >= 32) onSelect([x, y, w, h]);
  };

  const box = drag
    ? [Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0)]
    : bbox;

  return (
    <div className={`shot-wrap ${cropMode ? "crop" : ""}`}>
      <div ref={ref} className="shot-inner" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {src && <img src={src} alt="screenshot" draggable={false} />}
        {size && (
          <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" className="shot-overlay">
            {box && (
              <g>
                <rect x={box[0]} y={box[1]} width={box[2]} height={box[3]} className="shot-box" vectorEffect="non-scaling-stroke" />
                {!drag && bbox && Array.from({ length: 7 }, (_, i) => (
                  <g key={i} className="shot-grid">
                    <line x1={box[0] + ((i + 1) * box[2]) / 8} y1={box[1]} x2={box[0] + ((i + 1) * box[2]) / 8} y2={box[1] + box[3]} vectorEffect="non-scaling-stroke" />
                    <line x1={box[0]} y1={box[1] + ((i + 1) * box[3]) / 8} x2={box[0] + box[2]} y2={box[1] + ((i + 1) * box[3]) / 8} vectorEffect="non-scaling-stroke" />
                  </g>
                ))}
                {!drag && bbox && unsure.map((u) => (
                  <rect key={u.key} className="shot-unsure" vectorEffect="non-scaling-stroke"
                    x={box[0] + (u.col * box[2]) / 8} y={box[1] + (u.row * box[3]) / 8} width={box[2] / 8} height={box[3] / 8} />
                ))}
              </g>
            )}
          </svg>
        )}
        {loading && <div className="shot-loading"><Loader /><Text size="sm" mt="xs">{loadingText}</Text></div>}
      </div>
    </div>
  );
}
