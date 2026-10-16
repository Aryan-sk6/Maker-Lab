// Number formatting shared by the server's text summary and the widget.

const PREFIXES: [number, string][] = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
];
/** Units where an SI prefix reads naturally (1.5 ms, 4.7 µF). Others (rad/s, m/s, °) stay as they are. */
const SI_UNITS = new Set(["s", "V", "A", "F", "H", "Ω", "Hz", "W"]);

/** Significant digits, trimming trailing zeros; exponent form for very small or large numbers. */
export function sig(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return "n/a";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs < 1e-3 || abs >= 1e6) return Number(v.toExponential(digits - 1)).toExponential().replace("e+", "e");
  return String(Number(v.toPrecision(digits)));
}

/** Pick the SI prefix that puts `maxAbs` between 1 and 1000. */
export function siPrefix(maxAbs: number, unit: string): { factor: number; prefix: string } {
  if (!SI_UNITS.has(unit) || !(maxAbs > 0) || !Number.isFinite(maxAbs)) return { factor: 1, prefix: "" };
  for (const [factor, prefix] of PREFIXES) if (maxAbs >= factor) return { factor, prefix };
  return { factor: 1e-12, prefix: "p" };
}

export function formatValue(v: number | string | null, unit: string): string {
  if (v === null) return "n/a";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "n/a";
  const { factor, prefix } = siPrefix(Math.abs(v), unit);
  const suffix = unit ? ` ${prefix}${unit}` : "";
  return `${sig(v / factor)}${suffix}`;
}
