/** Simplified front-view anatomy in the 3D model's coordinates (frontend/public/models/body_anchors.json): 1 unit = 1 mm,
 * x = model x (patient left is +x, so it appears on the viewer's right, as in a front view), y = (1.78 m - model y).
 * Organ outlines are control polygons smoothed with a closed Catmull-Rom spline; tubes (oesophagus, colon, vessels) are
 * open splines drawn as thick strokes. Organ ids match config/body_map.yaml. */
export type Pt = [number, number];

/** Closed (or open) Catmull-Rom spline through the points, as an SVG path. */
export function spline(pts: Pt[], closed = true, tension = 0.5): string {
  const n = pts.length;
  if (n < 2) return "";
  const p = (i: number): Pt => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    const k = tension / 3;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return closed ? d + "Z" : d;
}

const mirror = (pts: Pt[], dy = 0): Pt[] => pts.map(([x, y]) => [-x, y + dy] as Pt).reverse();

export type Shape =
  | { kind: "fill"; d: string }
  | { kind: "tube"; d: string; width: number }
  | { kind: "dots"; pts: Pt[]; r: number };

export type OrganShape = { id: string; shapes: Shape[]; anchor: Pt; label: string };

// ---- silhouette (not an organ: context only)
const torsoHalf: Pt[] = [[40, 212], [46, 262], [110, 290], [190, 312], [230, 346], [242, 410], [232, 500], [206, 610], [192, 720],
  [196, 840], [204, 940], [206, 1000]];
const torso: Pt[] = [...torsoHalf, ...mirror(torsoHalf)];
export const SILHOUETTE = {
  torso: spline(torso),
  head: spline([[0, 26], [56, 40], [80, 100], [76, 160], [52, 210], [0, 226], [-52, 210], [-76, 160], [-80, 100], [-56, 40]]),
};

const lungL: Pt[] = [[52, 318], [92, 342], [120, 418], [132, 500], [128, 572], [96, 584], [64, 566], [46, 526], [26, 452], [20, 384], [30, 338]];
const kidneyL: Pt[] = [[56, 590], [80, 596], [92, 630], [88, 670], [70, 692], [50, 690], [40, 664], [48, 642], [38, 616]];

export const ORGANS: OrganShape[] = [
  { id: "brain", label: "Brain", anchor: [0, 112], shapes: [{ kind: "fill", d: spline([[0, 42], [48, 54], [68, 98], [66, 150], [40, 186], [0, 196], [-40, 186], [-66, 150], [-68, 98], [-48, 54]]) }] },
  { id: "vessels", label: "Blood", anchor: [-16, 780], shapes: [
    { kind: "tube", width: 9, d: spline([[-8, 404], [4, 376], [26, 382], [24, 430], [16, 520], [12, 640], [10, 760], [8, 860], [-30, 940], [-56, 1000]], false) },
    { kind: "tube", width: 8, d: spline([[8, 860], [44, 940], [68, 1000]], false) },
    { kind: "tube", width: 6, d: spline([[-4, 384], [-26, 300], [-30, 224]], false) },
    { kind: "tube", width: 6, d: spline([[14, 382], [30, 300], [32, 224]], false) },
  ] },
  { id: "kidney_l", label: "Left kidney", anchor: [66, 640], shapes: [{ kind: "fill", d: spline(kidneyL) }] },
  { id: "kidney_r", label: "Right kidney", anchor: [-62, 660], shapes: [{ kind: "fill", d: spline(mirror(kidneyL, 18)) }] },
  { id: "lung_l", label: "Left lung", anchor: [84, 460], shapes: [{ kind: "fill", d: spline(lungL) }] },
  { id: "lung_r", label: "Right lung", anchor: [-80, 460], shapes: [{ kind: "fill", d: spline(mirror(lungL).map(([x, y]) => [x - 2, y] as Pt)) }] },
  { id: "heart", label: "Heart", anchor: [24, 462], shapes: [{ kind: "fill", d: spline([[-34, 426], [0, 406], [44, 414], [76, 448], [84, 488], [64, 512], [24, 508], [-16, 488], [-36, 458]]) }] },
  { id: "liver", label: "Liver", anchor: [-56, 560], shapes: [{ kind: "fill", d: spline([[-118, 522], [-78, 496], [-18, 492], [40, 498], [88, 516], [92, 536], [40, 556], [0, 584], [-36, 628], [-82, 660], [-112, 638], [-120, 580]]) }] },
  { id: "spleen", label: "Spleen", anchor: [92, 590], shapes: [{ kind: "fill", d: spline([[66, 566], [96, 554], [116, 574], [112, 610], [90, 626], [70, 614], [60, 590]]) }] },
  { id: "stomach", label: "Stomach", anchor: [72, 586], shapes: [{ kind: "fill", d: spline([[18, 538], [44, 520], [84, 524], [106, 554], [108, 596], [94, 630], [60, 650], [18, 648], [-14, 640], [-28, 622], [-16, 604], [16, 610], [44, 598], [58, 574], [48, 552], [28, 552]]) }] },
  { id: "pancreas", label: "Pancreas", anchor: [24, 626], shapes: [{ kind: "fill", d: spline([[-40, 642], [-8, 628], [30, 614], [62, 602], [76, 608], [68, 622], [34, 634], [0, 652], [-28, 672], [-46, 662]]) }] },
  { id: "gallbladder", label: "Gallbladder", anchor: [-48, 616], shapes: [{ kind: "fill", d: spline([[-62, 598], [-44, 592], [-30, 604], [-34, 628], [-50, 638], [-64, 620]]) }] },
  { id: "duodenum", label: "Duodenum", anchor: [-56, 676], shapes: [{ kind: "tube", width: 20, d: spline([[-26, 628], [-54, 642], [-62, 676], [-44, 702], [-10, 704], [10, 692]], false) }] },
  { id: "large_intestine", label: "Large intestine", anchor: [-102, 800], shapes: [{ kind: "tube", width: 34, d: spline([[-82, 900], [-102, 860], [-104, 760], [-98, 690], [-60, 676], [0, 690], [60, 672], [100, 664], [108, 720], [108, 820], [104, 880], [70, 920], [30, 932], [6, 948]], false) }] },
  { id: "small_intestine", label: "Small intestine", anchor: [10, 800], shapes: [{ kind: "fill", d: spline([[-70, 714], [-20, 710], [30, 716], [76, 702], [84, 760], [84, 840], [56, 890], [0, 902], [-52, 890], [-74, 840], [-80, 770]]) }] },
  { id: "oesophagus", label: "Oesophagus", anchor: [8, 400], shapes: [{ kind: "tube", width: 15, d: spline([[0, 262], [2, 340], [6, 420], [12, 490], [22, 540]], false) }] },
  { id: "lymph_nodes", label: "Lymph nodes", anchor: [96, 652], shapes: [{ kind: "dots", r: 7, pts: [[6, 590], [26, 600], [-8, 612], [100, 638], [74, 660], [36, 666], [-20, 656], [56, 712], [-44, 724]] }] },
];

export const ORGAN_BY_ID: Record<string, OrganShape> = Object.fromEntries(ORGANS.map((o) => [o.id, o]));
/** Paired organs collapse to one entry in labels ("kidneys", "lungs"). */
export const ALIASES: Record<string, string[]> = { kidneys: ["kidney_l", "kidney_r"], lungs: ["lung_l", "lung_r"], blood: ["vessels"] };
export const VIEWBOX = { x: -300, y: 16, w: 600, h: 984 };
