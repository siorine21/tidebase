/**
 * 記録を釣行（回）にまとめて数える処理（D-160）のテスト。
 *   node frontend/tests/outings.test.mjs
 *
 * **ここは「書き方の違いで答えが変わる」を止めるところ。**
 * 実測（本番 66 件）で、同じ人が同じスポットで両方の書き方をしていた:
 *   豊浜橋 2026-09-01   記録 1 件 →  8 匹
 *   国安橋 2026-08-10   記録 4 件 →  2 匹（残り 2 件はバラシ）
 * 記録の件数で数えると 4 対 1 で国安橋の勝ち。匹数で数えると 2 対 8 で逆転する。
 * **件数が測っているのは、その日どう書く気分だったかだけ。**
 *
 * 押さえるのは 5 つ。
 *   - 1 投稿に 8 匹でも、短時間に 2 投稿でも、**同じ「1 回で複数匹」**
 *   - バイト・バラシを匹数に混ぜない（catch_count は 1 で入っている）
 *   - 4 時間以上空いたら別の回（二瀬橋 8/30 の朝と夜）
 *   - **人も鍵に入れる**（2 人が 1 匹ずつを「連発」と数えない）
 *   - 率を出さない。分母（行ったが記録しなかった回）が本物ではない
 *
 * 作り物のデータは、**本番の record_feed の形と値に合わせてある**。
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  'export function hoursFromHhmm(hhmm)',
  ['export const OUTING_GAP_HOURS', 'export const RECORD_LIST_COLUMNS'],
]);

const app = new Function(code + `; return { groupOutings, spotHistory, phaseBand,
  phaseBandOf, seasonDistance, inSeasonWindow, OUTING_GAP_HOURS };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/** record_feed の 1 行 */
let seq = 0;
const rec = (o = {}) => ({
  id: `r${seq++}`, user_id: "u1", owner_name: "タツマ", is_mine: false,
  spot_id: "sp1", spot_name: "豊浜橋(ウェーディング)",
  fished_at: "2026-09-01", fished_time: "09:30:00",
  outcome: "landed", is_skunked: false, catch_count: 1,
  fish_label: null, species_name: null, length_cm: null,
  tide_phase_tenth: null, tide_phase_rising: null,
  ...o,
});

/* ================================================================
   1 投稿に 8 匹 ／ 短時間に 2 投稿。**同じ答えになる**
   ================================================================ */
{
  const onePost = app.groupOutings([
    rec({ catch_count: 8, fish_label: "メッキ", length_cm: 20 }),
  ]);
  eq('1 投稿に 8 匹 → 1 回', onePost.length, 1);
  eq('  その回は 8 匹', onePost[0].fish, 8);

  const twoPosts = app.groupOutings([
    rec({ fished_time: "09:30:00", catch_count: 4, fish_label: "メッキ", length_cm: 20 }),
    rec({ fished_time: "10:10:00", catch_count: 4, fish_label: "メッキ", length_cm: 18 }),
  ]);
  eq('短時間に 2 投稿 → 1 回', twoPosts.length, 1);
  eq('  その回も 8 匹', twoPosts[0].fish, 8);
  check('**書き方が違っても同じ答え**', onePost[0].fish === twoPosts[0].fish,
    `${onePost[0].fish} / ${twoPosts[0].fish}`);
}

/* ================================================================
   国安橋 2026-08-10（本番のデータそのもの）
   19:45 バラシ / 20:30 35cm / 21:10 バラシ / 21:50 15cm
   → 1 回・**2 匹**。記録 4 件を 4 匹と数えない
   ================================================================ */
{
  const out = app.groupOutings([
    rec({ spot_id: "sp2", spot_name: "国安橋", fished_at: "2026-08-10",
          fished_time: "19:45:00", outcome: "lost", is_skunked: true, catch_count: 1 }),
    rec({ spot_id: "sp2", spot_name: "国安橋", fished_at: "2026-08-10",
          fished_time: "20:30:00", outcome: "landed", catch_count: 1,
          fish_label: "マルスズキ", length_cm: 35 }),
    rec({ spot_id: "sp2", spot_name: "国安橋", fished_at: "2026-08-10",
          fished_time: "21:10:00", outcome: "lost", is_skunked: true, catch_count: 1 }),
    rec({ spot_id: "sp2", spot_name: "国安橋", fished_at: "2026-08-10",
          fished_time: "21:50:00", outcome: "landed", catch_count: 1,
          fish_label: "マルスズキ", length_cm: 15 }),
  ]);
  eq('国安橋 8/10 は 1 回', out.length, 1);
  eq('  記録は 4 件', out[0].records, 4);
  eq('  **匹数は 2**（バラシを混ぜない）', out[0].fish, 2);
  eq('  最大サイズは 35cm', out[0].maxLengthCm, 35);
  /* 2 時間 5 分は同じ回。**4 時間の窓の中**（実測で 2.08h と 12.00h の間が空いている） */
  check('2 時間 5 分は分けない', out.length === 1);
}

