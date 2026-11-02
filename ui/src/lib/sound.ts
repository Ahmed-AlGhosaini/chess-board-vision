import { useSettings } from "../store/settings";

export type SoundKind = "move" | "capture" | "check" | "end" | "error" | "success";

let ctx: AudioContext | null = null;

function noiseTock(ac: AudioContext, at: number, freq: number, gain: number, length = 0.07) {
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * length), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 4);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(at);
}

function tone(ac: AudioContext, at: number, freq: number, gain: number, length: number) {
  const osc = ac.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(g).connect(ac.destination);
  osc.start(at);
  osc.stop(at + length);
}

/** Small synthesised board sounds (no audio files needed). */
export function playSound(kind: SoundKind) {
  const { sound, volume } = useSettings.getState();
  if (!sound || volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime + 0.005;
    const v = volume * 1.6;
    switch (kind) {
      case "move":
        noiseTock(ctx, t, 1800, v);
        break;
      case "capture":
        noiseTock(ctx, t, 900, v * 1.4, 0.09);
        noiseTock(ctx, t + 0.045, 1400, v * 0.8);
        break;
      case "check":
        noiseTock(ctx, t, 1800, v);
        tone(ctx, t, 880, volume * 0.12, 0.18);
        break;
      case "end":
        tone(ctx, t, 523, volume * 0.15, 0.25);
        tone(ctx, t + 0.18, 659, volume * 0.15, 0.25);
        tone(ctx, t + 0.36, 784, volume * 0.15, 0.4);
        break;
      case "error":
        tone(ctx, t, 220, volume * 0.18, 0.25);
        break;
      case "success":
        tone(ctx, t, 659, volume * 0.15, 0.15);
        tone(ctx, t + 0.12, 988, volume * 0.15, 0.3);
        break;
    }
  } catch {
    // audio unavailable (autoplay policy, no device): stay silent
  }
}

export function moveSound(r: { capture: boolean; check: boolean }) {
  playSound(r.check ? "check" : r.capture ? "capture" : "move");
}
