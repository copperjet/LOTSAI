/**
 * The pictures, drawn from data.
 *
 * "Would a visual explain this better than text?" is a question with a cheap and
 * an expensive answer. The expensive answer is an image model: money per slide,
 * a picture that cannot be checked by reading it, and labels that are wrong
 * often enough to matter in teaching material. The cheap answer is that most of
 * what a lesson needs is not a picture at all - it is structure. A flowchart, a
 * timeline, a cycle, a bar model, a Venn diagram and a labelled figure are all
 * data, and data can be drawn.
 *
 * So the model chooses the shape and supplies the labels, constrained to the
 * kinds its subject actually uses (lib/lesson/profiles.ts), and this file draws
 * them. It prints at any size, never mislabels itself, renders identically every
 * time and costs nothing. Photographs remain the teacher's to provide.
 *
 * WHY THIS DOES NOT REUSE THE STUDY PACK'S DRAWERS. Those emit elements that
 * take their colour from the pack stylesheet - `class="dg-box"` and so on. That
 * is right for a document rendered in a browser and wrong here, because these
 * SVGs are also rasterised outside any browser: sharp hands them to librsvg on
 * the way into the PowerPoint, with no stylesheet in sight. Everything here
 * therefore carries its own presentation attributes, and the SVG is standalone.
 */
import type { ChartBlock, DiagramBlock, SlideBlock } from './schema';
import { themeById, type Theme } from '@/lib/studypack/themes';
import { ACCENTS, type Accent } from '@/lib/studypack/schema';

/** The colours a drawing needs, pulled off the deck's theme and slide accent. */
export interface Palette {
  ink: string;
  muted: string;
  line: string;
  paper: string;
  card: string;
  tint: string;
  accent: string;
  accent2: string;
  mark: string;
}

export function paletteFor(themeId: string | null | undefined, accent: Accent): Palette {
  const theme: Theme = themeById(themeId);
  const i = Math.max(0, ACCENTS.indexOf(accent));
  const slot = theme.slots[i] ?? theme.slots[0];
  return {
    ink: theme.ink.text, muted: theme.ink.muted, line: theme.ink.line,
    paper: theme.ink.paper, card: theme.ink.card, tint: theme.ink.tint,
    accent: slot.c1, accent2: slot.c2, mark: theme.mark,
  };
}

/** Sans-serif by name only: the rasteriser resolves it through fontconfig, and a
 *  named web font it does not have would silently fall back anyway. */
const FONT = 'sans-serif';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The one entry point. Returns a standalone `<svg>` string, or null when the
 * block is not a drawing or carries too little data to draw - a half-drawn
 * diagram is worse on a projector than none.
 */
export function svgForBlock(block: SlideBlock, p: Palette): string | null {
  if (block.type === 'diagram') return diagramSvg(block, p);
  if (block.type === 'chart') return chartSvg(block, p);
  return null;
}

export function diagramSvg(b: DiagramBlock, p: Palette): string | null {
  switch (b.kind) {
    case 'cycle': return cycle(b, p);
    case 'timeline': return timeline(b, p);
    case 'number_line': return numberLine(b, p);
    case 'bar_model': return barModel(b, p);
    case 'grid': return grid(b, p);
    case 'tree': return tree(b, p);
    case 'venn': return venn(b, p);
    case 'labelled': return labelled(b, p);
    case 'flow':
    default: return flow(b, p);
  }
}

// ------------------------------------------------------------------- drawers

