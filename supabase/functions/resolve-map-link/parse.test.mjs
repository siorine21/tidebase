// 短縮 URL を開いた先の読み取り（parse.ts）のテスト。
// node --test で実行（CI: make test-edge）。事前に tsc で _build/parse.js へ落とす。
//
// 実物の URL で確かめた挙動を固定しておく（D-072）。
// Google の共有リンクは 2 通りある:
//   - 座標が入っているもの（地図を長押しして落としたピンなど）… そのまま読める
//   - 座標が無く、代わりに住所が入っているもの（店舗・施設）… 住所を引き直す
// 後者を取り違えると、施設名を住所として検索してしまい、どこにも当たらない。
import assert from "node:assert/strict";
import { test } from "node:test";

import { coordsFromUrl, placeLabel } from "./_build/parse.js";

test("座標入りの URL から地点を読む", () => {
  // !3d/!4d が地点そのもの。@ は画面の中心なので、両方あるときは前者を採る
  const both = "https://www.google.com/maps/place/x/@35.0,138.0,17z/data=!3m1!4b1!8m2!3d34.5678!4d137.4321";
  assert.deepEqual(coordsFromUrl(both), { lat: 34.5678, lng: 137.4321 });

  assert.deepEqual(
    coordsFromUrl("https://www.google.com/maps/@34.7108,137.5972,15z"),
    { lat: 34.7108, lng: 137.5972 },
  );
  assert.deepEqual(
    coordsFromUrl("https://maps.google.com/?q=34.7108,137.5972"),
    { lat: 34.7108, lng: 137.5972 },
  );
});

test("座標が無い URL では null（住所で引き直す合図）", () => {
  // 報告のあった実物。施設を共有したリンクには座標が入っていない
  const real = "https://www.google.com/maps/place/%E3%80%92421-0212+%E9%9D%99%E5%B2%A1%E7%9C%8C"
    + "%E7%84%BC%E6%B4%A5%E5%B8%82%E5%88%A9%E5%8F%B3%E8%A1%9B%E9%96%80%EF%BC%91%EF%BC%91%EF%BC%95"
    + "+%E3%82%A2%E3%83%AB%E3%82%AF%E3%82%B9%E3%83%9D%E3%83%B3%E3%83%89+%E7%84%BC%E6%B4%A5"
    + "/data=!4m2!3m1!1s0x601a447ba753e7fb:0x25e7e6355822a9c1";
  assert.equal(coordsFromUrl(real), null);
});

test("値がおかしいものは採らない", () => {
  assert.equal(coordsFromUrl("https://www.google.com/maps/@95.0,137.5,15z"), null);
  assert.equal(coordsFromUrl("https://example.com/no-coords"), null);
  assert.equal(coordsFromUrl(""), null);
  assert.equal(coordsFromUrl(null), null);
});

test("施設のリンクを住所と名前に分ける", () => {
  const real = "https://www.google.com/maps/place/%E3%80%92421-0212+%E9%9D%99%E5%B2%A1%E7%9C%8C"
    + "%E7%84%BC%E6%B4%A5%E5%B8%82%E5%88%A9%E5%8F%B3%E8%A1%9B%E9%96%80%EF%BC%91%EF%BC%91%EF%BC%95"
    + "+%E3%82%A2%E3%83%AB%E3%82%AF%E3%82%B9%E3%83%9D%E3%83%B3%E3%83%89+%E7%84%BC%E6%B4%A5"
    + "/data=!4m2!3m1!1s0x601a447ba753e7fb:0x25e7e6355822a9c1";
  // 郵便番号は落とし、住所と施設名を分ける。
  // 名前に住所が混ざるとスポット名が読めなくなり、
  // 住所に施設名が混ざると地名検索がどこにも当たらない
  assert.deepEqual(placeLabel(real), {
    name: "アルクスポンド 焼津",
    address: "静岡県焼津市利右衛門１１５",
  });
});

test("名前だけのリンクは、そのまま名前にする", () => {
  assert.deepEqual(
    placeLabel("https://www.google.com/maps/place/%E6%B5%9C%E5%90%8D%E6%B9%96/@34.7,137.5,13z"),
    { name: "浜名湖", address: "" },
  );
});

test("都道府県はどれでも住所として拾う", () => {
  const cases = [
    ["東京都千代田区丸の内１", "東京都"],
    ["北海道札幌市中央区北１条", "北海道"],
    ["京都府京都市中京区", "京都府"],
    ["大阪府大阪市北区", "大阪府"],
    ["静岡県浜松市中央区", "静岡県"],
  ];
  for (const [address, label] of cases) {
    const got = placeLabel(`https://www.google.com/maps/place/${encodeURIComponent(address + " テスト施設")}/data=x`);
    assert.equal(got.address, address, `${label} を住所として拾えていない`);
    assert.equal(got.name, "テスト施設");
  }
});

test("/place/ が無い URL では空", () => {
  assert.deepEqual(placeLabel("https://www.google.com/maps/@34.7,137.5,13z"),
    { name: "", address: "" });
  assert.deepEqual(placeLabel(""), { name: "", address: "" });
});
