/**
 * ボウズをすぐ残す仕組み（D-150）のテスト。
 *   node frontend/tests/blank_outing.test.mjs
 *
 * **ここは静かに汚れるところ。** 送る中身が 1 つ違っても画面にはエラーが出ず、
 * 「記録しました」と出たまま、あとで数えたときに合わないだけ。
 * しかも合わないことに気づけるのは、スコアの答え合わせをしようとした
 * ずっと先の話になる。
 *
 * 押さえるのは 3 つ。
 *   - **outcome は none、is_skunked は true。** 片方だけだと一覧の絞り込みと
 *     傾向の集計が食い違う（D-092 で 2 つ持つことにした経緯がある）
 *   - **魚の欄は送らない。** ボウズに魚の情報は無い
 *   - **天気が取れなくても保存は止めない**（圏外でも記録が残るのが先・D-096）
 */
import { sliceApp } from './_slice.mjs';

/* client と補助関数は差し替える。**何を送ったか**を見たいので、
   insert の中身をそのまま覚えておく */
const prelude = `
  let sent = null;
  let insertError = null;
  let weatherFails = false;
  let weatherCalls = 0;
  const client = {
    from() {
      return {
        insert(payload) {
          sent = payload;
          return { select() { return { single: async () =>
            ({ data: insertError ? null : { id: "rec-1" }, error: insertError }) }; } };
        },
      };
    },
  };
  async function requireUserId() { return "user-1"; }
  function isCoordinateInJapan(lat, lng) {
    return lat != null && lng != null && lat > 20 && lat < 46 && lng > 122 && lng < 154;
  }
  async function captureWeatherSnapshot() {
    weatherCalls++;
    if (weatherFails) throw new Error("圏外");
    return { source: "open-meteo", temp_c: 27 };
  }
  function todayInJst() { return "2026-09-11"; }
`;
const code = sliceApp([
  ['/**\n * ボウズ（何も無し）を 1 回で残す（D-150）。',
   '/* ============ メモの言葉で絞る'],
], prelude);

const app = new Function(code
  + `; return { logBlankOuting,
      _sent: () => sent, _reset: () => { sent = null; insertError = null;
        weatherFails = false; weatherCalls = 0; },
      _fail: (e) => { insertError = e; },
      _weatherFails: (v) => { weatherFails = v; },
      _weatherCalls: () => weatherCalls };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const SPOT = { id: 'spot-1', name: '中田島', latitude: 34.665, longitude: 137.72 };

/* ---- 送る中身 ---- */
{
  app._reset();
  const id = await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30' });
  const sent = app._sent();
  eq('できた記録の id が返る', id, 'rec-1');
  /* **outcome と is_skunked は必ず対で送る。** 片方だけだと
     一覧の絞り込み（outcome を見る）と古い画面（is_skunked を見る）が食い違う */
  eq('outcome は none', sent.outcome, 'none');
  eq('is_skunked は true', sent.is_skunked, true);
  eq('場所が入る', sent.spot_id, 'spot-1');
  eq('日付と時刻が入る', [sent.fished_at, sent.fished_time], ['2026-09-11', '18:30']);
  eq('公開範囲の既定はグループ', sent.visibility, 'group');
  eq('天気も一緒に残る', sent.weather_snapshot?.temp_c, 27);
}

/* **魚の欄は送らない。** ボウズに魚の情報は無い。
   ここに length_cm: null などを混ぜると、DB の既定と二重管理になる */
{
  app._reset();
  await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30' });
  const keys = Object.keys(app._sent());
  const fish = ['fish_species_id', 'fish_name_local', 'length_cm', 'weight_g',
                'catch_count', 'recipe_id', 'lure_name', 'water_layer',
                'rod', 'reel', 'line', 'leader'];
  eq('魚まわりの欄は 1 つも送らない', fish.filter((k) => keys.includes(k)), []);
  // 潮は DB のトリガーが埋める（004）。こちらからは送らない
  check('潮のスナップショットも送らない', !keys.includes('tide_snapshot'));
}

/* ---- ひとこと ---- */
{
  app._reset();
  await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30',
    memo: '  反応なし ドチャ濁り  ' });
  eq('前後の空白は落とす', app._sent().memo, '反応なし ドチャ濁り');
}
{
  app._reset();
  await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30', memo: '   ' });
  // **空白だけのメモを "" で残さない。** 「書いてある」ように見えてしまう
  eq('空白だけなら null', app._sent().memo, null);
}
{
  app._reset();
  await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30' });
  eq('書かなければ null', app._sent().memo, null);
}

/* ---- 天気が取れなくても保存は止めない（D-096） ----
   圏外の堤防で押すことがある。**記録が残るほうが先** */
{
  app._reset();
  app._weatherFails(true);
  /* **必ず受け止める。** 天気の失敗がそのまま抜けてくると、
     FAIL を出す前に script ごと落ちる。**落ちると罠を仕掛けても気づけない**
     （D-140 / D-144 でも同じ穴を踏んだ） */
  let id = null;
  let escaped = null;
  try { id = await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30' }); }
  catch (e) { escaped = e; }
  check('天気が取れなくても記録できる',
    escaped === null && id === 'rec-1',
    escaped ? `天気の失敗が抜けてきた: ${escaped.message}` : String(id));
  check('天気の欄は付けない',
    app._sent() !== null && !('weather_snapshot' in app._sent()));
}

/* ---- 場所が無いとき ---- */
{
  app._reset();
  await app.logBlankOuting({ spot: null, date: '2026-09-11', time: '18:30' });
  eq('スポット未選択でも残せる', app._sent().spot_id, null);
  // 座標が無いのに天気を取りに行かない（要らない通信をしない）
  eq('天気は取りに行かない', app._weatherCalls(), 0);
}
{
  app._reset();
  await app.logBlankOuting({ spot: { id: 's', latitude: null, longitude: null },
    date: '2026-09-11', time: '18:30' });
  eq('座標が無ければ天気は取りに行かない', app._weatherCalls(), 0);
}
{
  app._reset();
  await app.logBlankOuting({ spot: { id: 's', latitude: 0, longitude: 0 },
    date: '2026-09-11', time: '18:30' });
  /* **(0,0) で取りに行かない。** 赤道の大西洋上の天気が入る（D-105 で踏んだ） */
  eq('国外の座標では取りに行かない', app._weatherCalls(), 0);
}

/* ---- 材料が足りないとき ---- */
for (const [name, args] of [
  ['日付が無い', { spot: SPOT, time: '18:30' }],
  ['時刻が無い', { spot: SPOT, date: '2026-09-11' }],
  ['どちらも無い', { spot: SPOT }],
  ['引数そのものが無い', undefined],
]) {
  app._reset();
  let threw = false;
  try { await app.logBlankOuting(args); } catch { threw = true; }
  check(`${name}なら保存しない`, threw && app._sent() === null);
}

/* ---- 保存に失敗したら黙らない ---- */
{
  app._reset();
  app._fail({ message: 'DB が受け付けなかった' });
  let threw = false;
  try { await app.logBlankOuting({ spot: SPOT, date: '2026-09-11', time: '18:30' }); }
  catch { threw = true; }
  check('失敗はそのまま投げ返す（画面が黙らない）', threw);
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
