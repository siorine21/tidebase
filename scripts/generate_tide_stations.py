"""気象庁「潮位表掲載地点一覧表」から観測点マスタの SQL を生成する。

使い方（ネットワークに出られる環境で実行）:

    python3 scripts/generate_tide_stations.py > db/seeds/tide_stations.sql
    python3 scripts/supabase_admin.py sql "$(cat db/seeds/tide_stations.sql)"

生成される SQL は public.tide_stations への UPSERT（冪等）。
投入後、既存スポットの観測点は以下で再計算できる:

    UPDATE public.spots
    SET tide_station_code = public.nearest_tide_station(latitude, longitude)
    WHERE water_type <> 'freshwater';

ページ構造が変わった場合は STATION_LIST_URL と正規表現を調整すること。
一覧ページ: https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php
"""
import re
import sys
import urllib.request

STATION_LIST_URL = "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php"

# 一覧表の列: 番号 / 地点記号 / 掲載地点名 / 緯度 / 経度 / ...
COL_CODE, COL_NAME, COL_LAT, COL_LNG = 1, 2, 3, 4

# 度分表記。度記号は「゜」（気象庁ページの表記）のほか「°」「度」も許容
# 例: 「45゜24'」「35゜39.3'」
_DEG_MIN = re.compile(r"(\d+)\s*[゜°度]\s*([\d.]+)\s*['′]?")


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
        # ヘッダー行・注記行はスキップ（地点記号が 2 文字の英数字である行のみ採用）
        if len(cells) <= COL_LNG or not re.fullmatch(r"[A-Z0-9]{2}", cells[COL_CODE]):
            continue
        try:
            name = cells[COL_NAME].replace("'", "''")
            stations.append(
                f"  ('{cells[COL_CODE]}', '{name}',"
                f" {_to_decimal(cells[COL_LAT])}, {_to_decimal(cells[COL_LNG])})"
            )
        except ValueError as error:
            print(f"skip {cells[COL_CODE]}: {error}", file=sys.stderr)

    if not stations:
        print(
            "地点を 1 件も抽出できませんでした。ページ構造の変更を確認してください。",
            file=sys.stderr,
        )
        sys.exit(1)

    print("-- 気象庁 潮位表掲載地点マスタ（scripts/generate_tide_stations.py で生成）")
    print("INSERT INTO public.tide_stations (code, name, lat, lng) VALUES")
    print(",\n".join(stations))
    print("ON CONFLICT (code) DO UPDATE SET")
    print("  name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng;")
    print(f"-- {len(stations)} 地点", file=sys.stderr)


if __name__ == "__main__":
    main()
