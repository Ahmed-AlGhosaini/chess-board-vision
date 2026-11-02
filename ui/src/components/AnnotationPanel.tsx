import { Button, Group, SimpleGrid, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import { IconEraser } from "@tabler/icons-react";
import { MOVE_NAGS, NAGS } from "../chess/eval";
import type { TreeNode } from "../chess/tree";

const POSITION_NAGS = [10, 13, 14, 15, 16, 17, 18, 19];
const OTHER_NAGS = NAGS.map((n) => n.nag).filter((n) => !MOVE_NAGS.includes(n) && !POSITION_NAGS.includes(n));

export function AnnotationPanel({ node, onToggleNag, onComment, onClearShapes }: {
  node: TreeNode;
  onToggleNag: (nag: number, group: number[]) => void;
  onComment: (text: string) => void;
  onClearShapes: () => void;
}) {
  const nags = node.nags ?? [];
  const isRoot = !node.parent;
  const group = (list: number[]) => (
    <SimpleGrid cols={list.length > 7 ? 8 : list.length} spacing={4}>
      {list.map((nag) => {
        const info = NAGS.find((n) => n.nag === nag)!;
        const on = nags.includes(nag);
        return (
          <Tooltip key={nag} label={info.label} openDelay={300}>
            <Button size="compact-sm" variant={on ? "filled" : "default"} disabled={isRoot}
              style={on && info.color ? { background: info.color } : undefined}
              onClick={() => onToggleNag(nag, list)}>
              {info.symbol}
            </Button>
          </Tooltip>
        );
      })}
    </SimpleGrid>
  );
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {isRoot ? "Starting position" : `${Math.floor((node.ply - 1) / 2) + 1}${node.ply % 2 ? "." : "..."} ${node.san}`}
      </Text>
      <Text size="xs" c="dimmed">Move quality</Text>
      {group(MOVE_NAGS)}
      <Text size="xs" c="dimmed">Position</Text>
      {group(POSITION_NAGS)}
      <Text size="xs" c="dimmed">Ideas</Text>
      {group(OTHER_NAGS)}
      <Textarea label="Comment" autosize minRows={3} maxRows={10} value={node.comment ?? ""}
        onChange={(e) => onComment(e.currentTarget.value)} placeholder="Write a comment for this move…" />
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Right-click and drag on the board to draw arrows; Shift/Alt/Ctrl change the colour.</Text>
        <Button size="compact-xs" variant="subtle" leftSection={<IconEraser size={12} />} disabled={!node.shapes?.length} onClick={onClearShapes}>
          Clear drawings
        </Button>
      </Group>
    </Stack>
  );
}
