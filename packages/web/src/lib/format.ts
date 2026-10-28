import { formatUnits, zeroAddress } from "viem";

export function short(addr: string, chars = 4): string {
  if (!addr) return "";
  return `${addr.slice(0, 2 + chars)}…${addr.slice(-chars)}`;
}

export function formatAmount(amount: string | bigint, token: string): string {
  const value = formatUnits(BigInt(amount), 18);
  const trimmed = value.includes(".") ? value.replace(/\.?0+$/, "") : value;
  return token.toLowerCase() === zeroAddress ? `${trimmed} ETH` : `${trimmed} ${short(token)}`;
}

export function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

export function relativeDeadline(unix: number, now = Date.now() / 1000): string {
  const diff = unix - now;
  const abs = Math.abs(diff);
  const unit = abs < 3600 ? [60, "m"] : abs < 86400 ? [3600, "h"] : [86400, "d"];
  const n = Math.max(1, Math.round(abs / (unit[0] as number)));
  return diff >= 0 ? `in ${n}${unit[1]}` : `${n}${unit[1]} ago`;
}

export function errorText(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { shortMessage?: string; message?: string; cause?: { shortMessage?: string } };
    return anyE.shortMessage ?? anyE.cause?.shortMessage ?? anyE.message ?? String(e);
  }
  return String(e);
}