/* ---- 8 匹の豊浜橋と、2 匹の国安橋を並べると逆転しない ---- */
{
  const toyohama = app.groupOutings([rec({ catch_count: 8, fish_label: "メッキ", length_cm: 20 })]);
  const kuniyasu = app.groupOutings([
    rec({ spot_id: "sp2", fished_at: "2026-08-10", fished_time: "19:45:00",
          outcome: "lost", is_skunked: true }),
    rec({ spot_id: "sp2", fished_at: "2026-08-10", fished_time: "20:30:00", length_cm: 35 }),
    rec({ spot_id: "sp2", fished_at: "2026-08-10", fished_time: "21:10:00",
          outcome: "lost", is_skunked: true }),
    rec({ spot_id: "sp2", fished_at: "2026-08-10", fished_time: "21:50:00", length_cm: 15 }),
  ]);
  check('**件数では逆転するが、匹数では逆転しない**',
    kuniyasu[0].records > toyohama[0].records && kuniyasu[0].fish < toyohama[0].fish,
    `件数 ${kuniyasu[0].records}対${toyohama[0].records} / 匹数 ${kuniyasu[0].fish}対${toyohama[0].fish}`);
}

/* ================================================================
   二瀬橋 2026-08-30（本番のデータそのもの）07:00 と 19:00 → **別の回**
   ================================================================ */
{
  const out = app.groupOutings([
    rec({ spot_id: "sp3", spot_name: "二瀬橋(ウェーディング)", fished_at: "2026-08-30",
          fished_time: "07:00:00", outcome: "bite", is_skunked: true, catch_count: 1 }),
    rec({ spot_id: "sp3", spot_name: "二瀬橋(ウェーディング)", fished_at: "2026-08-30",
          fished_time: "19:00:00", outcome: "none", is_skunked: true, catch_count: 0 }),
  ]);
  eq('12 時間空いたら別の回', out.length, 2);
  eq('  どちらも 0 匹', out.map((o) => o.fish), [0, 0]);
}

/* ちょうど 4 時間は「別の回」側。境目をどちらに倒すか決めておく */
{
  const out = app.groupOutings([
    rec({ fished_time: "06:00:00" }), rec({ fished_time: "10:00:00" }),
  ]);
  eq('ちょうど 4 時間は別の回', out.length, 2);
  const near = app.groupOutings([
    rec({ fished_time: "06:00:00" }), rec({ fished_time: "09:59:00" }),
  ]);
  eq('3 時間 59 分は同じ回', near.length, 1);
}

/* ================================================================
   人も鍵に入れる。**2 人が 1 匹ずつを「連発」と数えない**
   ================================================================ */
{
  const out = app.groupOutings([
    rec({ user_id: "u1", owner_name: "タツマ", fished_time: "09:30:00", length_cm: 50 }),
    rec({ user_id: "u2", owner_name: "ユーキ", fished_time: "09:40:00", length_cm: 45 }),
  ]);
  eq('同じ場所・同じ時間でも、人が違えば別の回', out.length, 2);
  eq('  どちらも 1 匹', out.map((o) => o.fish), [1, 1]);
  check('  誰の回かが残る',
    out.map((o) => o.ownerName).sort().join("/") === "タツマ/ユーキ",
    out.map((o) => o.ownerName).join("/"));
}

/* 時刻が無い記録は、その日・その人・そのスポットで 1 つにまとめる */
{
  const out = app.groupOutings([
    rec({ fished_time: null }), rec({ fished_time: null }),
  ]);
  eq('時刻が無ければ 1 回にまとめる', out.length, 1);
  eq('  匹数は足す', out[0].fish, 2);
}

/* 材料が足りない行は落とす（画面を落とさない） */
{
  eq('空でも落ちない', app.groupOutings([]).length, 0);
  eq('null でも落ちない', app.groupOutings(null).length, 0);
  eq('スポットの無い行は数えない',
    app.groupOutings([rec({ spot_id: null }), rec({ fished_at: null })]).length, 0);
}

/* ================================================================
   潮位置の帯
   ================================================================ */
{
  eq('0 分は始め', app.phaseBand(0, true), "上げ始め");
  eq('3 分は始め', app.phaseBand(3, true), "上げ始め");
  eq('4 分は中盤', app.phaseBand(4, true), "上げ中盤");
  eq('6 分は中盤', app.phaseBand(6, false), "下げ中盤");
  eq('7 分は終わり', app.phaseBand(7, false), "下げ終わり");
  eq('10 分は終わり', app.phaseBand(10, false), "下げ終わり");
  eq('向きが無ければ null', app.phaseBand(7, null), null);
  eq('分が無ければ null', app.phaseBand(null, true), null);
  eq('phaseBandOf も同じ', app.phaseBandOf({ tenth: 9, rising: false }), "下げ終わり");
  eq('phaseBandOf に null', app.phaseBandOf(null), null);
}