/** Steps in order, left to right, joined by arrows. Wraps past four. */
function flow(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 8);
  if (!nodes.length) return null;

  const per = nodes.length > 4 ? Math.ceil(nodes.length / 2) : nodes.length;
  const rows = [nodes.slice(0, per), nodes.slice(per)].filter(r => r.length);
  const W = 880, BOX_H = 92, GAP = 34, ROW_GAP = 30;
  const H = rows.length * BOX_H + (rows.length - 1) * ROW_GAP + 6;
  const out: string[] = [arrowhead(p.accent)];

  rows.forEach((row, r) => {
    const bw = (W - GAP * (row.length - 1)) / row.length;
    const y = r * (BOX_H + ROW_GAP) + 3;
    row.forEach((n, i) => {
      const x = i * (bw + GAP);
      out.push(rect(x, y, bw, BOX_H, 10, p.tint, p.accent, 2));
      out.push(`<rect x="${x}" y="${y}" width="6" height="${BOX_H}" rx="3" fill="${p.accent}"/>`);
      const labelY = y + (n.note ? BOX_H / 2 - 8 : BOX_H / 2 + 3);
      out.push(wrap(n.label, x + bw / 2, labelY, bw - 28, 20, p.ink, 19, 700, 2));
      if (n.note) {
        out.push(text(n.note, x + bw / 2, y + BOX_H - 18, p.muted, 15, 400));
      }
      if (i < row.length - 1) {
        const my = y + BOX_H / 2;
        out.push(`<line x1="${x + bw + 6}" y1="${my}" x2="${x + bw + GAP - 10}" y2="${my}" `
          + `stroke="${p.accent}" stroke-width="3" marker-end="url(#lvArrow)"/>`);
      }
    });
  });
  return svg(W, H, out.join(''), b.title ?? 'Flow diagram');
}

/** A ring of numbered steps, for a process that comes back to where it began. */
function cycle(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 6);
  if (nodes.length < 2) return flow(b, p);

  const W = 880, H = 420, cx = W / 2, cy = H / 2 - 4, rx = 268, ry = 136;
  const out: string[] = [
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" `
      + `stroke="${p.line}" stroke-width="3" stroke-dasharray="9 7"/>`,
    arrowhead(p.accent),
  ];

  nodes.forEach((n, i) => {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI) / nodes.length;
    const x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a);
    // An arrow on the ring, from this node towards the next, so the direction reads.
    const aNext = a + (2 * Math.PI) / nodes.length;
    const mid = a + (aNext - a) * 0.55;
    out.push(`<line x1="${(cx + rx * Math.cos(mid - 0.09)).toFixed(1)}" `
      + `y1="${(cy + ry * Math.sin(mid - 0.09)).toFixed(1)}" `
      + `x2="${(cx + rx * Math.cos(mid)).toFixed(1)}" `
      + `y2="${(cy + ry * Math.sin(mid)).toFixed(1)}" `
      + `stroke="${p.accent}" stroke-width="3" marker-end="url(#lvArrow)"/>`);

    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26" fill="${p.accent}"/>`);
    out.push(text(String(i + 1), x, y + 8, p.paper, 22, 700));
    const below = Math.sin(a) >= -0.2;
    out.push(wrap(n.label, x, y + (below ? 54 : -38), 210, 20, p.ink, 17, 600, 2));
  });
  return svg(W, H, out.join(''), b.title ?? 'Cycle diagram');
}

/**
 * Events in order along a dated line, labels alternating above and below.
 *
 * The one diagram a history lesson cannot do without, and the reason `nodes`
 * carries a `note`: the note is the date, the label is what happened.
 */
function timeline(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 7);
  if (!nodes.length) return null;

  const W = 880, H = 330, y = H / 2, PAD = 70;
  const span = W - PAD * 2;
  const out: string[] = [
    arrowhead(p.accent),
    `<line x1="${PAD}" y1="${y}" x2="${W - PAD + 18}" y2="${y}" stroke="${p.accent}" `
      + `stroke-width="4" marker-end="url(#lvArrow)"/>`,
  ];

  nodes.forEach((n, i) => {
    const x = nodes.length === 1 ? W / 2 : PAD + (span * i) / (nodes.length - 1);
    const up = i % 2 === 0;
    const tickTo = up ? y - 34 : y + 34;
    out.push(`<line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${tickTo}" `
      + `stroke="${p.line}" stroke-width="2"/>`);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y}" r="11" fill="${p.paper}" `
      + `stroke="${p.accent}" stroke-width="4"/>`);
    if (n.note) {
      out.push(text(n.note, x, up ? y - 44 : y + 56, p.mark, 17, 700));
    }
    const labelY = up ? y - 74 : y + (n.note ? 84 : 56);
    out.push(wrap(n.label, x, labelY, Math.min(200, span / nodes.length + 80), 19, p.ink, 16, 500, 3));
  });
  return svg(W, H, out.join(''), b.title ?? 'Timeline');
}

