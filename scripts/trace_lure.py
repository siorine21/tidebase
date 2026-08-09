#!/usr/bin/env python3
"""モノクロのルアーの絵（docs/art/lure-source.png）を SVG のパスに起こす（D-085）。

ラスタのまま縮めると、アイコンの大きさでは目も胴の白抜きも消えてしまう。
輪郭を追ってパスにしておけば、どの大きさでも潰れないし、色も差し替えられる。

    python3 scripts/trace_lure.py                       # 既定（アプリアイコン用）
    python3 scripts/trace_lure.py --dilate 0 --tol 2    # 線を太らせない

出てくるのは 24x24 の箱に**中央寄せ**で収めたパス。使うときの原点は (12, 12)。
塗りは fill-rule="evenodd" 前提（外形・胴の白抜き・目の輪・黒目が入れ子になる）。

PNG の書き出しはここではやらない。SVG を組み立てたあと、
ブラウザ（Playwright + Chromium）で撮って PNG にしている。
"""
import argparse
import math

from PIL import Image, ImageFilter

DEFAULT_SRC = "docs/art/lure-source.png"


def load_mask(path, dilate=0, threshold=128):
    """墨のある画素を True にした二値の升目にする。

    dilate を入れると墨が太る。もらった絵は輪郭線が細く、
    小さく出したときに 1px を切って白い塊にしか見えなくなるため。
    """
    im = Image.open(path).convert("L")
    if dilate > 1:
        im = im.filter(ImageFilter.MinFilter(dilate if dilate % 2 else dilate + 1))
    w, h = im.size
    px = im.load()
    return [[px[x, y] < threshold for x in range(w)] for y in range(h)], w, h


def trace_loops(ink, w, h):
    """墨の輪郭を、画素の辺をつないで閉ループにする。

    外形も穴も同じ手順で出てくる。入れ子の内外は evenodd が勝手に判定するので、
    向きを揃える必要はない。
    """
    def is_ink(x, y):
        return 0 <= x < w and 0 <= y < h and ink[y][x]

    edges = {}
    for y in range(h):
        row = ink[y]
        for x in range(w):
            if not row[x]:
                continue
            if not is_ink(x, y - 1):
                edges.setdefault((x, y), []).append((x + 1, y))
            if not is_ink(x + 1, y):
                edges.setdefault((x + 1, y), []).append((x + 1, y + 1))
            if not is_ink(x, y + 1):
                edges.setdefault((x + 1, y + 1), []).append((x, y + 1))
            if not is_ink(x - 1, y):
                edges.setdefault((x, y + 1), []).append((x, y))

    loops = []
    while edges:
        start = next(iter(edges))
        loop, cur, prev_d = [start], start, None
        while True:
            outs = edges.get(cur)
            if not outs:
                break
            if len(outs) == 1 or prev_d is None:
                nxt = outs[0]
            else:
                # 画素の角で分岐したときは、まっすぐ進む辺を選ぶ
                straight = [p for p in outs if (p[0] - cur[0], p[1] - cur[1]) == prev_d]
                nxt = straight[0] if straight else outs[0]
            outs.remove(nxt)
            if not outs:
                del edges[cur]
            prev_d = (nxt[0] - cur[0], nxt[1] - cur[1])
            cur = nxt
            if cur == start:
                break
            loop.append(cur)
        if len(loop) > 8:
            loops.append(loop)
    return loops


def _dp(points, tol):
    """Douglas-Peucker。開いた折れ線を間引く。"""
    if len(points) < 3:
        return points[:]
    a, b = points[0], points[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dy)
    worst, wi = -1.0, 0
    for i in range(1, len(points) - 1):
        p = points[i]
        d = (math.hypot(p[0] - a[0], p[1] - a[1]) if n == 0
             else abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / n)
        if d > worst:
            worst, wi = d, i
    if worst <= tol:
        return [a, b]
    return _dp(points[:wi + 1], tol)[:-1] + _dp(points[wi:], tol)


def simplify(loop, tol):
    """閉ループを間引いて、角を落とす。画素の階段が滑らかになる。"""
    def once(lp, t):
        cx = sum(p[0] for p in lp) / len(lp)
        cy = sum(p[1] for p in lp) / len(lp)
        i0 = max(range(len(lp)), key=lambda i: (lp[i][0] - cx) ** 2 + (lp[i][1] - cy) ** 2)
        a = lp[i0]
        i1 = max(range(len(lp)), key=lambda i: (lp[i][0] - a[0]) ** 2 + (lp[i][1] - a[1]) ** 2)
        lo, hi = sorted((i0, i1))
        return _dp(lp[lo:hi + 1], t)[:-1] + _dp(lp[hi:] + lp[:lo + 1], t)[:-1]

    loop = once(loop, tol)
    for _ in range(2):                      # Chaikin で角を落とす
        out = []
        for i in range(len(loop)):
            p, q = loop[i], loop[(i + 1) % len(loop)]
            out.append((p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25))
            out.append((p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75))
        loop = out
    return once(loop, tol * 0.5)


