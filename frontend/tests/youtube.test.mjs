/**
 * ライブ映像の URL を ID に落とす処理（D-143）のテスト。
 *   node frontend/tests/youtube.test.mjs
 *
 * **ここは安全の境目。** 動画 ID がそのまま iframe の src に入る。
 * だから URL をそのまま埋め込まず、**11 桁の ID だけを取り出して**
 * 埋め込み先はこちらで組み立てる。DB の CHECK と 2 枚重ねにしてある（043）。
 *
 * 押さえるのは 3 つ。
 *   - YouTube の正しい形はすべて通る（貼り方は人それぞれ）
 *   - **YouTube でないものは 1 つも通さない**
 *   - 埋め込み URL は必ず自前で組み立てる（入力を混ぜない）
 */
import { sliceApp } from './_slice.mjs';

const code = sliceApp([
  ['/* ---------------- ライブ映像（D-143）', '/* ---------------- 天気の参照先（D-076）'],
]);
const { parseYouTubeId, youTubeEmbedUrl } =
  new Function(code + '; return { parseYouTubeId, youTubeEmbedUrl };')();

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const ID = '84GhMEo9We0';           // 同笠海岸の生配信（044 で差し替えた）

/* ---- 通るべきもの ---- */
for (const [label, url] of [
  ['本人がくれた形（live + si 付き）',
   'https://www.youtube.com/live/84GhMEo9We0?si=wjablkYYl-DZ10G0'],
  ['live', 'https://www.youtube.com/live/84GhMEo9We0'],
  ['watch', 'https://www.youtube.com/watch?v=84GhMEo9We0'],
  ['watch に他の引数が付く', 'https://www.youtube.com/watch?v=84GhMEo9We0&t=30s'],
  ['embed', 'https://www.youtube.com/embed/84GhMEo9We0'],
  ['短縮', 'https://youtu.be/84GhMEo9We0'],
  ['短縮 + 引数', 'https://youtu.be/84GhMEo9We0?si=abc'],
  ['www なし', 'https://youtube.com/live/84GhMEo9We0'],
  ['スマホ版', 'https://m.youtube.com/watch?v=84GhMEo9We0'],
  ['nocookie', 'https://www.youtube-nocookie.com/embed/84GhMEo9We0'],
  ['前後に空白', '  https://youtu.be/84GhMEo9We0  '],
  ['ID を直接貼る', '84GhMEo9We0'],
]) check(label, parseYouTubeId(url) === ID, String(parseYouTubeId(url)));

/* ---- 通してはいけないもの ----

   **ここが本体。** 罠: ホストを includes('youtube.com') で見ると
   evil-youtube.com と youtube.com.attacker.jp が通る。 */
for (const [label, url] of [
  ['よく似た別ホスト', 'https://evil-youtube.com/live/84GhMEo9We0'],
  ['後ろに足した別ホスト', 'https://youtube.com.attacker.jp/live/84GhMEo9We0'],
  ['まったく別のところ', 'https://example.com/live/84GhMEo9We0'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['file:', 'file:///etc/passwd'],
  ['URL ですらない', 'ただの文字列'],
  ['ID が短い', 'https://youtu.be/abc'],
  ['ID が長い', 'https://youtu.be/84GhMEo9We0XXXX'],
  ['ID に使えない字', 'https://youtu.be/kQljrmct/kg'],
  ['YouTube だが動画ではない', 'https://www.youtube.com/@somechannel'],
  ['YouTube のトップ', 'https://www.youtube.com/'],
  ['watch だが v が無い', 'https://www.youtube.com/watch?t=30'],
  ['空', ''],
  ['null', null],
  ['undefined', undefined],
  ['数', 12345],
]) check(`通さない: ${label}`, parseYouTubeId(url) === null, String(parseYouTubeId(url)));

/* ---- 埋め込み URL ---- */
{
  const u = youTubeEmbedUrl(ID);
  check('埋め込み URL を自前で組み立てる', u === `https://www.youtube-nocookie.com/embed/${ID}?rel=0&modestbranding=1`, u);
  /* 見るだけで追跡用の Cookie が置かれないほうを使う */
  check('nocookie 版を使う', u.includes('youtube-nocookie.com'));
}
/* **ID の形をここでも確かめる。** parse を通さずに呼ばれても壊れないように */
for (const bad of ['../../evil', 'a"><script>', '', null, '84GhMEo9We0?x=1', 'short'])
  check(`埋め込みも形を確かめる: ${JSON.stringify(bad)}`, youTubeEmbedUrl(bad) === null);

/* 通った ID は必ず 11 桁の安全な字だけ = そのまま URL に入れてよい */
check('通る ID は URL に危ない字を含まない',
  [ID, 'a_b-c1234_9'].every((x) => parseYouTubeId(x) === x
    && encodeURIComponent(x) === x));

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
