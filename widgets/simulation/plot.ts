// A small canvas line plot: nice ticks, SI-prefixed axis labels, reference lines, a moving cursor and a hover read-out.
// Written for this project (no chart library) so the widget stays one small file.

import { sig, siPrefix } from "../../shared/format.js";

export interface PlotLine {
  label: string;
  x: Float64Array;
  y: Float64Array;
}

export interface PlotSpec {
  x: { label: string; unit: string };
  y: { label: string; unit: string };
  lines: PlotLine[];
  refs: { y: number; label: string }[];
  equalAspect?: boolean;
}

export interface PlotTheme {
  text: string;
  muted: string;
  grid: string;
  bg: string;
  series: string[];
}

const MARGIN = { left: 64, right: 16, top: 14, bottom: 44 };

export interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  toX(v: number): number;
  toY(v: number): number;
  fromX(px: number): number;
}

function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

function arrayExtent(a: Float64Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** 1, 2, 5 × 10ⁿ step that gives about `target` intervals. */
export function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

export function layoutFor(spec: PlotSpec, w: number, h: number): Layout {
  let [xMin, xMax] = extent(spec.lines.flatMap((l) => arrayExtent(l.x)));
  let [yMin, yMax] = extent([...spec.lines.flatMap((l) => arrayExtent(l.y)), ...spec.refs.map((r) => r.y)]);
  if (!(xMax > xMin)) [xMin, xMax] = [xMin - 1, xMax + 1];
  if (!(yMax > yMin)) [yMin, yMax] = [yMin - 1, yMax + 1];
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad;
  yMax += pad;

  const width = Math.max(10, w - MARGIN.left - MARGIN.right);
  const height = Math.max(10, h - MARGIN.top - MARGIN.bottom);

  if (spec.equalAspect) {
    const scale = Math.min(width / (xMax - xMin), height / (yMax - yMin)); // pixels per unit, same on both axes
    if ((yMax - yMin) * scale >= 0.2 * height) {
      const xr = width / scale;
      const yr = height / scale;
      const xc = (xMin + xMax) / 2;
      xMin = xc - xr / 2;
      xMax = xc + xr / 2;
      yMax = yMin + yr; // keep the bottom (the ground) fixed and extend upward
    }
  }

  return {
    left: MARGIN.left,
    top: MARGIN.top,
    width,
    height,
    xMin,
    xMax,
    yMin,
    yMax,
    toX: (v) => MARGIN.left + ((v - xMin) / (xMax - xMin)) * width,
    toY: (v) => MARGIN.top + height - ((v - yMin) / (yMax - yMin)) * height,
    fromX: (px) => xMin + ((px - MARGIN.left) / width) * (xMax - xMin),
  };
}

function ticks(min: number, max: number, target: number): { values: number[]; step: number } {
  const step = niceStep(max - min, target);
  const values: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { values, step };
}

function tickLabel(v: number, step: number, factor: number): string {
  const scaled = v / factor;
  const scaledStep = step / factor;
  if (scaled === 0) return "0";
  if (Math.abs(scaled) >= 1e6 || Math.abs(scaledStep) < 1e-4) return sig(scaled, 3);
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(scaledStep) + 1e-9)));
  return scaled.toFixed(decimals);
}

const axisTitle = (label: string, unit: string, prefix: string) => (unit ? `${label} (${prefix}${unit})` : label);

export interface DrawState {
  /** Index into every line, for the animation marker. */
  cursor?: number;
  /** Index into every line, for the hover read-out. */
  hover?: number;
}

