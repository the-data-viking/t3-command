// Push notifications on this device: the service worker, the subscription with the Command
// server, and the server's rules (which events, quiet hours).

import type { DeviceKinds, PushRules } from "../../shared/push";
import { DEMO } from "../demo";
import { fetchJson } from "./environment";

export interface PushStatus {
  publicKey: string;
  devices: Array<{ label: string; addedAt: number; endpoint: string; kinds: DeviceKinds }>;
  rules: PushRules;
}

/** Can this browser receive push at all (service workers, Push API, a secure page)? */
export function pushSupported(): boolean {
  return !DEMO && typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iOS only delivers web push to an app added to the Home Screen and opened from there. */
export function needsHomeScreen(): boolean {
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

/** Register the service worker once (it shows pushes and opens the app at the right crew). */
export function registerServiceWorker(): void {
  if (!pushSupported()) return;
  navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("[push] service worker", err));
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function pushStatus(): Promise<PushStatus> {
  return fetchJson<PushStatus>("/api/push");
}

/** This device's current push subscription endpoint, if subscribed. */
export async function currentEndpoint(): Promise<string | undefined> {
  if (!pushSupported()) return undefined;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription())?.endpoint;
}

/** Ask permission, subscribe this device, and register it with the Command server. */
export async function enablePush(label: string): Promise<PushStatus> {
  if (!pushSupported()) throw new Error("This browser can't receive push notifications.");
  if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked for this site.");
  const { publicKey } = await pushStatus();
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return fetchJson<PushStatus>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON(), label }) });
}

export async function disablePush(): Promise<PushStatus> {
  const reg = await navigator.serviceWorker.getRegistration();
  const subscription = await reg?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint;
  await subscription?.unsubscribe();
  return fetchJson<PushStatus>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
}

export async function testPush(endpoint?: string): Promise<number> {
  return (await fetchJson<{ sent: number }>("/api/push/test", { method: "POST", body: JSON.stringify({ endpoint }) })).sent;
}

/** One device's own filter: only these kinds, or null for everything the fleet's rules allow. */
export async function saveDeviceKinds(endpoint: string, kinds: DeviceKinds): Promise<PushStatus> {
  return fetchJson<PushStatus>("/api/push/device", { method: "PUT", body: JSON.stringify({ endpoint, kinds }) });
}

/** Stop pushing to a device (another one, say an old phone): it's removed from the server's list. */
export async function forgetDevice(endpoint: string): Promise<PushStatus> {
  return fetchJson<PushStatus>("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
}

export async function saveRules(rules: PushRules): Promise<PushStatus> {
  return fetchJson<PushStatus>("/api/push/rules", { method: "PUT", body: JSON.stringify({ rules }) });
}

/** A label for this device in the server's list ("iPhone · Safari"). */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${device} · ${browser}`;
}
