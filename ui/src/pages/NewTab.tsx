import { Badge, Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconCamera, IconChess, IconFileImport, IconPuzzle, IconRobot, IconDatabase } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { newGame } from "../chess/tree";
import { useTabs, type Tab } from "../store/tabs";
import { useUi } from "../store/ui";

function Choice({ icon, title, text, onClick, highlight, color }: {
  icon: ReactNode; title: string; text: string; onClick: () => void; highlight?: boolean; color?: string;
}) {
  return (
    <Card withBorder radius="md" padding="lg" className={`choice-card ${highlight ? "highlight" : ""}`} onClick={onClick}>
      <Stack gap="sm">
        <Group justify="space-between">
          <ThemeIcon size={44} radius="md" variant="light" color={color}>{icon}</ThemeIcon>
          {highlight && <Badge variant="gradient" gradient={{ from: "teal", to: "blue" }}>New</Badge>}
        </Group>
        <Text fw={700} size="lg">{title}</Text>
        <Text size="sm" c="dimmed">{text}</Text>
      </Stack>
    </Card>
  );
}

export function NewTabPage({ tab }: { tab: Tab }) {
  const updateTab = useTabs((s) => s.updateTab);
  const setPage = useTabs((s) => s.setPage);
  const ui = useUi();

  const become = (patch: Partial<Tab>) => updateTab(tab.id, () => patch);

  return (
    <div className="newtab">
      <Stack gap="lg" maw={1100} mx="auto" p="xl">
        <div>
          <Title order={2}>What do you want to do?</Title>
          <Text c="dimmed">Pick a board below, or press Ctrl+V anywhere to paste a screenshot, PGN or FEN.</Text>
        </div>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <Choice highlight color="teal" icon={<IconCamera size={26} />} title="Analyse a screenshot"
            text="Drop or paste a picture of any 2D board. The position is recognised, you can fix it, and the engine starts analysing. Then keep playing or exploring from there."
            onClick={() => ui.openScreenshot()} />
          <Choice icon={<IconChess size={26} />} title="Analysis board"
            text="Empty board with engine lines, variations, annotations, opening explorer and game reports."
            onClick={() => become({ type: "analysis", title: "Analysis", game: newGame(), analysisOn: false })} />
          <Choice color="orange" icon={<IconRobot size={26} />} title="Play vs engine"
            text="Play Stockfish (or any UCI engine) at 8 strength levels, with or without a clock."
            onClick={() => ui.openPlay()} />
          <Choice color="grape" icon={<IconFileImport size={26} />} title="Import a game"
            text="Paste or open a PGN (all games in the file open as tabs), or start from a FEN."
            onClick={() => ui.setImportOpen(true)} />
          <Choice color="yellow" icon={<IconPuzzle size={26} />} title="Puzzles"
            text="Solve tactics from the Lichess puzzle database, filtered by theme and difficulty."
            onClick={() => become({ type: "puzzle", title: "Puzzles", puzzle: undefined })} />
          <Choice color="indigo" icon={<IconDatabase size={26} />} title="Databases"
            text="Build local game databases from PGN files or your Lichess / Chess.com games, and search them by player or position."
            onClick={() => setPage("databases")} />
        </SimpleGrid>
      </Stack>
    </div>
  );
}