/** A ruled line from `from` to `to`, with the values that matter called out. */
function numberLine(b: DiagramBlock, p: Palette): string | null {
  const from = b.from ?? 0;
  const to = b.to ?? 10;
  if (!(to > from)) return null;

  const step = b.step && b.step > 0 ? b.step : (to - from) / 10;
  const W = 880, H = 190, PAD = 50, y = 112;
  const at = (v: number) => PAD + ((v - from) / (to - from)) * (W - PAD * 2);
  const out: string[] = [
    `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${p.ink}" stroke-width="3"/>`,
  ];

  // A step the model got wrong would draw hundreds of ticks as a black band.
  const ticks = Math.min(41, Math.floor((to - from) / step) + 1);
  for (let i = 0; i < ticks; i++) {
    const v = from + i * step, x = at(v);
    out.push(`<line x1="${x.toFixed(1)}" y1="${y - 9}" x2="${x.toFixed(1)}" y2="${y + 9}" `
      + `stroke="${p.muted}" stroke-width="2"/>`);
    out.push(text(round(v), x, y + 32, p.muted, 15, 400));
  }
  for (const m of (b.marks ?? []).slice(0, 8)) {
    if (!Number.isFinite(m?.at) || m.at < from || m.at > to) continue;
    const x = at(m.at);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y}" r="11" fill="${p.accent}"/>`);
    out.push(text(m.label, x, y - 26, p.ink, 18, 700));
  }
  return svg(W, H, out.join(''), b.title ?? 'Number line');
}

/** Parts of a whole, drawn to width. The bar model a primary maths lesson lives on. */
function barModel(b: DiagramBlock, p: Palette): string | null {
  const parts = (b.parts ?? []).filter(x => Number.isFinite(x?.value) && x.value > 0).slice(0, 8);
  const total = parts.reduce((n, x) => n + x.value, 0);
  if (!total) return null;

  const W = 880, BAR = 96, y = 16, H = BAR + 76;
  const shades = [p.accent, p.accent2, p.mark];
  const out: string[] = [];
  let x = 0;
  parts.forEach((part, i) => {
    const w = (part.value / total) * W;
    const fill = shades[i % shades.length];
    out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BAR}" `
      + `rx="6" fill="${fill}"/>`);
    if (w > 46) out.push(text(round(part.value), x + w / 2, y + BAR / 2 + 10, p.paper, 26, 700));
    out.push(wrap(part.label, x + w / 2, y + BAR + 28, Math.max(70, w), 18, p.ink, 16, 500, 2));
    x += w;
  });
  // The brace under the whole, so "parts of a whole" is visible and not implied.
  out.push(`<line x1="0" y1="${y + BAR + 52}" x2="${W}" y2="${y + BAR + 52}" `
    + `stroke="${p.muted}" stroke-width="2"/>`);
  out.push(text(`whole: ${round(total)}`, W / 2, y + BAR + 72, p.muted, 15, 600));
  return svg(W, H, out.join(''), b.title ?? 'Bar model');
}

/** Headers across the top, cells filled in order - place value, a times grid. */
function grid(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim());
  const cols = Math.max(1, b.headers?.length || Math.min(4, nodes.length) || 1);
  const cells = nodes.slice(0, cols * 6);
  if (!cells.length) return null;

  const rows = Math.ceil(cells.length / cols);
  const W = 880, CW = W / cols, CH = 78, head = b.headers?.length ? 48 : 0;
  const out: string[] = [];

  (b.headers ?? []).forEach((h, i) => {
    out.push(`<rect x="${(i * CW).toFixed(1)}" y="0" width="${CW.toFixed(1)}" height="${head}" `
      + `fill="${p.accent}"/>`);
    out.push(text(h, i * CW + CW / 2, head - 17, p.paper, 18, 700));
  });
  cells.forEach((c, i) => {
    const r = Math.floor(i / cols), col = i % cols;
    const x = col * CW, y = head + r * CH;
    out.push(rect(x, y, CW, CH, 0, r % 2 ? p.tint : p.card, p.line, 1.5));
    out.push(wrap(c.label, x + CW / 2, y + (c.note ? CH / 2 - 6 : CH / 2 + 6), CW - 18, 19, p.ink, 18, 600, 2));
    if (c.note) out.push(text(c.note, x + CW / 2, y + CH - 16, p.muted, 14, 400));
  });
  return svg(W, head + rows * CH, out.join(''), b.title ?? 'Grid');
}

