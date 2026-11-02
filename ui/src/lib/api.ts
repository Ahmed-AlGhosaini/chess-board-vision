import { useSettings } from "../store/settings";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = useSettings.getState().lichessToken;
  if (token) headers["X-Lichess-Token"] = token;
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // plain-text response
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.detail || data.error || JSON.stringify(data) : text;
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export interface EngineOption {
  type: string;
  default: any;
  min: number | null;
  max: number | null;
  var: string[];
}

export interface EngineInfo {
  id: string;
  name: string;
  path: string;
  builtin: boolean;
  author?: string;
  error?: string;
  options: Record<string, EngineOption>;
}

export interface Job {
  id: string;
  label: string;
  progress: number;
  message: string;
  done: boolean;
  error: string | null;
  result: any;
}

/** Poll a background job until it finishes. */
export async function waitForJob(id: string, onProgress?: (j: Job) => void): Promise<Job> {
  for (;;) {
    const job = await api<Job>(`/api/jobs/${id}`);
    onProgress?.(job);
    if (job.done) {
      if (job.error) throw new Error(job.error);
      return job;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ------------------------------------------------------------ websocket

type Listener = (msg: any) => void;

/** One shared websocket to the engine server, reconnecting automatically. */
class EngineSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(up: boolean) => void>();
  private queue: string[] = [];
  connected = false;

  private connect() {
    if (this.ws) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.statusListeners.forEach((f) => f(true));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      this.listeners.get(msg.id)?.forEach((f) => f(msg));
    };
    ws.onclose = () => {
      this.ws = null;
      this.connected = false;
      this.statusListeners.forEach((f) => f(false));
      this.listeners.forEach((set, id) => set.forEach((f) => f({ type: "disconnected", id })));
      setTimeout(() => this.connect(), 1500);
    };
  }

  send(msg: object) {
    this.connect();
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  subscribe(id: string, fn: Listener): () => void {
    this.connect();
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(fn);
    return () => {
      this.listeners.get(id)?.delete(fn);
    };
  }

  onStatus(fn: (up: boolean) => void): () => void {
    this.connect();
    this.statusListeners.add(fn);
    return () => {
      this.statusListeners.delete(fn);
    };
  }
}

export const engineSocket = new EngineSocket();
