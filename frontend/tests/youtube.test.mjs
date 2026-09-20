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
const { parseYouTubeId, youTubeEmbedUrl,
        parseYouTubeChannelId, youTubeChannelEmbedUrl, liveCameraEmbedUrl,
        liveCameraWatchUrl, liveCameraFrameUrl } =
  new Function(code + `; return { parseYouTubeId, youTubeEmbedUrl,
    parseYouTubeChannelId, youTubeChannelEmbedUrl, liveCameraEmbedUrl,
    liveCameraWatchUrl, liveCameraFrameUrl };`)();

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

/* ---- チャンネルで指す（D-145） ----
   動画 ID で指すと、配信する側が配信を切り直したときに古い録画が残る。
   そのとき画面は何も壊れず、**古い録画が「いまの海」の顔をして出続ける。**
   チャンネルで指せば常にいま流れているものが出る。

   ここも安全の境目。**チャンネル ID がそのまま iframe の src に入る。** */
const CH = 'UCklttRvu7xLyAIHfn1Rqreg';   // 同笠海岸のカメラのチャンネル（本人がくれた）

for (const [label, input] of [
  ['本人がくれた形（si 付き）',
   'https://youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg?si=kUxCGnI3mK0hECeY'],
  ['www 付き', 'https://www.youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg'],
  ['スマホ版', 'https://m.youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg'],
  ['末尾に / が付く', 'https://www.youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg/'],
  ['さらに下の階層', 'https://www.youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg/streams'],
  ['ID を直接貼る', CH],
  ['前後に空白', `  ${CH} `],
]) check(`チャンネル: ${label}`, parseYouTubeChannelId(input) === CH,
  String(parseYouTubeChannelId(input)));

/* **通してはいけないもの。** 動画 ID のときと同じ罠が全部ある */
for (const [label, input] of [
  ['よく似た別ホスト', 'https://evil-youtube.com/channel/UCklttRvu7xLyAIHfn1Rqreg'],
  ['後ろに足した別ホスト', 'https://youtube.com.attacker.jp/channel/UCklttRvu7xLyAIHfn1Rqreg'],
  ['javascript:', 'javascript:alert(1)'],
  ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['file:', 'file:///etc/passwd'],
  /* **@ハンドルは通さない。** ここからチャンネル ID は分からず、
     当てるには YouTube の API が要る。似た形を勝手に通すくらいなら
     「読み取れなかった」と言うほうがいい */
  ['@ハンドル', 'https://www.youtube.com/@nanigashi'],
  ['ユーザー名の古い形', 'https://www.youtube.com/user/nanigashi'],
  ['動画の URL（チャンネルではない）', 'https://www.youtube.com/live/84GhMEo9We0'],
  ['UC で始まらない', 'ABklttRvu7xLyAIHfn1Rqreg'],
  ['短い', 'UCklttRvu7xLyAIHfn1Rqre'],
  ['長い', 'UCklttRvu7xLyAIHfn1Rqregg'],
  ['使えない字', 'UCklttRvu7xLyAIHfn1Rqre!'],
  ['channel の後ろが空', 'https://www.youtube.com/channel/'],
  ['空', ''],
  ['null', null],
  ['undefined', undefined],
  ['数', 12345],
]) check(`チャンネル 通さない: ${label}`, parseYouTubeChannelId(input) === null,
  String(parseYouTubeChannelId(input)));

/* 埋め込み URL も自前で組み立てる（入力を混ぜない） */
check('チャンネルの埋め込みは live_stream で組み立てる',
  youTubeChannelEmbedUrl(CH)
    === `https://www.youtube-nocookie.com/embed/live_stream?channel=${CH}`,
  String(youTubeChannelEmbedUrl(CH)));
check('チャンネルも nocookie 版を使う',
  youTubeChannelEmbedUrl(CH).startsWith('https://www.youtube-nocookie.com/'));
for (const bad of ['../../evil', 'a"><script>', '', null, `${CH}?x=1`, '84GhMEo9We0'])
  check(`チャンネルの埋め込みも形を確かめる: ${JSON.stringify(bad)}`,
    youTubeChannelEmbedUrl(bad) === null);
check('通るチャンネル ID は URL に危ない字を含まない',
  encodeURIComponent(CH) === CH);

/* ---- どちらを使うかを決めるのは 1 か所だけ（D-145） ----
   呼ぶ側それぞれが選ぶと、画面ごとに違うものを出すようになる */
check('チャンネルがあればチャンネルを使う',
  liveCameraEmbedUrl({ youtube_channel_id: CH, youtube_id: null })
    === youTubeChannelEmbedUrl(CH));
check('チャンネルが無ければ動画 ID を使う',
  liveCameraEmbedUrl({ youtube_channel_id: null, youtube_id: ID })
    === youTubeEmbedUrl(ID));