/**
 * A root and its branches: a hierarchy, a classification, a decision.
 *
 * Two levels only. Three levels of boxes at a readable size does not fit the
 * height a slide has, and a diagram that needs scrolling is not a diagram.
 * `nodes[0]` is the root; the rest are its children.
 */
function tree(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 7);
  if (nodes.length < 2) return null;

  const [root, ...children] = nodes;
  const W = 880, H = 330;
  const rootW = Math.min(360, Math.max(200, root.label.length * 13));
  const rootX = (W - rootW) / 2, rootY = 8, rootH = 78;
  const childY = 200, childH = 104;
  const gap = 26;
  const childW = (W - gap * (children.length - 1)) / children.length;
  const out: string[] = [];

  out.push(rect(rootX, rootY, rootW, rootH, 10, p.accent, p.accent, 2));
  out.push(wrap(root.label, W / 2, rootY + (root.note ? 32 : rootH / 2 + 8), rootW - 24, 22, p.paper, 21, 700, 2));
  if (root.note) out.push(text(root.note, W / 2, rootY + rootH - 16, p.paper, 14, 400));

  children.forEach((c, i) => {
    const x = i * (childW + gap);
    const cx = x + childW / 2;
    // Elbow connector: down out of the root, across, then down into the child.
    const midY = (rootY + rootH + childY) / 2;
    out.push(`<path d="M ${W / 2} ${rootY + rootH} V ${midY} H ${cx.toFixed(1)} V ${childY}" `
      + `fill="none" stroke="${p.line}" stroke-width="2.5"/>`);
    out.push(rect(x, childY, childW, childH, 10, p.tint, p.line, 2));
    out.push(wrap(c.label, cx, childY + (c.note ? 34 : childH / 2 + 7), childW - 22, 20, p.ink, 18, 600, 2));
    if (c.note) out.push(wrap(c.note, cx, childY + childH - 22, childW - 22, 17, p.muted, 14, 400, 2));
  });
  return svg(W, H, out.join(''), b.title ?? 'Tree diagram');
}

/**
 * Two overlapping sets.
 *
 * `parts[0]` and `parts[1]` name the two sets; each node's `note` says where it
 * sits - anything starting "both" or "overlap" goes in the middle, otherwise it
 * is placed by which set name its note matches, and by order as a last resort.
 * That ordering matters: the model gets this wrong occasionally, and a Venn
 * diagram with everything in the overlap still reads as a Venn diagram.
 */
function venn(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 12);
  if (!nodes.length) return null;

  const left = (b.parts?.[0]?.label ?? b.headers?.[0] ?? 'A').trim();
  const right = (b.parts?.[1]?.label ?? b.headers?.[1] ?? 'B').trim();
  const W = 880, H = 400;
  const r = 168, cy = 196, lcx = W / 2 - 96, rcx = W / 2 + 96;

  const buckets: [string[], string[], string[]] = [[], [], []];
  nodes.forEach((n, i) => {
    const note = String(n.note ?? '').toLowerCase();
    let which: 0 | 1 | 2;
    if (/^(both|overlap|shared|middle|common)/.test(note)) which = 1;
    else if (note && left && note.includes(left.toLowerCase())) which = 0;
    else if (note && right && note.includes(right.toLowerCase())) which = 2;
    else which = (i % 2 === 0 ? 0 : 2);
    buckets[which].push(n.label);
  });

  const out: string[] = [
    `<circle cx="${lcx}" cy="${cy}" r="${r}" fill="${p.accent}" fill-opacity="0.16" `
      + `stroke="${p.accent}" stroke-width="3"/>`,
    `<circle cx="${rcx}" cy="${cy}" r="${r}" fill="${p.accent2}" fill-opacity="0.16" `
      + `stroke="${p.accent2}" stroke-width="3"/>`,
    text(left, lcx - 62, 34, p.accent, 20, 700),
    text(right, rcx + 62, 34, p.accent2, 20, 700),
  ];

  const columns: { x: number; width: number; items: string[] }[] = [
    { x: lcx - 92, width: 150, items: buckets[0] },
    { x: W / 2, width: 168, items: buckets[1] },
    { x: rcx + 92, width: 150, items: buckets[2] },
  ];
  for (const col of columns) {
    const items = col.items.slice(0, 5);
    const startY = cy - ((items.length - 1) * 30) / 2;
    items.forEach((label, i) => {
      out.push(wrap(label, col.x, startY + i * 30, col.width, 18, p.ink, 15, 500, 2));
    });
  }
  return svg(W, H, out.join(''), b.title ?? 'Venn diagram');
}

