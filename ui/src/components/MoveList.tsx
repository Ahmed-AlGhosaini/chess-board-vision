import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, ScrollArea, Text } from "@mantine/core";
import { IconArrowUp, IconArrowBarToUp, IconCopy, IconCut, IconTrash } from "@tabler/icons-react";
import { nagInfo } from "../chess/eval";
import type { GameState, TreeNode } from "../chess/tree";
import { useSettings } from "../store/settings";

const FIGURINES: Record<string, string> = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };
export const figurine = (san: string) => san.replace(/[KQRBN]/g, (c) => FIGURINES[c]);

export interface MoveListActions {
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onPromote?: (id: string, toMain: boolean) => void;
  onTruncate?: (id: string) => void;
  onCopyLine?: (id: string) => void;
}

export function MoveList({ game, actions, result }: { game: GameState; actions: MoveListActions; result?: string }) {
  const fig = useSettings((s) => s.figurine);
  const refs = useRef<Record<string, HTMLSpanElement | null>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = refs.current[game.cursor];
    const vp = viewport.current;
    if (!el || !vp) {
      if (vp && game.cursor === game.root) vp.scrollTop = 0;
      return;
    }
    const er = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    if (er.top < vr.top + 8 || er.bottom > vr.bottom - 8) vp.scrollTop += er.top - vr.top - vr.height / 2;
  }, [game.cursor, game.root]);

  const token = (n: TreeNode, forceNumber: boolean) => {
    const moverPly = n.ply - 1;
    const white = moverPly % 2 === 0;
    const num = Math.floor(moverPly / 2) + 1;
    const nags = n.nags ?? [];
    const colored = nags.map(nagInfo).find((x) => x?.color);
    return (
      <span
        key={n.id}
        ref={(r) => {
          refs.current[n.id] = r;
        }}
        className={`move ${n.id === game.cursor ? "active" : ""}`}
        style={colored ? { color: colored.color } : undefined}
        onClick={() => actions.onSelect(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ id: n.id, x: e.clientX, y: e.clientY });
        }}
      >
        {(white || forceNumber) && <span className="move-num">{num}{white ? "." : "..."}</span>}
        {fig ? figurine(n.san!) : n.san}
        {nags.map((x) => nagInfo(x)?.symbol).filter(Boolean).join("")}
      </span>
    );
  };

  const comment = (n: TreeNode) => (n.comment ? <span key={n.id + "c"} className="move-comment">{n.comment}</span> : null);

  /** Moves after `parentId`, with variations as indented blocks. */
  const line = (parentId: string, forceNumber: boolean, out: ReactNode[]) => {
    let pid = parentId;
    let force = forceNumber;
    for (;;) {
      const parent = game.nodes[pid];
      if (!parent.children.length) return;
      const [mainId, ...vars] = parent.children;
      const main = game.nodes[mainId];
      out.push(token(main, force));
      const c = comment(main);
      if (c) out.push(c);
      if (vars.length) {
        out.push(
          <div key={mainId + "v"} className="variations">
            {vars.map((vid) => {
              const v = game.nodes[vid];
              const inner: ReactNode[] = [token(v, true)];
              const vc = comment(v);
              if (vc) inner.push(vc);
              line(vid, !!vc, inner);
              return <div key={vid} className="variation">{inner}</div>;
            })}
          </div>,
        );
      }
      force = !!c || vars.length > 0;
      pid = mainId;
    }
  };

  const items: ReactNode[] = [];
  const root = game.nodes[game.root];
  if (root.comment) items.push(<span key="rootc" className="move-comment">{root.comment}</span>);
  line(game.root, true, items);

  return (
    <>
      <ScrollArea viewportRef={viewport} className="move-list" type="auto">
        <div className="move-list-inner">
          {items.length ? items : <Text c="dimmed" size="sm" p="sm">No moves yet. Make a move on the board, paste a PGN, or import a screenshot.</Text>}
          {result && result !== "*" && <span className="move-result">{result}</span>}
        </div>
      </ScrollArea>
      {menu && (
        <Menu opened onChange={(o) => !o && setMenu(null)} position="bottom-start" withinPortal shadow="md">
          <Menu.Target>
            <div style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} />
          </Menu.Target>
          <Menu.Dropdown>
            {actions.onPromote && (
              <>
                <Menu.Item leftSection={<IconArrowUp size={14} />} onClick={() => actions.onPromote!(menu.id, false)}>Promote variation</Menu.Item>
                <Menu.Item leftSection={<IconArrowBarToUp size={14} />} onClick={() => actions.onPromote!(menu.id, true)}>Make main line</Menu.Item>
              </>
            )}
            {actions.onCopyLine && <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => actions.onCopyLine!(menu.id)}>Copy line as PGN</Menu.Item>}
            {actions.onTruncate && <Menu.Item leftSection={<IconCut size={14} />} onClick={() => actions.onTruncate!(menu.id)}>Delete moves after this</Menu.Item>}
            {actions.onDelete && <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => actions.onDelete!(menu.id)}>Delete from here</Menu.Item>}
          </Menu.Dropdown>
        </Menu>
      )}
    </>
  );
}
