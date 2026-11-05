import { Tooltip } from "@mantine/core";
import { barFraction, formatScore, type Score } from "../chess/eval";
import type { Color } from "../chess/position";

export function EvalBar({ score, orientation }: { score?: Score; orientation: Color }) {
  const white = score ? barFraction(score) : 0.5;
  // compact label that fits the 22px bar: 0.4, 3.2, 12, #5
  let text = "";
  if (score?.mate !== undefined) text = score.mate === 0 ? formatScore(score) : `#${Math.abs(score.mate)}`;
  else if (score) {
    const v = Math.abs((score.cp ?? 0) / 100);
    text = v >= 9.95 ? v.toFixed(0) : v.toFixed(1);
  }
  const whiteAhead = white >= 0.5;
  return (
    <Tooltip label={score ? `Evaluation ${formatScore(score)}` : "No evaluation"} position="left" openDelay={400}>
      <div className={`eval-bar ${orientation === "black" ? "flipped" : ""}`}>
        <div className="eval-white" style={{ transform: `scaleY(${white.toFixed(3)})` }} />
        <div className="eval-mid" />
        {text && (
          <span className={`eval-text ${whiteAhead === (orientation === "white") ? "bottom" : "top"} ${whiteAhead ? "on-white" : "on-black"}`}>
            {text.replace(/^-/, "")}
          </span>
        )}
      </div>
    </Tooltip>
  );
}
