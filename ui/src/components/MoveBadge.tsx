export interface MoveBadge {
  square: string;
  glyph: string;
  color: string;
  label: string;
}

/*
 * Glyphs are drawn rather than typeset: where a font puts a character depends on
 * the font, so text cannot be centred reliably. Each shape is drawn around (0, 0),
 * the centre of the badge, and every glyph spans the same distance either side of it.
 */
interface Stroke {
  d: string;
  width: number;
  fill?: boolean;
}

const BANG: Stroke[] = [
  { d: "M0 -22 V8", width: 13 },
  { d: "M0 22 h0.01", width: 13 },
];
const QUESTION: Stroke[] = [
  { d: "M-12 -11 A12 12 0 1 1 12 -11 C12 -3 0 -2 0 8", width: 11 },
  { d: "M0 22.5 h0.01", width: 12 },
];

/** Five points on a circle around the centre, so every tip is as far from the rim as the others. */
function starPath(outer: number, inner: number): string {
  const points = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    return `${(r * Math.cos(angle)).toFixed(2)} ${(r * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${points.join(" L")} Z`;
}

interface Part {
  strokes: Stroke[];
  x?: number;
}

/** For each glyph: its parts, placed so the whole is centred, and a scale that fits it in the circle. */
const GLYPHS: Record<string, { parts: Part[]; scale?: number }> = {
  "!": { parts: [{ strokes: BANG }] },
  "!!": { parts: [{ strokes: BANG, x: -11 }, { strokes: BANG, x: 11 }] },
  "?": { parts: [{ strokes: QUESTION }] },
  "??": { parts: [{ strokes: QUESTION, x: -20.5 }, { strokes: QUESTION, x: 20.5 }], scale: 0.7 },
  "?!": { parts: [{ strokes: QUESTION, x: -9.5 }, { strokes: BANG, x: 20.5 }], scale: 0.85 },
  "!?": { parts: [{ strokes: BANG, x: -20.5 }, { strokes: QUESTION, x: 9.5 }], scale: 0.85 },
  "★": { parts: [{ strokes: [{ d: starPath(30, 13), width: 5, fill: true }] }] },
  "✓": { parts: [{ strokes: [{ d: "M-20.5 1 L-6.5 14.5 L20.5 -14.5", width: 11 }] }] },
};

function GlyphLayer({ glyph, color, extraWidth }: { glyph: string; color: string; extraWidth: number }) {
  const { parts } = GLYPHS[glyph];
  return (
    <>
      {parts.map(({ strokes, x = 0 }, i) => (
        <g key={i} transform={`translate(${x} 0)`}>
          {strokes.map((s) => (
            <path key={s.d} d={s.d} fill={s.fill ? color : "none"} stroke={color} strokeWidth={s.width + extraWidth} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </g>
      ))}
    </>
  );
}

export function MoveBadgeIcon({ badge, style, className }: { badge: Pick<MoveBadge, "glyph" | "color" | "label">; style?: React.CSSProperties; className?: string }) {
  const known = !!GLYPHS[badge.glyph];
  return (
    <svg className={className} viewBox="0 0 100 100" role="img" aria-label={badge.label} style={style}>
      <title>{badge.label}</title>
      <circle cx="50" cy="50" r="48" fill={badge.color} stroke="#fff" strokeWidth="4" />
      {known && (
        <g transform={`translate(50 50) scale(${GLYPHS[badge.glyph].scale ?? 1})`}>
          {/* a dark edge keeps the white glyph readable on the yellow and orange badges */}
          <GlyphLayer glyph={badge.glyph} color="rgba(0,0,0,0.3)" extraWidth={4} />
          <GlyphLayer glyph={badge.glyph} color="#fff" extraWidth={0} />
        </g>
      )}
    </svg>
  );
}