/* DB は「どちらか一方だけ」を CHECK で縛っているが、
   万一両方来ても**チャンネルが勝つ**。古い録画を出すほうを選ばない */
check('両方あってもチャンネルが勝つ',
  liveCameraEmbedUrl({ youtube_channel_id: CH, youtube_id: ID })
    === youTubeChannelEmbedUrl(CH));
check('どちらも無ければ null',
  liveCameraEmbedUrl({ youtube_channel_id: null, youtube_id: null }) === null);
check('壊れた値なら null',
  liveCameraEmbedUrl({ youtube_channel_id: 'javascript:x', youtube_id: '../../evil' })
    === null);
check('カメラそのものが無くても落ちない',
  liveCameraEmbedUrl(null) === null && liveCameraEmbedUrl(undefined) === null);

/* ---- YouTube 側を開く URL（D-152） ----
   枠の中が「ライブ ストリームはオフラインです」になることがある。
   こちらの不具合と見分けが付かないので、向こうを開ける口を出す。
   **埋め込みとは別の URL。** 混ぜると、押した先が枠の中と同じものになる */
check('チャンネルは /live を開く',
  liveCameraWatchUrl({ youtube_channel_id: CH }) === `https://www.youtube.com/channel/${CH}/live`);
check('チャンネルが無ければ動画を開く',
  liveCameraWatchUrl({ youtube_id: ID }) === `https://www.youtube.com/watch?v=${ID}`);
check('両方あってもチャンネルが勝つ（埋め込みと同じ順番）',
  liveCameraWatchUrl({ youtube_channel_id: CH, youtube_id: ID })
    === `https://www.youtube.com/channel/${CH}/live`);
/* **埋め込み用とは別物**。同じだと「YouTube で開く」がまた枠の中を出す */
check('埋め込み用の URL とは別のもの',
  liveCameraWatchUrl({ youtube_channel_id: CH })
    !== liveCameraEmbedUrl({ youtube_channel_id: CH }));
check('開く先は nocookie ではない（本人が YouTube を開く操作）',
  !liveCameraWatchUrl({ youtube_channel_id: CH }).includes('nocookie'));
/* **形を確かめてから組み立てる。** ここは href にそのまま入る */
for (const bad of ['javascript:alert(1)', '../../evil', 'a"><script>', '', null])
  check(`開く先も形を確かめる: ${JSON.stringify(bad)}`,
    liveCameraWatchUrl({ youtube_channel_id: bad, youtube_id: bad }) === null);
check('どちらも無ければ null（リンクを出さない）',
  liveCameraWatchUrl({ youtube_channel_id: null, youtube_id: null }) === null);
check('カメラそのものが無くても落ちない',
  liveCameraWatchUrl(null) === null && liveCameraWatchUrl(undefined) === null);

/* ---- 埋め込む URL は「いま流れている動画」を優先する（D-156） ----
   チャンネル指定の埋め込みは実際に映らなくなった。サーバー側で解決した
   動画 ID があるなら、そちらを直接指す。**持たずに毎回引き直す**ので、
   配信が切り直されても追従する（047 で動画 ID を DB に固定して 1 日で壊れた） */
const CAM = { youtube_channel_id: CH, youtube_id: null };
check('配信中なら、その動画を埋め込む',
  liveCameraFrameUrl(CAM, { live: true, video_id: ID }) === youTubeEmbedUrl(ID));
/* **分からないときは、これまでどおりチャンネル指定に戻す。**
   ここで null を返すと、関数が落ちている間じゅうカメラが消える */
check('分からないときはチャンネル指定に戻す',
  liveCameraFrameUrl(CAM, { live: null, video_id: null })
    === youTubeChannelEmbedUrl(CH));
check('状態そのものが無くてもチャンネル指定に戻す',
  liveCameraFrameUrl(CAM, null) === youTubeChannelEmbedUrl(CH));
check('配信していないときもチャンネル指定（呼ぶ側が枠を出さない）',
  liveCameraFrameUrl(CAM, { live: false, video_id: null })
    === youTubeChannelEmbedUrl(CH));
/* **live が true でも、動画 ID の形が違えば使わない。** ここが iframe の src に入る */
for (const bad of ['javascript:alert(1)', '../../evil', 'a"><script>', '', null, `${ID}x`])
  check(`動画 ID の形も確かめる: ${JSON.stringify(bad)}`,
    liveCameraFrameUrl(CAM, { live: true, video_id: bad })
      === youTubeChannelEmbedUrl(CH));
/* 動画 ID だけのカメラでも壊れない */
check('チャンネルを持たないカメラでも落ちない',
  liveCameraFrameUrl({ youtube_channel_id: null, youtube_id: ID }, null)
    === youTubeEmbedUrl(ID));
check('カメラそのものが無くても落ちない',
  liveCameraFrameUrl(null, null) === null);

console.log(failed ? `\nFAIL ${failed} 件` : '\nすべて通過');
process.exit(failed ? 1 : 0);