export function drawPlot(ctx: CanvasRenderingContext2D, w: number, h: number, spec: PlotSpec, theme: PlotTheme, state: DrawState = {}): Layout {
  const L = layoutFor(spec, w, h);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.lineJoin = "round";

  const xp = siPrefix(Math.max(Math.abs(L.xMin), Math.abs(L.xMax)), spec.x.unit);
  const yp = siPrefix(Math.max(Math.abs(L.yMin), Math.abs(L.yMax)), spec.y.unit);
  const xt = ticks(L.xMin, L.xMax, Math.max(3, Math.floor(L.width / 90)));
  const yt = ticks(L.yMin, L.yMax, Math.max(3, Math.floor(L.height / 50)));

  // Grid and tick labels.
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const v of xt.values) {
    const x = Math.round(L.toX(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, L.top);
    ctx.lineTo(x, L.top + L.height);
    ctx.stroke();
    ctx.fillText(tickLabel(v, xt.step, xp.factor), x, L.top + L.height + 6);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of yt.values) {
    const y = Math.round(L.toY(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L.left, y);
    ctx.lineTo(L.left + L.width, y);
    ctx.stroke();
    ctx.fillText(tickLabel(v, yt.step, yp.factor), L.left - 8, y);
  }

  // Axis titles.
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(axisTitle(spec.x.label, spec.x.unit, xp.prefix), L.left + L.width / 2, h - 6);
  ctx.save();
  ctx.translate(14, L.top + L.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(axisTitle(spec.y.label, spec.y.unit, yp.prefix), 0, 0);
  ctx.restore();

  // Clip the data to the plot area.
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.left, L.top, L.width, L.height);
  ctx.clip();

  // Reference lines.
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = theme.muted;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  for (const ref of spec.refs) {
    const y = L.toY(ref.y);
    ctx.beginPath();
    ctx.moveTo(L.left, y);
    ctx.lineTo(L.left + L.width, y);
    ctx.stroke();
    if (ref.label) ctx.fillText(ref.label, L.left + L.width - 4, y - 3);
  }
  ctx.setLineDash([]);

  // Data lines (decimated so a 100 000-point run still draws instantly).
  spec.lines.forEach((line, k) => {
    ctx.strokeStyle = theme.series[k % theme.series.length]!;
    ctx.lineWidth = 2;
    const n = line.x.length;
    const stride = Math.max(1, Math.ceil(n / (L.width * 3)));
    ctx.beginPath();
    for (let i = 0; i < n; i += stride) {
      const px = L.toX(line.x[i]!);
      const py = L.toY(line.y[i]!);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.lineTo(L.toX(line.x[n - 1]!), L.toY(line.y[n - 1]!));
    ctx.stroke();
  });

  // Animation cursor: a dot on each line.
  if (state.cursor !== undefined) {
    spec.lines.forEach((line, k) => {
      const i = Math.min(state.cursor!, line.x.length - 1);
      ctx.fillStyle = theme.series[k % theme.series.length]!;
      ctx.strokeStyle = theme.bg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(L.toX(line.x[i]!), L.toY(line.y[i]!), 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  // Hover crosshair.
  if (state.hover !== undefined) {
    const i = Math.min(state.hover, spec.lines[0]!.x.length - 1);
    const x = L.toX(spec.lines[0]!.x[i]!);
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, L.top);
    ctx.lineTo(x, L.top + L.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();

  // Legend (only when there is more than one line to tell apart).
  if (spec.lines.length > 1) {
    let lx = L.left + 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    spec.lines.forEach((line, k) => {
      ctx.fillStyle = theme.series[k % theme.series.length]!;
      ctx.fillRect(lx, L.top + 12, 14, 3);
      ctx.fillStyle = theme.text;
      ctx.fillText(line.label, lx + 20, L.top + 14);
      lx += 28 + ctx.measureText(line.label).width + 12;
    });
  }

  // Hover read-out box.
  if (state.hover !== undefined) {
    const i = Math.min(state.hover, spec.lines[0]!.x.length - 1);
    const rows = [`${spec.x.label} ${fmt(spec.lines[0]!.x[i]!, spec.x.unit)}`, ...spec.lines.map((l) => `${l.label} ${fmt(l.y[i]!, spec.y.unit)}`)];
    const boxW = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16;
    const boxH = rows.length * 16 + 8;
    let bx = L.toX(spec.lines[0]!.x[i]!) + 10;
    if (bx + boxW > L.left + L.width) bx -= boxW + 20;
    const by = L.top + 24;
    ctx.fillStyle = theme.bg;
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    rows.forEach((r, k) => ctx.fillText(r, bx + 8, by + 14 + k * 16));
  }
  return L;
}

function fmt(v: number, unit: string): string {
  const { factor, prefix } = siPrefix(Math.abs(v), unit);
  return `${sig(v / factor, 4)}${unit ? ` ${prefix}${unit}` : ""}`;
}

/** Index of the point whose x is nearest to the pixel column (x must be non-decreasing). */
export function nearestIndex(x: Float64Array, value: number): number {
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid]! < value) lo = mid;
    else hi = mid;
  }
  return Math.abs(x[lo]! - value) <= Math.abs(x[hi]! - value) ? lo : hi;
}
