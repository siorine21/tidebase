/**
 * app.js から関数だけを切り出す道具（D-113）。
 *
 * app.js はブラウザ前提（window.supabase 等）なので import できない。
 * そこでテストはソースを文字列で切り出して `new Function` に食わせている。
 *
 * **この切り出しは、目印にした行が動いたり消えたりすると黙って壊れる。**
 * 実際、日付の統一で `const WEEKDAYS_SHORT` を消したら、
 * それを終わりの目印にしていた smooth_path のテストが
 * 関数 2 つぶんを取り込んで `SyntaxError: Unexpected token 'export'` で落ちた。
 * どのテストの、どの目印が悪いのか、その場では分からなかった。
 *
 * ここに集めて、**壊れたときに何が起きたか言う**ようにする。
 * 目印が見つからない／切り出した結果が読めない、をその場で止めて範囲を書き出す。
 */
import fs from 'node:fs';

/** 終わりの目印として渡すと「ファイルの末尾まで」。
    目印の文字列を探すのと区別が付くよう、専用の値にしてある。 */
export const END = Symbol("末尾まで");

const SRC = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');

/**
 * @param {Array<string|[string, string]>} parts 取り出す範囲。
 *   文字列なら「そこから次の export まで」、[from, to] なら from から to の手前まで。
 *   to に END を渡すとファイルの末尾まで。
 * @param {string} [prelude] 先に足しておくコード（依存する定数のダミーなど）
 * @returns {string} `new Function` に渡せるコード
 */
export function sliceApp(parts, prelude = "") {
  const chunks = [];
  for (const part of parts) {
    const [from, to] = Array.isArray(part) ? part : [part, null];
    const start = SRC.indexOf(from);
    if (start < 0) throw new Error(`切り出しの目印が見つからない: ${JSON.stringify(from)}`);
    let end;
    if (to === END) {
      end = SRC.length;
    } else if (to) {
      end = SRC.indexOf(to, start + from.length);
      if (end < 0) throw new Error(`終わりの目印が見つからない: ${JSON.stringify(to)}`);
    } else {
      // 次の export まで。目印を増やさずに 1 つだけ取れる
      end = SRC.indexOf("\nexport ", start + from.length);
      if (end < 0) end = SRC.length;
    }
    chunks.push(SRC.slice(start, end));
  }
  const code = [prelude, ...chunks].filter(Boolean).join("\n")
    .replaceAll("export function", "function")
    .replaceAll("export const", "const")
    .replaceAll("export async function", "async function");

  /* **組み立てた結果がそもそも読めるか**を、ここで見る。
     目印が動くと関数の途中で切れることがあり、そのまま new Function に渡すと
     「Unexpected token」としか言われず、どのテストのどの目印が悪いのか分からない。
     ここで先に試して、**どの範囲を切ろうとしたか**を添えて投げ直す。 */
  try {
    new Function(code);
  } catch (e) {
    const ranges = parts.map((p) => (Array.isArray(p) ? `${p[0]} 〜 ${String(p[1])}` : p));
    throw new Error(`切り出したコードが読めない（目印を見直す）\n`
      + `  切ろうとした範囲:\n    ${ranges.join("\n    ")}\n`
      + `  中身のエラー: ${e.message}`);
  }
  return code;
}
