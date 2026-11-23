import { HEIGHT, WIDTH, type Visual } from "./model";

type PaintContext = Pick<
  CanvasRenderingContext2D,
  | "globalAlpha"
  | "lineWidth"
  | "font"
  | "textBaseline"
  | "fillRect"
  | "fillText"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "save"
  | "restore"
> & { fillStyle: unknown; strokeStyle: unknown };
type PaintSource = (
  left: number,
  top: number,
  width: number,
  height: number,
) => void;

export function animate(
  ctx: PaintContext,
  drawSource: PaintSource,
  visuals: Visual[],
  time: number,
) {
  const active = visuals.filter(
    (item) =>
      item.enabled && time >= item.start && time < item.start + item.length,
  );
  const focus = active.find(({ kind }) => kind === "focus");
  const zoom = focus ? 1 + 0.08 * reveal(time - focus.start, focus.length) : 1;
  drawSource(
    -WIDTH * (zoom - 1) * 0.54,
    -HEIGHT * (zoom - 1) * 0.48,
    WIDTH * zoom,
    HEIGHT * zoom,
  );

  const graphic =
    active.find(({ kind }) => kind === "flow") ??
    active.find(({ kind }) => kind === "label");
  if (!graphic || graphic.kind === "focus") return;
  const elapsed = time - graphic.start;
  const alpha = reveal(elapsed, graphic.length);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = "middle";
  const y = graphic.kind === "flow" ? 227 : 275;
  ctx.fillStyle = "#15162e";
  ctx.fillRect(36, y + (1 - alpha) * 16, 696, 348 - y);
  ctx.fillStyle = "#e0c8ff";
  ctx.fillRect(36, y + (1 - alpha) * 16, 5, 348 - y);
  ctx.fillStyle = "#fcf8ff";
  ctx.font = graphic.kind === "flow" ? "bold 24px Arial" : "bold 30px Arial";
  ctx.fillText(graphic.title, 60, y + 36, 648);
  if (graphic.kind === "flow") {
    graphic.steps.forEach((step, index) => {
      const x = 60 + index * 220;
      const part = smooth((elapsed - index * graphic.length * 0.35) / 0.3);
      ctx.globalAlpha = alpha * part;
      ctx.fillStyle = "#343257";
      ctx.fillRect(x, y + 63, 190, 40);
      ctx.fillStyle = "#faf3ff";
      ctx.font = "bold 17px Arial";
      ctx.fillText(step, x + 13, y + 84, 165);
      if (index === 0) return;
      ctx.strokeStyle = "#e0c8ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 25, y + 83);
      ctx.lineTo(x - 7, y + 83);
      ctx.lineTo(x - 13, y + 77);
      ctx.moveTo(x - 7, y + 83);
      ctx.lineTo(x - 13, y + 89);
      ctx.stroke();
    });
  }
  ctx.restore();
}

function smooth(value: number) {
  const progress = Math.max(0, Math.min(1, value));
  return progress * progress * (3 - 2 * progress);
}

function reveal(elapsed: number, length: number) {
  return smooth(Math.min(elapsed, length - elapsed) / 0.34);
}
