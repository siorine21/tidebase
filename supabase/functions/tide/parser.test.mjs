// パーサー・潮回り判定のテスト（node --test で実行、CI: make test-edge）
// 事前に tsc で parser.ts → _build/parser.js にコンパイルする
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findDay,
  moonAge,
  parseLine,
  sourceUrl,
  tideType,
} from "./_build/parser.js";

const HOURLY = [
  150, 162, 170, 172, 168, 158, 144, 128, 112, 100, 94, 96,
  106, 122, 140, 156, 168, 174, 172, 162, 148, 132, 118, 108,
];

function buildLine({
  year = "26",
  month = "07",
  day = "17",
  station = "TK",
  highs = ["0330175", "1750176"],
  lows = ["1030 92", "2300105"],
} = {}) {
  const hourly = HOURLY.map((v) => String(v).padStart(3, " ")).join("");
  const highPart = highs.join("") + "9999999".repeat(4 - highs.length);
  const lowPart = lows.join("") + "9999999".repeat(4 - lows.length);
  return hourly + year + month + day + station + highPart + lowPart;
}

test("1 行を完全にパースできる", () => {
  const parsed = parseLine(buildLine());
  assert.equal(parsed.station, "TK");
  assert.equal(parsed.date, "2026-07-17");
  assert.deepEqual(parsed.hourly_levels_cm, HOURLY);
  assert.deepEqual(parsed.high_tides, [
    { time: "03:30", level_cm: 175 },
    { time: "17:50", level_cm: 176 },
  ]);
  assert.deepEqual(parsed.low_tides, [
    { time: "10:30", level_cm: 92 },
    { time: "23:00", level_cm: 105 },
  ]);
});

test("満干潮の欠測はスキップされる", () => {
  const parsed = parseLine(buildLine({ highs: ["0330175"], lows: [] }));
  assert.equal(parsed.high_tides.length, 1);
  assert.deepEqual(parsed.low_tides, []);
});

test("毎時潮位の欠測は null になる", () => {
  const line = "999" + buildLine().slice(3);
  const parsed = parseLine(line);
  assert.equal(parsed.hourly_levels_cm[0], null);
  assert.equal(parsed.hourly_levels_cm[1], HOURLY[1]);
});

test("不正な行は null", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("garbage"), null);
});

test("findDay は対象日の行を返す", () => {
  const text = [
    buildLine({ day: "16" }),
    buildLine({ day: "17" }),
    buildLine({ day: "18" }),
  ].join("\n");
  assert.equal(findDay(text, "2026-07-17").date, "2026-07-17");
  assert.equal(findDay(text, "2026-08-01"), null);
});

test("月齢は 0〜29.6 の範囲", () => {
  const age = moonAge("2026-07-17");
  assert.ok(age >= 0 && age < 29.6);
});

test("新月近傍は大潮", () => {
  assert.equal(tideType("2026-01-19"), "大潮");
});

test("1 ヶ月で全潮回りが出現する", () => {
  const types = new Set();
  for (let d = 1; d <= 30; d++) {
    types.add(tideType(`2026-07-${String(d).padStart(2, "0")}`));
  }
  assert.deepEqual(
    [...types].sort(),
    ["中潮", "大潮", "小潮", "若潮", "長潮"].sort(),
  );
});

test("丸めは四捨五入（SQL 実装 moon_age/tide_type とのパリティ）", () => {
  // 月齢ちょうど .5 の日: 四捨五入で切り上がる（銀行丸めなら別の潮回りになる）
  assert.equal(moonAge("2026-01-21"), 2.5);
  assert.equal(tideType("2026-01-21"), "中潮"); // round(2.5)=3 → 中潮
  assert.equal(moonAge("2026-02-16"), 28.5);
  assert.equal(tideType("2026-02-16"), "大潮"); // round(28.5)=29 → 大潮
});

test("source URL は新パス", () => {
  assert.equal(
    sourceUrl("TK", 2026),
    "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/TK.txt",
  );
});
