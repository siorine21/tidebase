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


def build_path(src=DEFAULT_SRC, tol=2.2, dilate=41, box=24.0, precision=2):
    """24x24 の箱に中央寄せで収めたパスと、縦横比を返す。"""
    ink, w, h = load_mask(src, dilate)
    loops = sorted(trace_loops(ink, w, h), key=area, reverse=True)
    loops = [lp for lp in loops if area(lp) >= 200]
    if dilate:
        # 目は太らせる前の絵から取る。太らせると輪が塞がってしまう
        thin, tw, th = load_mask(src, 0)
        eyes = sorted(trace_loops(thin, tw, th), key=area, reverse=True)[2:4]
        loops = loops[:2] + eyes
    shapes = [simplify(lp, tol) for lp in loops[:4]]

    xs = [p[0] for s in shapes for p in s]
    ys = [p[1] for s in shapes for p in s]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    k = min(box / (x1 - x0), box / (y1 - y0))
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
    return "".join(parts), (x1 - x0) / (y1 - y0)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--tol", type=float, default=2.2, help="間引きの許容誤差（元画像の画素）")
    ap.add_argument("--dilate", type=int, default=41, help="墨を太らせる幅（元画像の画素）")
    args = ap.parse_args()
    d, ratio = build_path(args.src, args.tol, args.dilate)
    print(d)
    print(f"<!-- 縦横比 {ratio:.3f}:1 / {len(d)} 文字 -->")
