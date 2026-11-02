import { createPortal } from "react-dom";
import { Paper } from "@mantine/core";
import { Chessboard } from "./Chessboard";
import type { Color } from "../chess/position";

export interface Preview {
  fen: string;
  lastMove?: string;
  x: number;
  y: number;
}

/** Floating board shown while hovering a move in an engine line or explorer row. */
export function MiniBoardPreview({ preview, orientation }: { preview: Preview | null; orientation: Color }) {
  if (!preview) return null;
  const size = 220;
  const left = Math.min(preview.x + 16, window.innerWidth - size - 12);
  const top = Math.min(preview.y + 16, window.innerHeight - size - 12);
  return createPortal(
    <Paper shadow="lg" p={4} withBorder style={{ position: "fixed", left, top, width: size + 8, zIndex: 1000, pointerEvents: "none" }}>
      <div style={{ width: size, height: size }}>
        <Chessboard fen={preview.fen} lastMove={preview.lastMove} orientation={orientation} viewOnly coordinates={false} />
      </div>
    </Paper>,
    document.body,
  );
}
