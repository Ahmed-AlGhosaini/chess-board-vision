import {
  Card, ColorSwatch, Group, NumberInput, PasswordInput, SegmentedControl, Select, SimpleGrid, Slider, Stack, Switch, Text, Title, Tooltip, UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { BOARD_THEMES, PIECE_SETS } from "../lib/themes";
import { Piece } from "../components/Piece";
import { useSettings } from "../store/settings";

const ACCENTS = ["blue", "cyan", "teal", "green", "lime", "yellow", "orange", "red", "pink", "grape", "violet", "indigo"];

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" py={6}>
      <div>
        <Text size="sm" fw={500}>{label}</Text>
        {description && <Text size="xs" c="dimmed">{description}</Text>}
      </div>
      {children}
    </Group>
  );
}

export function SettingsPage() {
  const s = useSettings();
  const theme = useMantineTheme();
  return (
    <div className="page">
      <Title order={2} mb="md">Settings</Title>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder radius="md">
          <Title order={4} mb="xs">Appearance</Title>
          <Row label="Theme">
            <SegmentedControl size="xs" value={s.colorScheme} onChange={(v) => s.set({ colorScheme: v as typeof s.colorScheme })}
              data={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "auto", label: "System" }]} />
          </Row>
          <Row label="Accent colour">
            <Group gap={4}>
              {ACCENTS.map((c) => (
                <ColorSwatch key={c} component="button" size={20} color={theme.colors[c][6]} onClick={() => s.set({ primaryColor: c })} style={{ cursor: "pointer" }}>
                  {s.primaryColor === c && <IconCheck size={12} color="white" />}
                </ColorSwatch>
              ))}
            </Group>
          </Row>
          <Text size="sm" fw={500} mt="sm" mb={6}>Board</Text>
          <SimpleGrid cols={6} spacing={6}>
            {BOARD_THEMES.map((t) => (
              <Tooltip key={t.name} label={t.label}>
                <UnstyledButton onClick={() => s.set({ boardTheme: t.name })} className={`theme-swatch ${s.boardTheme === t.name ? "selected" : ""}`}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", aspectRatio: "1" }}>
                    <div style={{ background: t.light }} /><div style={{ background: t.dark }} />
                    <div style={{ background: t.dark }} /><div style={{ background: t.light }} />
                  </div>
                </UnstyledButton>
              </Tooltip>
            ))}
          </SimpleGrid>
          <Row label="Pieces" description="Lichess piece sets; downloaded once, then cached">
            <Group gap="xs" wrap="nowrap">
              <Piece role="knight" color="white" size={32} />
              <Piece role="queen" color="black" size={32} />
              <Select size="xs" w={150} data={PIECE_SETS} value={s.pieceSet} onChange={(v) => v && s.set({ pieceSet: v })} searchable allowDeselect={false} />
            </Group>
          </Row>
          <Row label="Coordinates"><Switch checked={s.coordinates} onChange={(e) => s.set({ coordinates: e.currentTarget.checked })} /></Row>
          <Row label="Piece animation"><Switch checked={s.animation} onChange={(e) => s.set({ animation: e.currentTarget.checked })} /></Row>
          <Row label="Show legal moves"><Switch checked={s.showDests} onChange={(e) => s.set({ showDests: e.currentTarget.checked })} /></Row>
          <Row label="Highlight last move"><Switch checked={s.showLastMove} onChange={(e) => s.set({ showLastMove: e.currentTarget.checked })} /></Row>
          <Row label="Captured material"><Switch checked={s.showMaterial} onChange={(e) => s.set({ showMaterial: e.currentTarget.checked })} /></Row>
          <Row label="Figurine notation" description="♘f3 instead of Nf3"><Switch checked={s.figurine} onChange={(e) => s.set({ figurine: e.currentTarget.checked })} /></Row>
        </Card>
        <Stack>
          <Card withBorder radius="md">
            <Title order={4} mb="xs">Board behaviour</Title>
            <Row label="Always promote to queen"><Switch checked={s.autoQueen} onChange={(e) => s.set({ autoQueen: e.currentTarget.checked })} /></Row>
            <Row label="Sounds"><Switch checked={s.sound} onChange={(e) => s.set({ sound: e.currentTarget.checked })} /></Row>
            <Row label="Volume"><Slider w={180} min={0} max={1} step={0.05} value={s.volume} onChange={(v) => s.set({ volume: v })} label={(v) => `${Math.round(v * 100)}%`} /></Row>
          </Card>
          <Card withBorder radius="md">
            <Title order={4} mb="xs">Analysis</Title>
            <Row label="Evaluation bar"><Switch checked={s.showEvalBar} onChange={(e) => s.set({ showEvalBar: e.currentTarget.checked })} /></Row>
            <Row label="Engine arrows" description="Best moves drawn on the board">
              <SegmentedControl size="xs" value={String(s.engineArrows)} onChange={(v) => s.set({ engineArrows: Number(v) })} data={["0", "1", "2", "3"]} />
            </Row>
            <Row label="Report depth" description="Search depth for each move of a game report">
              <NumberInput size="xs" w={90} min={6} max={30} value={s.reportDepth} onChange={(v) => s.set({ reportDepth: Number(v) || 16 })} />
            </Row>
            <Row label="Add best lines to reports"><Switch checked={s.reportVariations} onChange={(e) => s.set({ reportVariations: e.currentTarget.checked })} /></Row>
          </Card>
          <Card withBorder radius="md">
            <Title order={4} mb="xs">Lichess</Title>
            <Text size="xs" c="dimmed" mb="xs">
              Optional personal API token (lichess.org/account/oauth/token). Used only for the opening explorer, puzzles and game downloads;
              it is stored in this browser and sent only to your local server, which forwards it to Lichess.
            </Text>
            <PasswordInput placeholder="lip_…" value={s.lichessToken} onChange={(e) => s.set({ lichessToken: e.currentTarget.value.trim() })} />
          </Card>
        </Stack>
      </SimpleGrid>
    </div>
  );
}
