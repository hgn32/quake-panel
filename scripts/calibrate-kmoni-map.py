#!/usr/bin/env python3
"""強震モニタ配信画像の座標系を較正する。

kmoni は投影パラメータを公開していない。そこで公開されている基図と
リアルタイム震度画像の観測点配置を「正解」とみなし、オープンな行政区域
データを重ねて最小二乗で緯度経度 → ピクセルの線形変換を求める。

得られた値は shared/src/kmoniGeo.ts の KMONI_MAP / KMONI_INSET に入れる。
kmoni 側の基図が差し替えられた場合はこのスクリプトを再実行して更新する。

必要なもの:
    pip install pillow numpy scipy
    ネットワーク (kmoni の基図・リアルタイム画像、行政区域 GeoJSON)

使い方:
    python3 scripts/calibrate-kmoni-map.py [--work-dir /tmp/kmoni-calib]

較正の勘所:
  * 基図の陰影は「山地」にしか付いておらず、平野部は海と同じ白。
    そのため陸地ポリゴンと基図の灰色を単純に IoU 比較すると、平野の分だけ
    縮尺が小さい方向へ引っ張られる。リアルタイム震度画像の観測点 (平野にも
    分布する) を膨張させて灰色と論理和したものを比較対象にすることで、この
    偏りを取り除いている。
  * 仕上げは島嶼の重心対応による最小二乗。小さい島は基図の陰影が島全体を
    覆うため、平野問題の影響を受けない良い対応点になる。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import binary_dilation, center_of_mass, label

KMONI_BASE = "http://www.kmoni.bosai.go.jp"
BASE_MAP_URL = f"{KMONI_BASE}/data/map_img/CommonImg/base_map_w.gif"
# 行政区域データ (国土数値情報を加工したもの)
GEOJSON_URL = "https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson"

WIDTH, HEIGHT = 352, 400
# 基図の左上に置かれた南西諸島の別枠と、右下の防災科研ロゴは比較対象から外す
INSET_BOX = (0, 0, 190, 215)  # x0, y0, x1, y1
LOGO_BOX = (145, 345, 305, 400)
TIMESTAMP_BOX = (0, 0, 250, 40)  # リアルタイム画像に焼き込まれた時刻表示


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as res, dest.open("wb") as fp:
        fp.write(res.read())
    return dest


def latest_realtime_image(work: Path) -> Path:
    """直近のリアルタイム震度画像を 1 枚取ってくる (観測点の分布を得るため)。"""
    import datetime as dt

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    for back in range(3, 30):
        ts = (now - dt.timedelta(seconds=back)).strftime("%Y%m%d%H%M%S")
        url = f"{KMONI_BASE}/data/map_img/RealTimeImg/jma_s/{ts[:8]}/{ts}.jma_s.gif"
        dest = work / f"realtime_{ts}.gif"
        try:
            return download(url, dest)
        except Exception:  # noqa: BLE001 - 生成待ちの 404 は想定内
            dest.unlink(missing_ok=True)
    raise SystemExit("リアルタイム震度画像を取得できませんでした")


def box_mask(box: tuple[int, int, int, int]) -> np.ndarray:
    mask = np.zeros((HEIGHT, WIDTH), bool)
    x0, y0, x1, y1 = box
    mask[y0:y1, x0:x1] = True
    return mask


def load_masks(work: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    base = np.array(Image.open(download(BASE_MAP_URL, work / "base_map_w.gif")).convert("RGB"))
    gray = base.astype(int).sum(axis=2) < 750

    rt = np.array(Image.open(latest_realtime_image(work)).convert("RGBA"))
    opaque = rt[..., 3] > 0
    black = (rt[..., :3] < 40).all(axis=2) & opaque
    points = opaque & ~black

    valid = ~(box_mask(INSET_BOX) | box_mask(LOGO_BOX) | box_mask(TIMESTAMP_BOX))
    return gray, points, valid


def load_rings(work: Path) -> list[np.ndarray]:
    geo = json.loads(download(GEOJSON_URL, work / "japan.geojson").read_text(encoding="utf-8"))
    rings: list[np.ndarray] = []
    for feature in geo["features"]:
        if feature["properties"]["id"] == 47:  # 沖縄県は別枠なので本土側の較正から外す
            continue
        geom = feature["geometry"]
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in polygons:
            ring = np.asarray(polygon[0], dtype=float)
            # 伊豆・小笠原諸島は描画範囲外
            if ring[:, 1].min() < 30 or ring[:, 0].max() > 146.5:
                continue
            rings.append(ring)
    return rings


def rasterize(rings: list[np.ndarray], params: np.ndarray) -> np.ndarray:
    west, north, sx, sy = params
    image = Image.new("1", (WIDTH, HEIGHT), 0)
    draw = ImageDraw.Draw(image)
    for ring in rings:
        xs = (ring[:, 0] - west) * sx
        ys = (north - ring[:, 1]) * sy
        draw.polygon(list(zip(xs, ys)), fill=1)
    return np.array(image, bool)


def coarse_fit(rings: list[np.ndarray], target: np.ndarray, valid: np.ndarray) -> np.ndarray:
    from scipy.optimize import minimize

    def negative_iou(params: np.ndarray) -> float:
        raster = rasterize(rings, params) & valid
        union = (raster | target).sum()
        return -(raster & target).sum() / union if union else 0.0

    best = None
    for west in (128.4, 128.7, 129.0):
        for scale in (0.97, 1.0, 1.03):
            seed = np.array([west, 46.1, 20.5 * scale, 24.8 * scale])
            result = minimize(
                negative_iou, seed, method="Nelder-Mead",
                options={"maxiter": 3000, "xatol": 1e-5, "fatol": 1e-7},
            )
            if best is None or result.fun < best.fun:
                best = result
    assert best is not None
    print(f"粗い当てはめ IoU={-best.fun:.4f}", file=sys.stderr)
    return best.x


def refine_with_islands(
    rings: list[np.ndarray], gray: np.ndarray, valid: np.ndarray, params: np.ndarray
) -> np.ndarray:
    """島嶼の重心対応で仕上げる。平野の陰影欠落に影響されない。"""
    labels, count = label(gray & valid, np.ones((3, 3)))
    sizes = np.bincount(labels.ravel())
    blobs = [(i, sizes[i]) for i in range(1, count + 1) if 4 <= sizes[i] <= 6000]
    centroids = {i: center_of_mass(labels == i) for i, _ in blobs}

    islands = []
    for ring in rings:
        x, y = ring[:, 0], ring[:, 1]
        area = 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))
        if 0.0005 < area < 2.0:
            islands.append((x.mean(), y.mean(), area))
    island_array = np.array([(a, b) for a, b, _ in islands])
    island_area = np.array([c for _, _, c in islands])

    for _ in range(20):
        pairs = []
        for blob_id, size in blobs:
            cy, cx = centroids[blob_id]
            lon = cx / params[2] + params[0]
            lat = params[1] - cy / params[3]
            dist = np.hypot(
                (island_array[:, 0] - lon) * math.cos(math.radians(lat)),
                island_array[:, 1] - lat,
            )
            j = int(dist.argmin())
            expected_px = island_area[j] * params[2] * params[3]
            if dist[j] < 0.30 and 0.3 < expected_px / max(size, 1) < 4.0:
                pairs.append((island_array[j, 0], island_array[j, 1], cx, cy))
        if len(pairs) < 4:
            print("対応付いた島が少なすぎます。粗い当てはめの結果を使います。", file=sys.stderr)
            return params
        matched = np.array(pairs)
        a = np.stack([matched[:, 0], np.ones(len(matched))], axis=1)
        sx, bx = np.linalg.lstsq(a, matched[:, 2], rcond=None)[0]
        b = np.stack([matched[:, 1], np.ones(len(matched))], axis=1)
        my, by = np.linalg.lstsq(b, matched[:, 3], rcond=None)[0]
        params = np.array([-bx / sx, by / (-my), sx, -my])

    residual = np.stack(
        [
            matched[:, 2] - (matched[:, 0] - params[0]) * params[2],
            matched[:, 3] - (params[1] - matched[:, 1]) * params[3],
        ],
        axis=1,
    )
    print(
        f"島嶼 {len(matched)} 点で仕上げ: 残差 RMS = "
        f"({residual[:, 0].std():.2f}px, {residual[:, 1].std():.2f}px)",
        file=sys.stderr,
    )
    return params


def fit_inset(work: Path, gray: np.ndarray, params: np.ndarray) -> tuple[float, float]:
    """南西諸島の別枠は縮尺そのままの平行移動で合う。その移動量を求める。"""
    from scipy.optimize import minimize

    geo = json.loads((work / "japan.geojson").read_text(encoding="utf-8"))
    rings = []
    for feature in geo["features"]:
        if feature["properties"]["id"] not in (46, 47):  # 鹿児島県・沖縄県
            continue
        geom = feature["geometry"]
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for polygon in polygons:
            ring = np.asarray(polygon[0], dtype=float)
            if ring[:, 0].mean() < 129.6 and ring[:, 1].mean() < 30.6:
                rings.append(ring)

    inset = box_mask(INSET_BOX)
    target = binary_dilation(gray & inset, np.ones((3, 3))) & inset
    west, north, sx, sy = params

    def raster(dx: float, dy: float) -> np.ndarray:
        image = Image.new("1", (WIDTH, HEIGHT), 0)
        draw = ImageDraw.Draw(image)
        for ring in rings:
            xs = (ring[:, 0] - west) * sx + dx
            ys = (north - ring[:, 1]) * sy + dy
            draw.polygon(list(zip(xs, ys)), fill=1)
        return binary_dilation(np.array(image, bool), np.ones((3, 3))) & inset

    def negative_iou(p: np.ndarray) -> float:
        r = raster(*p)
        union = (r | target).sum()
        return -(r & target).sum() / union if union else 0.0

    best = None
    for dx in range(0, 260, 10):
        for dy in range(-460, -140, 10):
            value = negative_iou(np.array([dx, dy]))
            if best is None or value < best[0]:
                best = (value, [dx, dy])
    assert best is not None
    result = minimize(negative_iou, best[1], method="Nelder-Mead",
                      options={"maxiter": 2000, "xatol": 1e-4, "fatol": 1e-9})
    print(f"インセット当てはめ IoU={-result.fun:.3f}", file=sys.stderr)
    return float(result.x[0]), float(result.x[1])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", default="/tmp/kmoni-calib", type=Path)
    parser.add_argument("--overlay", type=Path, help="検証用の重ね合わせ画像の出力先")
    args = parser.parse_args()

    gray, points, valid = load_masks(args.work_dir)
    rings = load_rings(args.work_dir)
    target = (gray | binary_dilation(points, np.ones((5, 5), bool))) & valid

    params = coarse_fit(rings, target, valid)
    params = refine_with_islands(rings, gray, valid, params)
    inset_dx, inset_dy = fit_inset(args.work_dir, gray, params)

    west, north, sx, sy = params
    print(
        json.dumps(
            {
                "width": WIDTH,
                "height": HEIGHT,
                "west": round(float(west), 4),
                "north": round(float(north), 4),
                "pxPerDegLon": round(float(sx), 4),
                "pxPerDegLat": round(float(sy), 4),
                "east": round(float(west + WIDTH / sx), 4),
                "south": round(float(north - HEIGHT / sy), 4),
                "standardParallelDeg": round(math.degrees(math.acos(min(1.0, sx / sy))), 2),
                "inset": {"offsetX": round(inset_dx, 3), "offsetY": round(inset_dy, 3)},
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    if args.overlay:
        canvas = Image.open(args.work_dir / "base_map_w.gif").convert("RGB").resize(
            (WIDTH * 2, HEIGHT * 2), Image.NEAREST
        )
        draw = ImageDraw.Draw(canvas)
        for ring in rings:
            pts = [((lo - west) * sx * 2, (north - la) * sy * 2) for lo, la in ring]
            draw.line(pts + [pts[0]], fill=(255, 0, 0), width=1)
        canvas.save(args.overlay)
        print(f"検証画像を書き出しました: {args.overlay}", file=sys.stderr)


if __name__ == "__main__":
    main()
