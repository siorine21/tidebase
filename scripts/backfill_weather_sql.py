#!/usr/bin/env python3
"""snapshots.json から UPDATE 文を作る（D-153）。

**条件なしの UPDATE は書かない。** id を名指しし、さらに
weather_snapshot IS NULL を条件に付ける。すでに入っているものを
上書きしない（実ユーザーのデータが同じ表にある）。
"""
import json, sys, pathlib

here = pathlib.Path(__file__).parent
rows = json.load(open(here / 'snapshots.json', encoding='utf-8'))

ok = [r for r in rows if r.get('snapshot') and r['snapshot'].get('weather_code') is not None]
ng = [r for r in rows if r not in ok]

def lit(obj):
    return "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"

lines = ["BEGIN;"]
for r in ok:
    s = r['snapshot']
    lines.append(
        f"-- {r['date']} {r['time']} {r['spot']}  "
        f"{s['source']} / 記号 {s['weather_code']} / {s['temp_c']}℃")
    lines.append(
        "UPDATE public.fishing_records SET weather_snapshot = "
        f"{lit(s)} WHERE id = '{r['id']}' AND weather_snapshot IS NULL;")
lines.append("COMMIT;")
(here / 'backfill.sql').write_text("\n".join(lines) + "\n", encoding='utf-8')

print(f"埋められる: {len(ok)} 件 / 埋められない: {len(ng)} 件")
for r in ng:
    print(f"  残り: {r['date']} {r['time']} {r['spot']}")
srcs = {}
for r in ok:
    srcs[r['snapshot']['source']] = srcs.get(r['snapshot']['source'], 0) + 1
print("  出どころ:", srcs)
