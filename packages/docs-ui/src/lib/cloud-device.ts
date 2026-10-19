/**
 * クラウドの版を書いた他の端末の呼び名（#18750）。「スマホで更新されています」のように、どの端末の変更かを知らせる。
 *
 * 種類（`mac` / `browser` / `phone`）があればそれで呼ぶ。種類を送らない旧 client の版は端末 ID の形で見分ける
 * （Web/PWA は `pwa_`、Mac アプリは `d_`）。どれでもない（サーバーの書き込み・不明）は「別の端末」。
 */
import type { VaultDeviceKind } from "./cloud-types";

export type OtherDevice = { deviceId?: string | null; deviceKind?: VaultDeviceKind | null };

export function otherDeviceLabel(device: OtherDevice | null | undefined): string {
  switch (device?.deviceKind) {
    case "mac":
      return "別の Mac";
    case "browser":
      return "PC のブラウザ";
    case "phone":
      return "スマホ";
    default:
      break;
  }
  const deviceId = device?.deviceId ?? "";
  if (deviceId.startsWith("pwa_")) return "ブラウザ";
  if (deviceId.startsWith("d_")) return "別の Mac";
  return "別の端末";
}

/** 呼び名に続ける。英字で終わる呼び名（「別の Mac」）の後ろだけ半角の空白を入れる。 */
export function withDeviceLabel(label: string, rest: string): string {
  return /[A-Za-z]$/.test(label) ? `${label} ${rest}` : `${label}${rest}`;
}

/** 取り込みを待っている版の知らせ（「スマホで更新されています。」）。 */
export function updatedOnDeviceText(device: OtherDevice | null | undefined): string {
  return withDeviceLabel(otherDeviceLabel(device), "で更新されています。");
}

/** 両方で変わった版の知らせ（「スマホでも変更されています。」）。 */
export function changedOnDeviceText(device: OtherDevice | null | undefined): string {
  return withDeviceLabel(otherDeviceLabel(device), "でも変更されています。");
}
