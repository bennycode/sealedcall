/**
 * End-to-end encryption for WebRTC media frames using the Encoded Transform API
 * (RTCRtpScriptTransform) with AES-128-GCM.
 *
 * @see https://blog.mozilla.org/webrtc/end-to-end-encrypt-webrtc-in-all-browsers/
 */

const ALGORITHM = "AES-GCM" as const;
const KEY_LENGTH = 128;
const IV_LENGTH = 12;

export function isE2ESupported(): boolean {
  return typeof RTCRtpScriptTransform !== "undefined";
}

export async function generateEncryptionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

export async function importKey(encoded: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: ALGORITHM }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// Inline worker source that performs frame encryption/decryption inside an
// RTCRtpScriptTransform. The key and mode are transferred via the transform's
// options and a MessagePort.
const workerSource = /* js */ `
"use strict";

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;

let cryptoKey = null;
let frameCounter = 0;

async function importKey(rawKeyBase64) {
  const raw = Uint8Array.from(atob(rawKeyBase64), c => c.charCodeAt(0));
  cryptoKey = await crypto.subtle.importKey(
    "raw", raw, { name: ALGORITHM }, false, ["encrypt", "decrypt"]
  );
}

function buildIv(counter) {
  const iv = new ArrayBuffer(IV_LENGTH);
  const view = new DataView(iv);
  // Write counter into the last 4 bytes (big-endian)
  view.setUint32(IV_LENGTH - 4, counter);
  return iv;
}

async function encryptFrame(frame, controller) {
  if (!cryptoKey) { controller.enqueue(frame); return; }

  const data = new Uint8Array(frame.data);
  const iv = buildIv(frameCounter++);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    data,
  );

  const output = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  output.set(new Uint8Array(iv), 0);
  output.set(new Uint8Array(ciphertext), IV_LENGTH);

  frame.data = output.buffer;
  controller.enqueue(frame);
}

async function decryptFrame(frame, controller) {
  if (!cryptoKey) { controller.enqueue(frame); return; }

  const data = new Uint8Array(frame.data);
  if (data.byteLength < IV_LENGTH) { controller.enqueue(frame); return; }

  const iv = data.slice(0, IV_LENGTH).buffer;
  const ciphertext = data.slice(IV_LENGTH).buffer;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      cryptoKey,
      ciphertext,
    );
    frame.data = plaintext;
  } catch {
    // Decryption failed — pass frame through (will likely cause a decode error
    // which is preferable to silently dropping frames)
  }
  controller.enqueue(frame);
}

// Listen for the key via MessagePort (sent from the main thread)
self.addEventListener("message", async (e) => {
  if (e.data && e.data.type === "key") {
    await importKey(e.data.key);
  }
});

// Handle RTCRtpScriptTransform
self.addEventListener("rtctransform", (e) => {
  const { readable, writable } = e.transformer;
  const mode = e.transformer.options.mode;

  const transform = new TransformStream({
    transform: mode === "encrypt" ? encryptFrame : decryptFrame,
  });

  readable.pipeThrough(transform).pipeTo(writable);
});
`;

let workerBlobUrl: string | null = null;

function getWorkerUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([workerSource], { type: "application/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

function createTransformWorker(
  mode: "encrypt" | "decrypt",
  keyBase64: string,
): RTCRtpScriptTransform {
  const worker = new Worker(getWorkerUrl(), { name: `e2ee-${mode}` });
  worker.postMessage({ type: "key", key: keyBase64 });
  return new RTCRtpScriptTransform(worker, { mode });
}

export function applySenderTransforms(
  pc: RTCPeerConnection,
  keyBase64: string,
): void {
  for (const sender of pc.getSenders()) {
    if (sender.track) {
      sender.transform = createTransformWorker("encrypt", keyBase64);
    }
  }
}

export function applyReceiverTransform(
  receiver: RTCRtpReceiver,
  keyBase64: string,
): void {
  receiver.transform = createTransformWorker("decrypt", keyBase64);
}