/* ================================================================
   時期の窓（±1 か月）。**年をまたいでも測れる**
   ================================================================ */
{
  eq('同じ日は 0 日', app.seasonDistance("2026-09-22", "2025-09-22"), 0);
  eq('1 か月違い', app.seasonDistance("2026-08-22", "2026-09-22"), 31);
  check('**年をまたいで近い**（12/28 と 1/5）',
    app.seasonDistance("2025-12-28", "2026-01-05") === 8,
    String(app.seasonDistance("2025-12-28", "2026-01-05")));
  eq('真裏は 182 日まで', app.seasonDistance("2026-03-22", "2026-09-22") <= 183, true);
  eq('窓の中', app.inSeasonWindow("2024-10-15", "2026-09-22"), true);
  eq('窓の外', app.inSeasonWindow("2026-03-01", "2026-09-22"), false);
  eq('**去年の同じ時期は窓の中**', app.inSeasonWindow("2025-09-30", "2026-09-22"), true);
}

/* ================================================================
   1 スポットの実績。**率を出さない**
   ================================================================ */
{
  const outings = app.groupOutings([
    // この時期・連発の回
    rec({ spot_id: "sp1", fished_at: "2026-09-01", fished_time: "09:30:00",
          catch_count: 8, fish_label: "メッキ", length_cm: 20,
          tide_phase_tenth: 8, tide_phase_rising: false }),
    // この時期・単発だが大きい
    rec({ spot_id: "sp1", fished_at: "2025-09-30", fished_time: "18:00:00",
          catch_count: 1, fish_label: "マルスズキ", length_cm: 70,
          tide_phase_tenth: 9, tide_phase_rising: false }),
    // この時期・0 匹（行ったが獲れなかった）
    rec({ spot_id: "sp1", fished_at: "2026-09-10", fished_time: "06:00:00",
          outcome: "none", is_skunked: true, catch_count: 0,
          tide_phase_tenth: 2, tide_phase_rising: true }),
    // 時期が違う
    rec({ spot_id: "sp1", fished_at: "2026-03-13", fished_time: "21:26:00",
          catch_count: 1, fish_label: "マルスズキ", length_cm: 50,
          tide_phase_tenth: 9, tide_phase_rising: false }),
  ]);
  const h = app.spotHistory(outings, {
    spotId: "sp1", today: "2026-09-22", phase: { tenth: 9, rising: false } });

  eq('この時期に獲れた回', h.seasonCaught, 2);
  eq('この時期に行った回（0 匹も含む）', h.seasonOutings, 3);
  eq('**いちばん濃かった回の匹数**', h.bestFish, 8);
  eq('**いちばん大きかったサイズ**', h.bestLengthCm, 70);
  eq('その魚種', h.bestSpecies, "マルスズキ");
  eq('いまの潮位置の帯', h.band, "下げ終わり");
  /* 下げ8分・下げ9分・下げ9分（時期の外も数える。潮位置は季節と別の軸） */
  eq('**同じ潮位置で釣れた回**（時期の外も数える）', h.samePhase, 3);
  eq('最後に釣れた回の日付', h.last?.date, "2026-09-01");
  check('**率を返さない**',
    !Object.keys(h).some((k) => /rate|ratio|percent|率/i.test(k)), Object.keys(h).join(","));
}

/* いまの潮位置が分からなければ、潮位置の回数は数えない（0 と言わない） */
{
  const outings = app.groupOutings([
    rec({ spot_id: "sp1", tide_phase_tenth: 9, tide_phase_rising: false }),
  ]);
  const h = app.spotHistory(outings, { spotId: "sp1", today: "2026-09-22", phase: null });
  eq('潮位置が分からなければ null', h.samePhase, null);
  check('  **0 と言わない**（「この潮では釣れない」に読める）', h.samePhase !== 0);
}

/* 0 匹の回だけのスポットは「釣れた回」に数えない */
{
  const outings = app.groupOutings([
    rec({ spot_id: "sp9", outcome: "bite", is_skunked: true, catch_count: 1,
          tide_phase_tenth: 9, tide_phase_rising: false }),
  ]);
  const h = app.spotHistory(outings, {
    spotId: "sp9", today: "2026-09-22", phase: { tenth: 9, rising: false } });
  eq('アタリだけの回は 0 匹', outings[0].fish, 0);
  eq('  釣れた回に数えない', h.seasonCaught, 0);
  eq('  行った回には数える', h.seasonOutings, 1);
  eq('  同じ潮位置でも数えない', h.samePhase, 0);
}

/* 記録の無いスポットでも落ちない */
{
  const h = app.spotHistory([], { spotId: "none", today: "2026-09-22" });
  eq('記録が無ければ 0', [h.seasonCaught, h.totalCaught, h.bestFish], [0, 0, 0]);
  eq('  最後の回は null', h.last, null);
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
