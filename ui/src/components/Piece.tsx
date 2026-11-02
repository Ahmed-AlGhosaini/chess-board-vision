import { createElement, type CSSProperties, type MouseEvent } from "react";

export type Role = "pawn" | "knight" | "bishop" | "rook" | "queen" | "king";

/**
 * A piece image using the active piece-set CSS. The bundled set's rules are
 * scoped to `.cg-wrap piece.role.color`, hence the wrapper.
 */
export function Piece({ role, color, size = 32, style, onMouseDown, onClick, title }: {
  role: Role; color: "white" | "black"; size?: number | string; style?: CSSProperties;
  onMouseDown?: (e: MouseEvent) => void; onClick?: (e: MouseEvent) => void; title?: string;
}) {
  return (
    <span className="cg-wrap piece-icon" style={{ width: size, height: size, ...style }} onMouseDown={onMouseDown} onClick={onClick} title={title}>
      {createElement("piece", { className: `${role} ${color}` })}
    </span>
  );
}
