import { Card, Divider, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconBroadcast, IconCamera, IconChess, IconFileImport, IconPuzzle, IconRobot, IconDatabase } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { newGame } from "../chess/tree";
import { useTabs, type Tab } from "../store/tabs";
import { useUi } from "../store/ui";

function Choice({ icon, title, text, onClick, color }: {
  icon: ReactNode; title: string; text: string; onClick: () => void; color?: string;
}) {
  return (
    <Card withBorder radius="md" padding="lg" className="choice-card" onClick={onClick}>
      <Stack gap="sm">
        <ThemeIcon size={44} radius="md" variant="light" color={color}>{icon}</ThemeIcon>
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
          <Text c="dimmed">Pick a board below, or press Ctrl+V anywhere to paste a screenshot, PGN, FEN or Lichess link.</Text>
        </div>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <Choice color="red" icon={<IconBroadcast size={26} />} title="Watch a live game"
            text="Follow a game while it is played, on Lichess (games, broadcasts, TV) or from any screen you share, with the engine on every move."
            onClick={() => ui.setLiveOpen(true)} />
          <Choice color="teal" icon={<IconCamera size={26} />} title="Analyse a screenshot"
            text="Drop or paste a picture of any 2D board. The position is recognised, you can fix it, and the engine starts analysing. Then keep playing or exploring from there."
            onClick={() => ui.openScreenshot()} />
          <Choice color="grape" icon={<IconFileImport size={26} />} title="Import a game"
            text="Paste a Lichess game, study or puzzle link, or a PGN or FEN. Or add the Firefox extension, which follows the Lichess tabs you choose live."
            onClick={() => ui.setImportOpen(true)} />
        </SimpleGrid>
        <Divider />
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          <Choice icon={<IconChess size={26} />} title="Analysis board"
            text="Empty board with engine lines, variations, annotations, opening explorer and game reports."
            onClick={() => become({ type: "analysis", title: "Analysis", game: newGame(), analysisOn: false })} />
          <Choice color="orange" icon={<IconRobot size={26} />} title="Play vs engine"
            text="Play Stockfish (or any UCI engine) at 8 strength levels, with or without a clock."
            onClick={() => ui.openPlay()} />
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
