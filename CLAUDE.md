# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start Vite dev server (requires COOP/COEP headers for XMTP WASM)
- `npm run build` — Type-check with tsc, then bundle with Vite
- `npm test` — Run `tsc --noEmit` (type-checking only, no test framework)
- `npm run preview` — Preview the production build locally

## Architecture

[SealedCall](https://sealedcall.com/) is an E2E encrypted peer-to-peer video calling app. React frontend (single `App.tsx` component), no backend server.

**Three-layer encryption:**

1. XMTP MLS encrypts all signaling (SDP, ICE candidates)
2. DTLS-SRTP encrypts media transport
3. Encoded Transform API (AES-128-GCM via `RTCRtpScriptTransform`) encrypts every audio/video frame on top of DTLS-SRTP

**Data flow:**

- `App.tsx` orchestrates UI state and wires together signaling + WebRTC
- `XmtpSignaling` — connects to XMTP network, sends/receives messages via DM conversations using a custom content type codec (`SignalingCodec`)
- `WebRTCManager` — manages `RTCPeerConnection` lifecycle: creates offers/answers, handles ICE candidates, applies E2E encryption transforms
- `E2EEncryption` — generates AES-128-GCM keys, creates inline Web Workers for `RTCRtpScriptTransform` to encrypt sender frames and decrypt receiver frames
- `SignalingMessage` — discriminated union of all signaling message types (`offer`, `answer`, `ice-candidate`, `hangup`, `mute-status`, `media-stream-encryption-key`)

**Key pattern:** Signaling messages are a discriminated union on `type`. When adding a new message type, update `SignalingMessage` (type), `SignalingCodec` (type guard), and `WebRTCManager.handleSignalingMessage` (switch case).

**XMTP SDK workaround:** In `XmtpSignaling.connect()`, the `codecs` option is set as non-enumerable to avoid structured clone errors when the SDK posts options to a Web Worker.

## Vite Configuration

- XMTP WASM bindings (`@xmtp/wasm-bindings`, `@xmtp/browser-sdk`) are excluded from `optimizeDeps` to avoid bundling issues
- `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` headers are required for SharedArrayBuffer (XMTP WASM)
- `__COMMIT_HASH__` is a compile-time define from `git rev-parse --short HEAD`

## Deployment

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml` (Node 22, `npm ci && npm run build`, deploys `dist/`).
