import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Card, Checkbox, Group, NumberInput, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCpu, IconPlus, IconTrash } from "@tabler/icons-react";
import { api, type EngineInfo, type EngineOption } from "../lib/api";
import { engineSettingsFor, useSettings } from "../store/settings";

// options that have their own controls or that the server manages
const HIDDEN = new Set(["Threads", "Hash", "MultiPV", "Ponder", "UCI_Chess960", "UCI_AnalyseMode", "Debug Log File", "Clear Hash"]);

function OptionInput({ name, opt, value, onChange }: { name: string; opt: EngineOption; value: any; onChange: (v: any) => void }) {
  const v = value ?? opt.default;
  switch (opt.type) {
    case "spin":
      return <NumberInput size="xs" label={name} min={opt.min ?? undefined} max={opt.max ?? undefined} value={Number(v)} onChange={(x) => onChange(Number(x))} />;
    case "check":
      return <Switch size="xs" label={name} checked={v === true || v === "true"} onChange={(e) => onChange(e.currentTarget.checked)} mt="md" />;
    case "combo":
      return <Select size="xs" label={name} data={opt.var} value={String(v)} onChange={(x) => onChange(x)} allowDeselect={false} />;
    case "string":
      return <TextInput size="xs" label={name} value={v === "<empty>" ? "" : String(v ?? "")} onChange={(e) => onChange(e.currentTarget.value)} />;
    default:
      return null;
  }
}

export function EnginesPage() {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const all = useSettings((s) => s.engineSettings);
  const setEngineSettings = useSettings((s) => s.setEngineSettings);
  const analysisEngines = useSettings((s) => s.analysisEngines);
  const set = useSettings((s) => s.set);

  const load = () => api<EngineInfo[]>("/api/engines").then(setEngines).catch(() => {});
  useEffect(() => void load(), []);

  const add = async () => {
    setAdding(true);
    try {
      const e = await api<EngineInfo>("/api/engines", { method: "POST", json: { path } });
      notifications.show({ color: "green", message: `Added ${e.name}` });
      setPath("");
      void load();
    } catch (e: any) {
      notifications.show({ color: "red", title: "Could not add engine", message: e.message });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page">
      <Title order={2} mb="md">Engines</Title>
      <Card withBorder mb="lg">
        <Text size="sm" mb="xs">Add any UCI engine (Stockfish, Leela Chess Zero, Komodo Dragon, Berserk, …) by the full path of its executable.</Text>
        <Group align="end">
          <TextInput style={{ flex: 1 }} label="Engine executable" placeholder="C:\engines\lc0\lc0.exe" value={path} onChange={(e) => setPath(e.currentTarget.value)} />
          <Button leftSection={<IconPlus size={16} />} onClick={add} loading={adding} disabled={!path.trim()}>Add engine</Button>
        </Group>
      </Card>
      {!engines.length && <Alert color="orange">No engine found. Put Stockfish in engine/stockfish/, set STOCKFISH_PATH, or add one above.</Alert>}
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {engines.map((e) => {
          const s = engineSettingsFor(all, e.id);
          const opts = Object.entries(e.options ?? {}).filter(([n, o]) => !HIDDEN.has(n) && o.type !== "button");
          return (
            <Card key={e.id} withBorder radius="md">
              <Group justify="space-between" mb="xs" wrap="nowrap">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <IconCpu size={22} />
                  <div style={{ minWidth: 0 }}>
                    <Group gap={6}><Text fw={700}>{e.name}</Text>{e.builtin && <Badge size="xs" variant="light">bundled</Badge>}</Group>
                    <Text size="xs" c="dimmed" truncate>{e.path}</Text>
                  </div>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Checkbox label="Use for analysis" checked={analysisEngines.includes(e.id)}
                    onChange={(ev) => {
                      const next = ev.currentTarget.checked ? [...analysisEngines, e.id] : analysisEngines.filter((x) => x !== e.id);
                      if (next.length) set({ analysisEngines: next });
                    }} />
                  {!e.builtin && (
                    <Tooltip label="Remove">
                      <ActionIcon color="red" variant="subtle" onClick={async () => { await api(`/api/engines/${e.id}`, { method: "DELETE" }); void load(); }}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Group>
              {e.error && <Alert color="red" p="xs" mb="xs">{e.error}</Alert>}
              <SimpleGrid cols={3} spacing="xs">
                <NumberInput size="xs" label="Threads" min={1} max={e.options?.Threads?.max ?? 256} value={s.threads} onChange={(v) => setEngineSettings(e.id, { threads: Number(v) || 1 })} />
                <NumberInput size="xs" label="Hash (MB)" min={1} step={64} value={s.hash} onChange={(v) => setEngineSettings(e.id, { hash: Number(v) || 16 })} />
                <NumberInput size="xs" label="Lines (MultiPV)" min={1} max={5} value={s.multipv} onChange={(v) => setEngineSettings(e.id, { multipv: Number(v) || 1 })} />
              </SimpleGrid>
              {opts.length > 0 && (
                <Stack gap={4} mt="sm">
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>UCI options</Text>
                  <SimpleGrid cols={3} spacing="xs">
                    {opts.map(([name, opt]) => (
                      <OptionInput key={name} name={name} opt={opt} value={s.options[name]}
                        onChange={(v) => setEngineSettings(e.id, { options: { ...s.options, [name]: v } })} />
                    ))}
                  </SimpleGrid>
                </Stack>
              )}
            </Card>
          );
        })}
      </SimpleGrid>
    </div>
  );
}
