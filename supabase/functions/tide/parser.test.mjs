// パーサー・潮回り判定のテスト（node --test で実行、CI: make test-edge）
// 事前に tsc で parser.ts → _build/parser.js にコンパイルする
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findDay,
  lunarDay,
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

// D-062 より前は、平均朔望月からの経過日数（月齢）を四捨五入して潮回りを決めていた。
// 実際の潮回りは**旧暦日**（新月の日を 1 日とする数え）で決まるので、
// 2 日ずれることがある（報告: 「今日は中潮のはず」）。
// 月齢と旧暦日は別物であり、tideType は旧暦日から引く。
test("潮回りは旧暦日から引く（月齢の四捨五入ではない）", () => {
  // 月齢 2.3 でも旧暦 3 日。四捨五入なら 2 日となり、潮回りを取り違える
  assert.equal(moonAge("2026-01-21"), 2.3);
  assert.equal(lunarDay("2026-01-21"), 3);
  assert.equal(tideType("2026-01-21"), "大潮");

  // 新月をまたぐ日。月齢は 29.3 まで伸びるが、旧暦日は 1 に戻る
  assert.equal(moonAge("2026-02-17"), 29.3);
  assert.equal(lunarDay("2026-02-17"), 1);
  assert.equal(tideType("2026-02-17"), "大潮");
});

// SQL 側（db/migrations/018_tide_type_lunar_day.sql の moon_age / lunar_day / tide_type）
// と同じ答えになること。画面は SQL、Edge Function は TypeScript で同じ計算をするので、
// どちらかだけ直すと釣果の記録と表示が食い違う。
// 期待値は本番の SQL 実装から書き出したもの（"日付 月齢 旧暦日 潮回り"）。
// 新月をまたぐ位置がずれると連続して落ちるよう、90 日ぶんを続けて並べてある。
const SQL_PARITY = [
  "2026-01-01 12.1 13 中潮",
  "2026-01-02 13.1 14 中潮",
  "2026-01-03 14.1 15 大潮",
  "2026-01-04 15.1 16 大潮",
  "2026-01-05 16.1 17 大潮",
  "2026-01-06 17.1 18 大潮",
  "2026-01-07 18.1 19 中潮",
  "2026-01-08 19.1 20 中潮",
  "2026-01-09 20.1 21 中潮",
  "2026-01-10 21.1 22 小潮",
  "2026-01-11 22.1 23 小潮",
  "2026-01-12 23.1 24 小潮",
  "2026-01-13 24.1 25 長潮",
  "2026-01-14 25.1 26 若潮",
  "2026-01-15 26.1 27 中潮",
  "2026-01-16 27.1 28 中潮",
  "2026-01-17 28.1 29 大潮",
  "2026-01-18 29.1 30 大潮",
  "2026-01-19 0.3 1 大潮",
  "2026-01-20 1.3 2 大潮",
  "2026-01-21 2.3 3 大潮",
  "2026-01-22 3.3 4 中潮",
  "2026-01-23 4.3 5 中潮",
  "2026-01-24 5.3 6 中潮",
  "2026-01-25 6.3 7 小潮",
  "2026-01-26 7.3 8 小潮",
  "2026-01-27 8.3 9 小潮",
  "2026-01-28 9.3 10 長潮",
  "2026-01-29 10.3 11 若潮",
  "2026-01-30 11.3 12 中潮",
  "2026-01-31 12.3 13 中潮",
  "2026-02-01 13.3 14 中潮",
  "2026-02-02 14.3 15 大潮",
  "2026-02-03 15.3 16 大潮",
  "2026-02-04 16.3 17 大潮",
  "2026-02-05 17.3 18 大潮",
  "2026-02-06 18.3 19 中潮",
  "2026-02-07 19.3 20 中潮",
  "2026-02-08 20.3 21 中潮",
  "2026-02-09 21.3 22 小潮",
  "2026-02-10 22.3 23 小潮",
  "2026-02-11 23.3 24 小潮",
  "2026-02-12 24.3 25 長潮",
  "2026-02-13 25.3 26 若潮",
  "2026-02-14 26.3 27 中潮",
  "2026-02-15 27.3 28 中潮",
  "2026-02-16 28.3 29 大潮",
  "2026-02-17 29.3 1 大潮",
  "2026-02-18 0.6 2 大潮",
  "2026-02-19 1.6 3 大潮",
  "2026-02-20 2.6 4 中潮",
  "2026-02-21 3.6 5 中潮",
  "2026-02-22 4.6 6 中潮",
  "2026-02-23 5.6 7 小潮",
  "2026-02-24 6.6 8 小潮",
  "2026-02-25 7.6 9 小潮",
  "2026-02-26 8.6 10 長潮",
  "2026-02-27 9.6 11 若潮",
  "2026-02-28 10.6 12 中潮",
  "2026-03-01 11.6 13 中潮",
  "2026-03-02 12.6 14 中潮",
  "2026-03-03 13.6 15 大潮",
  "2026-03-04 14.6 16 大潮",
  "2026-03-05 15.6 17 大潮",
  "2026-03-06 16.6 18 大潮",
  "2026-03-07 17.6 19 中潮",
  "2026-03-08 18.6 20 中潮",
  "2026-03-09 19.6 21 中潮",
  "2026-03-10 20.6 22 小潮",
  "2026-03-11 21.6 23 小潮",
  "2026-03-12 22.6 24 小潮",
  "2026-03-13 23.6 25 長潮",
  "2026-03-14 24.6 26 若潮",
  "2026-03-15 25.6 27 中潮",
  "2026-03-16 26.6 28 中潮",
  "2026-03-17 27.6 29 大潮",
  "2026-03-18 28.6 30 大潮",
  "2026-03-19 0.1 1 大潮",
  "2026-03-20 1.1 2 大潮",
  "2026-03-21 2.1 3 大潮",
  "2026-03-22 3.1 4 中潮",
  "2026-03-23 4.1 5 中潮",
  "2026-03-24 5.1 6 中潮",
  "2026-03-25 6.1 7 小潮",
  "2026-03-26 7.1 8 小潮",
  "2026-03-27 8.1 9 小潮",
  "2026-03-28 9.1 10 長潮",
  "2026-03-29 10.1 11 若潮",
  "2026-03-30 11.1 12 中潮",
  "2026-03-31 12.1 13 中潮",
];

test("SQL 実装と 90 日ぶん一致する（moon_age / lunar_day / tide_type）", () => {
  const mismatched = [];
  for (const row of SQL_PARITY) {
    const [date, age, day, type] = row.split(" ");
    const got = `${date} ${moonAge(date).toFixed(1)} ${lunarDay(date)} ${tideType(date)}`;
    if (got !== row) mismatched.push(`SQL: ${row} / TS: ${got}`);
  }
  assert.deepEqual(mismatched, []);
});

test("source URL は新パス", () => {
  assert.equal(
    sourceUrl("TK", 2026),
    "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/TK.txt",
  );
});
