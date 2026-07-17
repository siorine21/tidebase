"""気象庁「潮位表掲載地点一覧表」から観測点マスタ JSON を生成する。

使い方（ネットワークに出られる環境で実行）:

    python3 scripts/generate_tide_stations.py > backend/app/data/jma_tide_stations.json

開発サンドボックスからは気象庁サイトへ到達できないため、このスクリプトは
ユーザー環境での実行を前提とする。ページ構造が変わった場合は
STATION_LIST_URL と正規表現を調整すること。

一覧ページ: https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php
（行内に 地点記号(2文字)・地点名・緯度(度分)・経度(度分) を含む表）
"""
import json
import re
import sys
import urllib.request

STATION_LIST_URL = "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php"

# 例: 「35°39.3'N」「139°46.2'E」のような 度分 表記
_DEG_MIN = re.compile(r"(\d+)[°度]\s*([\d.]+)[′']?")


def _to_decimal(text: str) -> float:
    match = _DEG_MIN.search(text)
    if not match:
        raise ValueError(f"緯度経度を解釈できません: {text!r}")
    degrees, minutes = float(match.group(1)), float(match.group(2))
    return round(degrees + minutes / 60, 4)


def _strip_tags(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html)


def main() -> None:
    with urllib.request.urlopen(STATION_LIST_URL, timeout=30) as response:
        html = response.read().decode("utf-8", errors="replace")

    stations = []
    for row_html in re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S):
        cells = [
            _strip_tags(c).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, flags=re.S)
        ]
        # 想定列: 地点記号 / 地点名 / 緯度 / 経度 / ...（ヘッダー行・注記行はスキップ）
        if len(cells) < 4 or not re.fullmatch(r"[A-Z0-9]{2}", cells[0]):
            continue
        try:
            stations.append(
                {
                    "code": cells[0],
                    "name": cells[1],
                    "lat": _to_decimal(cells[2]),
                    "lng": _to_decimal(cells[3]),
                }
            )
        except ValueError as error:
            print(f"skip {cells[0]}: {error}", file=sys.stderr)

    if not stations:
        print(
            "地点を 1 件も抽出できませんでした。ページ構造の変更を確認してください。",
            file=sys.stderr,
        )
        sys.exit(1)

    json.dump(stations, sys.stdout, ensure_ascii=False, indent=2)
    print()
    print(f"{len(stations)} 地点を出力しました", file=sys.stderr)


if __name__ == "__main__":
    main()
