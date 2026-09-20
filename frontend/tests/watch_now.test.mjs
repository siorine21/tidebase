/**
 * 「いま」を追いつかせる仕組み（D-157）のテスト。
 *   node frontend/tests/watch_now.test.mjs
 *
 * **ここは「黙って古いまま」を直すところ。**
 * 開きっぱなしの画面は、何も壊れていないのに現在時刻だけが止まる。
 * エラーも出ないし見た目も正しいので、**見ている側は気づかない**。
 * 気づいたときには「さっきから潮位が動いていない」と思うだけになる。
 *
 * 押さえるのは 4 つ。
 *   - **見えた瞬間に必ず 1 回描き直す**（戻ってきた瞬間がいちばん古い）
 *   - 隠れている間は刻まない（端末が止めるし、止めてよい）
 *   - 刻みは**分の頭に合わせる**（ずれると時計が最大 59 秒古いまま）
 *   - 日付が変わったときだけ知らせる。**通信するかは呼ぶ側が決める**
 */
import { sliceApp } from './_slice.mjs';

/* document / window / 時計を全部差し替える。**何回呼ばれたか**を見たい */
const prelude = `
  /* **Date をそのまま書かない。** この足場では Date を差し替えるので、
     ここで Date.parse を呼ぶと自分の宣言の巻き上げに当たって落ちる
     （2026-09-20T09:30:20+09:00 をあらかじめ数にしてある） */
  let clock = 1789864220000;
  const RealDate = globalThis.Date;
  function todayInJst() {
    return new RealDate(clock + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const Date = new Proxy(RealDate, {
    get(target, key) { return key === "now" ? () => clock : target[key]; },
  });

  let timers = [];
  let nextId = 1;
  function setTimeout(fn, ms) { const id = nextId++; timers.push({ id, fn, at: clock + ms }); return id; }
  function clearTimeout(id) { timers = timers.filter((t) => t.id !== id); }

  const listeners = { doc: {}, win: {} };
  const doc = {
    visibilityState: "visible",
    addEventListener(name, fn) { (listeners.doc[name] ??= []).push(fn); },
    removeEventListener(name, fn) {
      listeners.doc[name] = (listeners.doc[name] ?? []).filter((f) => f !== fn);
    },
  };
  const win = {
    addEventListener(name, fn) { (listeners.win[name] ??= []).push(fn); },
    removeEventListener(name, fn) {
      listeners.win[name] = (listeners.win[name] ?? []).filter((f) => f !== fn);
    },
  };
  function fire(where, name) { for (const fn of listeners[where][name] ?? []) fn(); }
  /** 時計を進めて、期限の来たタイマーを順に走らせる */
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
    clock = end;
  }
`;

const code = sliceApp([
  ['export function watchNow', '/* 曜日は**英語の 3 文字**（D-113）'],
], prelude);

const app = new Function(code + `; return { watchNow, doc, win, fire, advance,
  _timers: () => timers.length, _now: () => clock,
  _hidden: (v) => { doc.visibilityState = v ? "hidden" : "visible"; },
  _reset: () => { clock = 1789864220000; timers = []; doc.visibilityState = "visible"; },
  _listeners: () => listeners };`)();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

/** **毎回 09:30:20 から始める。** 持ち越すと、あとのブロックが前の時刻に
    引きずられて「日をまたいだつもりがまたいでいない」ことになる（実際なった） */
const start = (extra = {}) => {
  app._reset();
  let ticks = 0;
  const days = [];
  const stop = app.watchNow({
    tick: () => { ticks++; },
    onNewDay: (d) => days.push(d),
    doc: app.doc, win: app.win, ...extra,
  });
  return { stop, ticks: () => ticks, days: () => days };
};

/* ---- 始めた時点で 1 回描く ---- */
{
  const w = start();
  eq('始めた時点で 1 回描く', w.ticks(), 1);
  w.stop();
}

/* ---- 刻みは分の頭に合わせる ----
   09:30:20 に始めたら、次は 09:31:00。60 秒後の 09:31:20 ではない */
{
  const w = start();
  app.advance(39_000);                 // 09:30:59 まで
  eq('分の頭の前には刻まない', w.ticks(), 1);
  app.advance(1_100);                  // 09:31:00.05 を跨ぐ（余白の 50ms ぶん）
  eq('**分の頭で刻む**', w.ticks(), 2);
  app.advance(60_000);
  eq('そのあとは 1 分ごと', w.ticks(), 3);
  w.stop();
}

/* ---- 戻ってきた瞬間に描く ----
   **ここが今回の主眼。** 端末は隠れている間タイマーを止めるので、
   戻ってきたときに描き直さないと、次の分の頭まで古いまま */
{
  const w = start();
  app._hidden(true);
  app.fire('doc', 'visibilitychange');
  eq('隠れたら刻まない（タイマーを畳む）', app._timers(), 0);
  app.advance(10 * 60_000);            // 10 分放置
  eq('隠れている間は 1 度も描かない', w.ticks(), 1);

  app._hidden(false);
  app.fire('doc', 'visibilitychange');
  eq('**見えた瞬間に描き直す**', w.ticks(), 2);
  check('見えたら刻み直す', app._timers() === 1);
  w.stop();
}

/* bfcache から戻ると visibilitychange が来ない端末がある */
{
  const w = start();
  app.advance(5 * 60_000);
  const before = w.ticks();
  app.fire('win', 'pageshow');
  check('pageshow でも描き直す', w.ticks() === before + 1, `${before} → ${w.ticks()}`);
  w.stop();
}

/* ---- 日付が変わったときだけ知らせる ---- */
{
  const w = start();
  app.advance(60_000);
  eq('同じ日なら知らせない', w.days(), []);
  // 日をまたぐまで進める（09:31 → 翌 00:00 まで 14 時間半ほど）
  app.advance(15 * 60 * 60_000);
  eq('**日が変わったら 1 回だけ知らせる**', w.days().length, 1);
  check('知らせる中身は新しい日付', /^\d{4}-\d{2}-\d{2}$/.test(w.days()[0] ?? ''), w.days()[0]);
  const after = w.days().length;
  app.advance(60_000);
  eq('同じ日のうちは繰り返さない', w.days().length, after);
  w.stop();
}

/* 隠れている間に日をまたいでも、**戻ってきたときに 1 回**知らせる */
{
  const w = start();
  app._hidden(true);
  app.fire('doc', 'visibilitychange');
  app.advance(20 * 60 * 60_000);       // 09:30 → 翌 05:30。隠れたまま日をまたぐ
  eq('隠れている間は知らせない', w.days(), []);
  app._hidden(false);
  app.fire('doc', 'visibilitychange');
  eq('**戻ってきたときに知らせる**', w.days().length, 1);
  w.stop();
}

/* ---- 止める ---- */
{
  const w = start();
  w.stop();
  eq('止めたらタイマーが残らない', app._timers(), 0);
  const before = w.ticks();
  app.advance(10 * 60_000);
  eq('止めたら刻まない', w.ticks(), before);
  app.fire('doc', 'visibilitychange');
  eq('止めたら見えても描かない', w.ticks(), before);
  eq('聞き耳も外す', app._listeners().doc.visibilitychange.length, 0);
}

/* ---- 材料が無くても落ちない ---- */
{
  const stop = app.watchNow({ doc: app.doc, win: app.win });
  check('tick も onNewDay も無くて落ちない', true);
  stop();
}

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