/**
 * A central subject with callout labels around it.
 *
 * The science and geography workhorse: the parts of a flower, the layers of a
 * soil profile, the components of a system. The centre is `title` or the first
 * node; the rest are labels with leader lines, alternating sides.
 */
function labelled(b: DiagramBlock, p: Palette): string | null {
  const nodes = b.nodes.filter(n => n?.label?.trim()).slice(0, 8);
  if (!nodes.length) return null;

  const centre = (b.title ?? nodes[0]?.label ?? '').trim();
  const labels = b.title ? nodes : nodes.slice(1);
  if (!labels.length) return null;

  const W = 880, H = 400;
  const boxW = 300, boxH = 150, bx = (W - boxW) / 2, by = (H - boxH) / 2;
  const out: string[] = [
    rect(bx, by, boxW, boxH, 14, p.tint, p.accent, 3),
    wrap(centre, W / 2, H / 2 + 6, boxW - 30, 24, p.ink, 22, 700, 3),
  ];

  const perSide = Math.ceil(labels.length / 2);
  labels.forEach((n, i) => {
    const onLeft = i % 2 === 0;
    const slot = Math.floor(i / 2);
    const rows = Math.max(1, perSide);
    const y = 44 + (slot * (H - 88)) / Math.max(1, rows - 1 || 1);
    const x = onLeft ? 16 : W - 16;
    const anchor = onLeft ? 'start' : 'end';
    const joinX = onLeft ? bx : bx + boxW;
    const labelEnd = onLeft ? 210 : W - 210;

    out.push(`<path d="M ${labelEnd} ${y.toFixed(1)} H ${onLeft ? joinX - 18 : joinX + 18} `
      + `L ${joinX} ${(by + boxH / 2).toFixed(1)}" fill="none" stroke="${p.line}" stroke-width="2"/>`);
    out.push(`<circle cx="${joinX}" cy="${(by + boxH / 2).toFixed(1)}" r="5" fill="${p.accent}"/>`);
    out.push(wrapAnchored(n.label, x, y, 190, 19, p.ink, 17, 600, 2, anchor));
    if (n.note) {
      out.push(wrapAnchored(n.note, x, y + 21, 190, 17, p.muted, 14, 400, 1, anchor));
    }
  });
  return svg(W, H, out.join(''), b.title ?? 'Labelled diagram');
}