def area(loop):
    s = 0.0
    for i in range(len(loop)):
        x1, y1 = loop[i]
        x2, y2 = loop[(i + 1) % len(loop)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid_radius(loop):
    cx = sum(p[0] for p in loop) / len(loop)
    cy = sum(p[1] for p in loop) / len(loop)
    return cx, cy, math.sqrt(area(loop) / math.pi)


def pacman(cx, cy, r, mouth=55.0, facing=180.0, precision=2):
    """パックマン。ima のマークがこの形で、ルアーの目もこれ（D-086）。

    口は左（ルアーの鼻の側）に開く。マークを実測して開き角 55°。
    照り返しのある丸い玉として描くと、ただの目玉になってしまう。
    """
    half = math.radians(mouth / 2)
    a = math.radians(facing)
    p1 = (cx + r * math.cos(a + half), cy + r * math.sin(a + half))
    p2 = (cx + r * math.cos(a - half), cy + r * math.sin(a - half))
    f = lambda v: round(v, precision)
    # 口以外をぐるりと回るので large-arc-flag=1、画面の時計回りなので sweep-flag=1
    return (f"M{f(cx)} {f(cy)}L{f(p1[0])} {f(p1[1])}"
            f"A{f(r)} {f(r)} 0 1 1 {f(p2[0])} {f(p2[1])}Z")


def build_path(src=DEFAULT_SRC, tol=2.2, dilate=41, box=24.0, precision=2,
               mouth=55.0, pupil_ratio=0.75, eye_scale=1.35, eye_shift=(35, 0),
               rotate=0.0, margin=0.0):
    """24x24 の箱に中央寄せで収めたパスと、縦横比を返す。

    rotate を与えると、箱に収める前に傾ける。ルアーは 4.5:1 と平べったいので、
    正方形の箱にそのまま入れると縦が 1/4 しか埋まらない。
    少し前傾させると箱の対角に沿い、同じ絵のまま縦が倍近く使える（D-090）。
    """
    ink, w, h = load_mask(src, dilate)
    loops = sorted(trace_loops(ink, w, h), key=area, reverse=True)
    loops = [lp for lp in loops if area(lp) >= 200]
    shapes = [simplify(lp, tol) for lp in loops[:2]]

    # 目の位置と大きさは太らせる前の絵から取る（太らせると輪が塞がる）。
    # ただし**形はなぞらない**。元絵は丸い玉＋照り返しになっていて、
    # 実物（ima のマークと同じパックマン）とは形が違う（D-086）。
    # アイコンなので元絵より一回り大きくし、頭の厚いほうへ少しずらす。
    thin, tw, th = load_mask(src, 0)
    ring = sorted(trace_loops(thin, tw, th), key=area, reverse=True)[2]
    ecx, ecy, er = centroid_radius(ring)
    ecx += eye_shift[0]
    ecy += eye_shift[1]
    er *= eye_scale
    pr = er * pupil_ratio

    if rotate:
        th = math.radians(rotate)
        c, s = math.cos(th), math.sin(th)
        rot = lambda p: (p[0] * c - p[1] * s, p[0] * s + p[1] * c)
        shapes = [[rot(p) for p in shape] for shape in shapes]
        ecx, ecy = rot((ecx, ecy))

    xs = [p[0] for s in shapes for p in s]
    ys = [p[1] for s in shapes for p in s]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    span = box - margin * 2
    k = min(span / (x1 - x0), span / (y1 - y0))
    ox = (box - (x1 - x0) * k) / 2 - x0 * k
    oy = (box - (y1 - y0) * k) / 2 - y0 * k

    parts = []
    for s in shapes:
        pts = [(round(p[0] * k + ox, precision), round(p[1] * k + oy, precision)) for p in s]
        ded = [pts[0]]
        for p in pts[1:]:
            if p != ded[-1]:
                ded.append(p)
        parts.append(f"M{ded[0][0]} {ded[0][1]}"
                     + "".join(f"L{x} {y}" for x, y in ded[1:]) + "Z")
    # 目のふち（アイシールの縁）と、その中のパックマン。
    cx, cy = ecx * k + ox, ecy * k + oy
    f = lambda v: round(v, precision)
    parts.append(f"M{f(cx - er * k)} {f(cy)}"
                 f"a{f(er * k)} {f(er * k)} 0 1 0 {f(er * k * 2)} 0"
                 f"a{f(er * k)} {f(er * k)} 0 1 0 {f(-er * k * 2)} 0Z")
    # 口はルアーの軸に合わせる。傾けたのに口だけ水平のままだと、目だけ横を向く
    parts.append(pacman(cx, cy, pr * k, mouth, facing=180.0 + rotate, precision=precision))
    return "".join(parts), (x1 - x0) / (y1 - y0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--tol", type=float, default=2.2, help="間引きの許容誤差（元画像の画素）")
    ap.add_argument("--dilate", type=int, default=41, help="墨を太らせる幅（元画像の画素）")
    ap.add_argument("--rotate", type=float, default=0.0, help="前傾させる角度（度）")
    ap.add_argument("--margin", type=float, default=0.0, help="24 の箱の内側に空ける余白")
    ap.add_argument("--mouth", type=float, default=55.0, help="パックマンの口の開き角（度）")
    ap.add_argument("--pupil", type=float, default=0.75, help="黒目の大きさ（輪の半径に対する比）")
    ap.add_argument("--eye-scale", type=float, default=1.35, help="目全体の倍率（元絵に対して）")
    args = ap.parse_args()
    d, ratio = build_path(args.src, args.tol, args.dilate, mouth=args.mouth,
                          pupil_ratio=args.pupil, eye_scale=args.eye_scale,
                          rotate=args.rotate, margin=args.margin)
    print(d)
    print(f"<!-- 縦横比 {ratio:.3f}:1 / {len(d)} 文字 -->")
