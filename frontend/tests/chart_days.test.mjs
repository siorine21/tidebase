/**
 * 潮位グラフの「日数」が 1 か所だけに書かれているかを見張る（D-128）。
 *   node frontend/tests/chart_days.test.mjs
 *
 * もとは theme.css に `700%` / `300%`、tide.html に `7`、index.html に 3 日の配列と、
 * **同じ数が 2 か所ずつ**あった。片方だけ変えると、グラフの中身と器の幅がずれて
 * 「最後の日だけ見切れる」「送っても余白が出る」という壊れ方をする。
 * いまは描くときに --chart-days を渡す形にしてあるので、それが崩れていないかを見る。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const CSS = read('../assets/theme.css');
const TIDE = read('../tide.html');
const HOME = read('../index.html');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

/* ---- CSS 側に日数を書かない ---- */
const trackRule = CSS.match(/\.tide-track\s*\{[^}]*\}/)?.[0] ?? '';
check('.tide-track の幅は --chart-days から計算している',
  /var\(--chart-days/.test(trackRule), trackRule.replace(/\s+/g, ' '));
check('.tide-track に固定の % を書いていない',
  !/width:\s*\d+%/.test(trackRule), trackRule.replace(/\s+/g, ' '));
// 昔の書き方（700% / 300%）が戻っていないこと
for (const dead of ['width: 700%', 'width: 300%', 'width: 14.2857%', 'width: 33.333%']) {
  check(`古い固定幅が残っていない（${dead}）`, !CSS.includes(dead));
}

/* ---- 画面側は必ず日数を渡す ---- */
check('潮汐画面が --chart-days を渡している', TIDE.includes('"--chart-days"'));
check('ホームが --chart-days を渡している', HOME.includes('"--chart-days"'));

/* ---- 範囲の決め方（指摘そのもの） ---- */
check('潮汐画面の範囲は週カレンダーではなく起点から作る',
  /function chartDays\(\)/.test(TIDE) && /state\.chartAnchor/.test(TIDE));
check('前日 1 日ぶんと 1 週間先',
  /CHART_BEFORE\s*=\s*1/.test(TIDE) && /CHART_AFTER\s*=\s*7/.test(TIDE));
/* **スクロールで起点を動かさない**（動かすと「送る → 範囲が変わる → 位置がずれる」
   で暴れる）。scroll ハンドラの中に代入が無いことだけ確かめる。 */
const scrollHandler = TIDE.match(/scroller\.addEventListener\("scroll"[\s\S]*?\}, 120\);/)?.[0] ?? '';
check('スクロールでは起点を動かさない',
  scrollHandler.length > 0 && !/state\.chartAnchor\s*=/.test(scrollHandler));

console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて PASS');
process.exit(failed ? 1 : 0);
