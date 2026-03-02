# XMTP × WebRTC — E2EE Video Calls

End-to-end encrypted video calls where the **signaling itself** is encrypted via XMTP's decentralized messaging protocol.

**How to connect two people:**

1. **Person 1 (Caller):** Opens the page, starts camera, clicks "Generate Offer", copies the offer text
2. **Sends** the offer to Person 2 via any channel (chat, email, etc.)
3. **Person 2 (Callee):** Opens the page, selects the "Callee" tab, starts camera, pastes the offer, clicks "Accept Offer", then copies the generated answer
4. **Sends** the answer back to Person 1
5. **Person 1:** Pastes the answer, clicks "Connect" — the call begins

**Encryption layers:**

- **DTLS-SRTP** — WebRTC's mandatory transport encryption (always active, encrypts all media in transit)
- **Insertable Streams** — an additional E2EE layer applied on top using the browser's Encoded Transform API (supported in Chrome/Edge), ensuring media is encrypted before it even reaches the WebRTC transport layer

## Architecture

```
Person A (Wallet)                              Person B (Wallet)
     │                                              │
     ├── Connect MetaMask ──────────────────── Connect MetaMask ──┤
     ├── Create XMTP Client ───────────── Create XMTP Client ────┤
     │                                              │
     │   ┌─────────── XMTP Network (E2EE) ───────┐ │
     ├──►│  SDP Offer  ─────────────────────────► │─┤
     ├──◄│  SDP Answer ◄───────────────────────── │─┤
     ├──►│  ICE Candidates ◄──────────────────►   │─┤
     │   └────────────────────────────────────────┘ │
     │                                              │
     ├── WebRTC Peer Connection (DTLS-SRTP) ────────┤
     │   Encrypted audio/video stream               │
     └──────────────────────────────────────────────┘
```

### Encryption Layers

1. **XMTP MLS** — All signaling messages (SDP offers, answers, ICE candidates) are encrypted end-to-end using XMTP's Messaging Layer Security protocol. No server can read them.
2. **DTLS-SRTP** — WebRTC's mandatory transport encryption protects all media (audio/video) in transit.
3. **No central signaling server** — Unlike typical WebRTC apps, there is no WebSocket server that could be compromised. XMTP's decentralized network replaces it entirely.

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **MetaMask** browser extension (or any Ethereum wallet with browser injection)
- Two browser windows/devices with separate MetaMask accounts

## Setup

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

> **Important:** The Vite dev server is configured with the required `Cross-Origin-Embedder-Policy` and `Cross-Origin-Opener-Policy` headers that the XMTP Browser SDK needs for SharedArrayBuffer/WASM support.

## How to Make a Call

### Person A (Caller)
1. Open the app in Chrome/Firefox
2. Click **Connect Wallet** → approve in MetaMask
3. Wait for "XMTP online" status
4. Click **Start Camera** → allow camera/mic
5. Enter Person B's Ethereum address
6. Click **Call Peer**

### Person B (Callee)
1. Open the app in a separate browser/profile/device
2. Click **Connect Wallet** with a different MetaMask account
3. Wait for "XMTP online" status
4. Click **Start Camera**
5. Enter Person A's Ethereum address (so they can receive the answer)
6. The incoming call is automatically detected via XMTP stream

The WebRTC connection will be established through XMTP's E2EE messaging channel.

## Project Structure

```
src/
├── main.tsx              # React entry point
├── App.tsx               # Main UI component
├── styles.css            # Styles
├── xmtp-signaling.ts     # XMTP signaling layer
└── webrtc-manager.ts     # WebRTC peer connection manager
```

## Key Files

### `xmtp-signaling.ts`
Wraps the XMTP Browser SDK to provide a signaling channel for WebRTC. Handles:
- Wallet-to-XMTP-signer conversion
- Client creation and connection
- Sending/receiving signaling messages as XMTP DMs
- Streaming incoming messages

### `webrtc-manager.ts`
Manages the RTCPeerConnection lifecycle. Handles:
- Creating offers/answers
- ICE candidate exchange (via XMTP)
- Connection state tracking
- Cleanup on hangup

## XMTP Environment

By default, this app connects to the XMTP **dev** network. To use production:

```ts
// In xmtp-signaling.ts, change:
const id = await signaling.connect(xmtpSigner, "production");
```

## Limitations

- The XMTP Browser SDK is currently in **alpha** — expect breaking changes
- Both parties must have registered on XMTP before they can exchange messages
- Only one browser tab can use the XMTP Browser SDK at a time (OPFS limitation)
- STUN servers (Google) are used for NAT traversal — they see IP addresses but not media content

## License

MIT
