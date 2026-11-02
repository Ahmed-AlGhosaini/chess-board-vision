export interface BoardTheme {
  name: string;
  label: string;
  light: string;
  dark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { name: "brown", label: "Brown", light: "#f0d9b5", dark: "#b58863" },
  { name: "blue", label: "Blue", light: "#dee3e6", dark: "#8ca2ad" },
  { name: "ocean", label: "Ocean", light: "#97b2c7", dark: "#546f82" },
  { name: "green", label: "Green", light: "#ffffdd", dark: "#86a666" },
  { name: "emerald", label: "Emerald", light: "#eeeed2", dark: "#769656" },
  { name: "purple", label: "Purple", light: "#9f90b0", dark: "#7d4a8d" },
  { name: "lavender", label: "Lavender", light: "#e8e1f2", dark: "#a08bc4" },
  { name: "grey", label: "Grey", light: "#c4c4c4", dark: "#888888" },
  { name: "slate", label: "Slate", light: "#c8ccd0", dark: "#6b7b8c" },
  { name: "sand", label: "Sand", light: "#ececec", dark: "#c1c18e" },
  { name: "coral", label: "Coral", light: "#f1f1c9", dark: "#e57373" },
  { name: "night", label: "Night", light: "#7f8a96", dark: "#3b4654" },
];

/** Lichess piece sets (downloaded once by the server, then cached). cburnett is bundled. */
export const PIECE_SETS = [
  "cburnett", "merida", "alpha", "pirouetti", "chessnut", "chess7", "reillycraig", "companion",
  "riohacha", "kosal", "leipzig", "fantasy", "spatial", "celtic", "california", "caliente",
  "pixel", "maestro", "fresca", "cardinal", "gioco", "tatiana", "staunty", "governor", "dubrovny",
  "icpieces", "mpchess", "kiwen-suwi", "horsey", "anarcandy", "cooke", "rhosgfx", "firi",
  "monarchy", "libra", "xkcd", "shapes", "letter", "mono", "disguised",
];

export const pieceUrl = (set: string, code: string) => `/pieces/${set}/${code}.svg`;

function boardSvg(light: string, dark: string): string {
  let d = "";
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if ((r + c) % 2) d += `M${c} ${r}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${light}"/><path fill="${dark}" d="${d}"/></svg>`;
  return `url("data:image/svg+xml;base64,${btoa(svg)}")`;
}

const ROLES: [string, string][] = [["pawn", "P"], ["knight", "N"], ["bishop", "B"], ["rook", "R"], ["queen", "Q"], ["king", "K"]];

/** CSS that applies the chosen board colours and piece set to every chessground board. */
export function themeCss(themeName: string, pieceSet: string): string {
  const t = BOARD_THEMES.find((b) => b.name === themeName) ?? BOARD_THEMES[0];
  let css = `cg-board { background-color: ${t.light}; background-image: ${boardSvg(t.light, t.dark)} !important; }
.orientation-white .ranks :nth-child(even), .orientation-white .files :nth-child(even),
.orientation-black .ranks :nth-child(odd), .orientation-black .files :nth-child(odd) { color: ${t.dark} !important; }
.orientation-white .ranks :nth-child(odd), .orientation-white .files :nth-child(odd),
.orientation-black .ranks :nth-child(even), .orientation-black .files :nth-child(even) { color: ${t.light} !important; }
`;
  if (pieceSet !== "cburnett") {
    for (const [role, letter] of ROLES)
      for (const [color, prefix] of [["white", "w"], ["black", "b"]])
        css += `piece.${role}.${color} { background-image: url(${pieceUrl(pieceSet, prefix + letter)}) !important; }\n`;
  }
  return css;
}
