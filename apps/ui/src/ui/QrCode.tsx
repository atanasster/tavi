import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { encode } from "uqr";

import { copyText } from "../lib/clipboard.js";
import { Button } from "./Button.js";

/** Formats an 8-character pairing code as `XXXX-XXXX`. */
export function shownPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Formats the sender who claimed a pairing code (`senderName (sender)` when a name is present). */
export function claimedSenderLabel(status: { readonly sender?: string; readonly senderName?: string }): string {
  if (status.sender === undefined) return "";
  return status.senderName === undefined ? status.sender : `${status.senderName} (${status.sender})`;
}

/**
 * The deep link a pairing opens the channel's chat with, the code handed over: the owner builds it from the channel's
 * reviewed `pairing` template. Only an https address is shown; anything else is no link.
 */
export function pairingDeepLink(pairing: { readonly linkUrl?: string }): string | undefined {
  if (pairing.linkUrl === undefined) return undefined;
  try {
    const parsed = new URL(pairing.linkUrl);
    return parsed.protocol === "https:" && parsed.hostname !== "" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SVG path of a QR code's dark modules, one unit square each on a `size`-unit grid (the quiet
 * zone included). Kept apart from the component so a test can hold it to the encoder.
 */
export function qrCodePath(value: string): { path: string; size: number } {
  // M: still reads with a smudged or angled phone screen, and a short deep link stays a small code.
  const { data, size } = encode(value, { ecc: "M", border: 2 });
  let path = "";
  for (const [y, row] of data.entries()) for (const [x, dark] of row.entries()) if (dark) path += `M${String(x)} ${String(y)}h1v1h-1z`;
  return { path, size };
}

/**
 * A QR code a phone's camera opens, drawn here rather than by the library: one path, black on
 * white in either theme — a scanner needs dark modules on a light ground, which `currentColor`
 * on a dark card would invert.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  readonly value: string;
  /** What scanning it does, for a reader who cannot see it. */
  readonly label: string;
  readonly className?: string;
}) {
  const { path, size } = useMemo(() => qrCodePath(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className={["qr-code", className].filter(Boolean).join(" ")}
    >
      <path d={path} className="qr-code-ink" />
    </svg>
  );
}

/**
 * Copies a pairing command (such as `/link XXXX-XXXX`), for a reader who will
 * paste it into Telegram on another device. When the browser refuses clipboard
 * access, it selects the command element so keyboard copy takes it, and says so.
 */
export function CopyCommand({
  text,
  target,
  label = "Copy /link command",
}: {
  readonly text: string;
  readonly target: RefObject<HTMLElement | null>;
  readonly label?: string;
}) {
  const [outcome, setOutcome] = useState<"copied" | "selected" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const select = (): void => {
    if (target.current !== null && typeof window.getSelection === "function") {
      window.getSelection()?.selectAllChildren(target.current);
    }
    setOutcome("selected");
  };
  const refusedMessage = "Clipboard access was refused; the command is selected so you can copy it.";
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void copyText(text).then((copied) => {
            window.clearTimeout(timer.current);
            if (copied) {
              setOutcome("copied");
              timer.current = window.setTimeout(() => setOutcome(null), 2_000);
            } else {
              select();
            }
          });
        }}
      >
        {outcome === "copied" ? "Copied" : label}
      </Button>
      <span role="status" className="visually-hidden">
        {outcome === "copied" ? "Copied to clipboard" : outcome === "selected" ? refusedMessage : ""}
      </span>
      {outcome === "selected" ? <p className="settings-description">{refusedMessage}</p> : null}
    </>
  );
}

/**
 * Shared pairing box showing the QR code (when the channel has a deep link),
 * the `/link XXXX-XXXX` command with a Copy button, and the link in the channel's words ("Open in Telegram").
 */
export function PairingLinkBox({
  pairing,
  channelLabel,
}: {
  readonly pairing: { readonly code: string; readonly linkUrl?: string; readonly openLabel?: string };
  readonly channelLabel: string;
}) {
  const commandRef = useRef<HTMLElement>(null);
  const code = shownPairingCode(pairing.code);
  const command = `/link ${code}`;
  const deepLink = pairingDeepLink(pairing);
  return (
    <div className="pairing-layout">
      {deepLink === undefined ? null : <QrCode value={deepLink} label={`QR code to link on ${channelLabel}`} />}
      <div className="pairing-details">
        <div className="pairing-command">
          <code ref={commandRef}>{command}</code>
          <CopyCommand key={command} text={command} target={commandRef} />
        </div>
        {deepLink === undefined ? null : (
          <div className="pairing-links">
            <a href={deepLink} target="_blank" rel="noopener noreferrer">
              {pairing.openLabel ?? `Open in ${channelLabel}`}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