/** A bar or line chart. Axes, gridlines, values printed on the marks. */
export function chartSvg(b: ChartBlock, p: Palette): string | null {
  const series = (b.series ?? []).filter(s => s?.label != null && Number.isFinite(s?.value)).slice(0, 12);
  if (!series.length) return null;

  const W = 880, H = 400, PAD_L = 76, PAD_R = 24, PAD_T = 24, PAD_B = 62;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const values = series.map(s => s.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const top = max === min ? max + 1 : max;
  const bottom = min < 0 ? min : 0;
  const y = (v: number) => PAD_T + innerH - ((v - bottom) / (top - bottom || 1)) * innerH;
  const step = innerW / series.length;

  const out: string[] = [];

  // Four gridlines with their values, so the chart can be read and not just seen.
  for (let i = 0; i <= 4; i++) {
    const v = bottom + ((top - bottom) * i) / 4;
    const gy = y(v);
    out.push(`<line x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - PAD_R}" y2="${gy.toFixed(1)}" `
      + `stroke="${p.line}" stroke-width="1"/>`);
    out.push(`<text x="${PAD_L - 12}" y="${(gy + 5).toFixed(1)}" text-anchor="end" `
      + `font-family="${FONT}" font-size="14" fill="${p.muted}">${esc(round(v))}</text>`);
  }

  if (b.kind === 'line') {
    const points = series.map((s, i) => `${(PAD_L + step * (i + 0.5)).toFixed(1)},${y(s.value).toFixed(1)}`).join(' ');
    out.push(`<polyline points="${points}" fill="none" stroke="${p.accent}" stroke-width="4" `
      + `stroke-linejoin="round" stroke-linecap="round"/>`);
    series.forEach((s, i) => {
      const cx = PAD_L + step * (i + 0.5);
      out.push(`<circle cx="${cx.toFixed(1)}" cy="${y(s.value).toFixed(1)}" r="6" `
        + `fill="${p.paper}" stroke="${p.accent}" stroke-width="3.5"/>`);
    });
  } else {
    series.forEach((s, i) => {
      const bw = Math.min(84, step * 0.6);
      const x = PAD_L + step * (i + 0.5) - bw / 2;
      const yv = y(s.value), y0 = y(0);
      out.push(`<rect x="${x.toFixed(1)}" y="${Math.min(yv, y0).toFixed(1)}" `
        + `width="${bw.toFixed(1)}" height="${Math.max(2, Math.abs(y0 - yv)).toFixed(1)}" `
        + `rx="4" fill="${p.accent}"/>`);
    });
  }

  series.forEach((s, i) => {
    const cx = PAD_L + step * (i + 0.5);
    out.push(wrap(String(s.label), cx, H - PAD_B + 26, step - 8, 16, p.muted, 14, 500, 2));
    out.push(text(round(s.value), cx, y(s.value) - 12, p.ink, 15, 700));
  });

  out.push(`<line x1="${PAD_L}" y1="${y(bottom).toFixed(1)}" x2="${W - PAD_R}" `
    + `y2="${y(bottom).toFixed(1)}" stroke="${p.ink}" stroke-width="2.5"/>`);

  return svg(W, H, out.join(''), b.title || 'Chart');
}

// ------------------------------------------------------------------- helpers

function svg(w: number, h: number, body: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" `
    + `width="${w}" height="${h}" role="img" aria-label="${esc(label)}">`
    + `<title>${esc(label)}</title>${body}</svg>`;
}

function rect(
  x: number, y: number, w: number, h: number, r: number,
  fill: string, stroke: string, sw: number,
): string {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" `
    + `height="${h.toFixed(1)}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function text(
  s: unknown, x: number, y: number, fill: string, size: number, weight: number,
  anchor: 'start' | 'middle' | 'end' = 'middle',
): string {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" `
    + `font-family="${FONT}" font-size="${size}" font-weight="${weight}" `
    + `fill="${fill}">${esc(s)}</text>`;
}

/**
 * SVG does not wrap.
 *
 * A two-word label in a box 200px wide is fine; a sentence in the same box runs
 * out of both sides of it. So a long label is broken at word boundaries onto at
 * most `maxLines` lines and the remainder is cut with an ellipsis - a label that
 * overflows its shape is worse than one that is visibly shortened, because the
 * teacher can see the second one and fix it.
 *
 * The character-per-line estimate is deliberately crude. It is wrong by a
 * character or two either way and never wrong by a word.
 */
function wrap(
  s: string, cx: number, y: number, width: number, lineHeight: number,
  fill: string, size: number, weight: number, maxLines: number,
): string {
  return wrapAnchored(s, cx, y, width, lineHeight, fill, size, weight, maxLines, 'middle');
}

function wrapAnchored(
  s: string, x: number, y: number, width: number, lineHeight: number,
  fill: string, size: number, weight: number, maxLines: number,
  anchor: 'start' | 'middle' | 'end',
): string {
  const lines = breakLines(String(s ?? ''), Math.max(4, Math.floor(width / (size * 0.56))), maxLines);
  if (!lines.length) return '';
  // Centre the block of lines on `y` rather than hanging it below the anchor.
  const first = y - ((lines.length - 1) * lineHeight) / 2;
  return lines.map((line, i) =>
    text(line, x, first + i * lineHeight, fill, size, weight, anchor)).join('');
}

export function breakLines(s: string, perLine: number, maxLines: number): string[] {
  const words = String(s ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= perLine) { line = next; continue; }
    if (line) lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Anything that did not fit is signalled on the last line rather than dropped silently.
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (used < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length + 1 <= perLine ? `${last}...` : `${last.slice(0, Math.max(1, perLine - 3))}...`;
  }
  return lines;
}

/** Trailing zeros off a computed value: "2.5" and "3", never "3.0000000000000004". */
function round(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  return String(Math.round(n * 100) / 100);
}

function arrowhead(colour: string): string {
  return `<defs><marker id="lvArrow" viewBox="0 0 10 10" refX="9" refY="5" `
    + `markerWidth="6" markerHeight="6" orient="auto-start-reverse">`
    + `<path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker></defs>`;
}
