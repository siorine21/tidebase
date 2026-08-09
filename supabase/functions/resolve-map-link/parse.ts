/**
 * URL から座標と場所の名前を読み取る（純粋関数のみ）。
 *
 * index.ts から切り出してあるのは、**テストできるようにする**ため。
 * index.ts は読み込むだけで Deno.serve が動くので、node --test から import できない。
 * ここは外へ出ていかないので、そのまま試せる（CI: make test-edge）。
 */

/** URL から座標を読む。frontend/assets/app.js の parseLatLng と同じ規則。 */
export function coordsFromUrl(text: string): { lat: number; lng: number } | null {
  const s = String(text ?? "");
  const pick = (lat: string, lng: string) => {
    const y = Number(lat), x = Number(lng);
    if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
    if (Math.abs(y) > 90 || Math.abs(x) > 180) return null;
    return { lat: y, lng: x };
  };
  // 「!3d緯度!4d経度」は地点そのもの。「@緯度,経度」は画面の中心なので後回し
  const place = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (place) return pick(place[1], place[2]);
  const view = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (view) return pick(view[1], view[2]);
  const query = s.match(/[?&](?:q|ll|daddr|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i);
  if (query) return pick(query[1], query[2]);
  return null;
}

const PREFECTURE_RE = /(北海道|東京都|(?:京都|大阪)府|..県)/;
const POSTAL_RE = /^〒?\d{3}-?\d{4}$/;

/**
 * URL の /place/<...>/ を、住所と名前に分ける。
 * Google は「〒421-0212 静岡県焼津市利右衛門１１５ アルクスポンド 焼津」のように
 * 郵便番号・住所・施設名を空白でつなげてくる。
 */
export function placeLabel(text: string): { name: string; address: string } {
  const match = String(text ?? "").match(/\/place\/([^/@?]+)/);
  if (!match) return { name: "", address: "" };
  let decoded = "";
  try {
    decoded = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
  } catch {
    return { name: "", address: "" };
  }

  const parts = decoded.split(/\s+/).filter(Boolean);
  const address = parts.find((p) => PREFECTURE_RE.test(p)) ?? "";
  // 郵便番号と住所を除いた残りが施設名。
  // 住所しか無いリンク（住所を共有した場合）は名前が空になる
  const name = parts
    .filter((p) => p !== address && !POSTAL_RE.test(p))
    .join(" ")
    .trim();
  return { name: name || decoded, address };
}
