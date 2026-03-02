import { useState, useRef, useCallback, useEffect } from "react";
import { Wallet } from "ethers";
import { XmtpSignaling, createXmtpSigner } from "./xmtp-signaling";
import { WebRTCManager, type ConnectionState } from "./webrtc-manager";

// ── Types ────────────────────────────────────────────────────────────

interface LogEntry {
  time: string;
  message: string;
  type?: "ok" | "warn" | "err";
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  // Wallet & XMTP
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [xmtpConnected, setXmtpConnected] = useState(false);
  const [inboxId, setInboxId] = useState<string>("");

  // Call
  const [peerAddress, setPeerAddress] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [cameraActive, setCameraActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<XmtpSignaling | null>(null);
  const rtcRef = useRef<WebRTCManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // ── Logging ──────────────────────────────────────────────────────

  const log = useCallback((message: string, type?: "ok" | "warn" | "err") => {
    const time = new Date().toLocaleTimeString("en", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLogs((prev) => [...prev.slice(-100), { time, message, type }]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logBoxRef.current?.scrollTo(0, logBoxRef.current.scrollHeight);
  }, [logs]);

  // ── 1. Connect Wallet ──────────────────────────────────────────

  const connectWithSigner = useCallback(async (address: string, signMessage: (msg: string) => Promise<string>) => {
    try {
      setWalletAddress(address);
      log(`Wallet connected: ${address.slice(0, 8)}…${address.slice(-6)}`, "ok");

      // Create XMTP signer and connect
      log("Connecting to XMTP network (dev)...");
      const signaling = new XmtpSignaling();
      const xmtpSigner = createXmtpSigner({
        address,
        signMessage,
      });

      const id = await signaling.connect(xmtpSigner, "dev");
      signalingRef.current = signaling;
      setInboxId(id);
      setXmtpConnected(true);
      log(`XMTP connected — inbox: ${id.slice(0, 12)}…`, "ok");

      // Start listening for incoming signaling messages
      await signaling.startListening((msg, senderInboxId) => {
        log(`Received ${msg.type} via XMTP from ${senderInboxId.slice(0, 12)}…`, "ok");
        // Auto-set peer address for incoming calls so replies go back to the caller
        if (rtcRef.current && !rtcRef.current.isActive()) {
          rtcRef.current.setPeerAddress(senderInboxId);
        }
        rtcRef.current?.handleSignalingMessage(msg);
      });
      log("Listening for incoming calls via XMTP...", "ok");
    } catch (err: any) {
      log(`Connection failed: ${err.message}`, "err");
    }
  }, [log]);

  const connectEphemeral = useCallback(async () => {
    log("Generating ephemeral EOA wallet...");
    const wallet = Wallet.createRandom();
    const address = wallet.address;
    log(`Ephemeral wallet: ${address.slice(0, 8)}…${address.slice(-6)}`, "ok");
    await connectWithSigner(address, (msg: string) => wallet.signMessage(msg));
  }, [connectWithSigner, log]);

  // ── 2. Start Camera ─────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setCameraActive(true);
      log("Camera & microphone active", "ok");

      // Set up WebRTC manager
      const rtc = new WebRTCManager(signalingRef.current!, {
        onRemoteStream: (remoteStream) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            remoteVideoRef.current.play().catch(() => {});
          }
        },
        onConnectionStateChange: (state) => setConnectionState(state),
        onLog: log,
      });
      rtc.setLocalStream(stream);
      rtcRef.current = rtc;
    } catch (err: any) {
      log(`Camera failed: ${err.message}`, "err");
    }
  }, [log]);

  // ── 3. Call Peer ─────────────────────────────────────────────────

  const callPeer = useCallback(async () => {
    if (!peerAddress || !rtcRef.current) return;
    rtcRef.current.setPeerAddress(peerAddress);
    try {
      await rtcRef.current.call();
    } catch (err: any) {
      log(`Call failed: ${err.message}`, "err");
      setConnectionState("failed");
    }
  }, [peerAddress, log]);

  // ── 4. Hang Up ──────────────────────────────────────────────────

  const hangUp = useCallback(() => {
    rtcRef.current?.hangUp();
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnectionState("idle");
  }, []);

  // ── 5. Toggle Mute ──────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const enabled = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = !enabled));
    setIsMuted(enabled);
    log(enabled ? "Microphone muted" : "Microphone unmuted");
  }, [isMuted, log]);

  // ── Update peer address on the RTC manager ──────────────────────

  useEffect(() => {
    if (rtcRef.current && peerAddress) {
      rtcRef.current.setPeerAddress(peerAddress);
    }
  }, [peerAddress]);

  // ── Render ──────────────────────────────────────────────────────

  const stateColor = (state: ConnectionState) => {
    if (state === "connected") return "var(--green)";
    if (state === "connecting") return "var(--yellow)";
    if (state === "failed" || state === "disconnected") return "var(--red)";
    return "var(--dim)";
  };

  return (
    <div className="app">
      {/* ── Header ── */}
      <header>
        <div className="logo">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>
        <div>
          <h1>
            XMTP <span className="accent">×</span> WebRTC
          </h1>
          <p className="subtitle">End-to-end encrypted video calls over decentralized messaging</p>
        </div>
        <div className="badge-row">
          <span className="badge green">E2EE</span>
          <span className="badge purple">XMTP Signaling</span>
          <span className="badge blue">WebRTC</span>
        </div>
      </header>

      {/* ── Status Bar ── */}
      <div className="status-bar">
        <div className="chip">
          <span className={`dot ${walletAddress ? "green" : ""}`} />
          {walletAddress
            ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
            : "Wallet disconnected"}
        </div>
        <div className="chip">
          <span className={`dot ${xmtpConnected ? "green" : ""}`} />
          {xmtpConnected ? "XMTP online" : "XMTP offline"}
        </div>
        <div className="chip">
          <span className={`dot ${cameraActive ? "green" : ""}`} />
          {cameraActive ? "Camera on" : "Camera off"}
        </div>
        <div className="chip">
          <span
            className={`dot ${connectionState === "connected" ? "green" : connectionState === "connecting" ? "yellow pulse" : connectionState === "failed" ? "red" : ""}`}
          />
          {connectionState === "idle" ? "No call" : connectionState}
        </div>
      </div>

      {/* ── Video Grid ── */}
      <div className="videos">
        <div className="video-box">
          <video ref={localVideoRef} autoPlay muted playsInline />
          {!cameraActive && (
            <div className="placeholder">
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" />
              </svg>
              You
            </div>
          )}
          <span className="video-label">Local</span>
          {connectionState === "connected" && <span className="e2ee-tag">🔒 E2EE</span>}
        </div>

        <div className="video-box">
          <video ref={remoteVideoRef} autoPlay playsInline />
          {connectionState !== "connected" && (
            <div className="placeholder">
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                <path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" />
              </svg>
              Peer
            </div>
          )}
          <span className="video-label">Remote</span>
          {connectionState === "connected" && <span className="e2ee-tag">🔒 E2EE</span>}
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="controls">
        {!walletAddress ? (
          <button className="btn primary" onClick={connectEphemeral}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Connect Wallet
          </button>
        ) : !cameraActive ? (
          <button className="btn primary" onClick={startCamera}>
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="m15.75 10.5 4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Start Camera
          </button>
        ) : (
          <>
            <button className="btn" onClick={toggleMute}>
              {isMuted ? "🔇 Unmute" : "🎙 Mute"}
            </button>
            {connectionState === "connected" ? (
              <button className="btn danger" onClick={hangUp}>
                ✕ Hang Up
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={callPeer}
                disabled={!peerAddress || connectionState === "connecting"}
              >
                📞 Call Peer
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Peer Address Input ── */}
      {xmtpConnected && (
        <div className="panel">
          <h3>
            <span className="step">1</span> Enter peer's address or inbox ID
          </h3>
          <p className="hint">
            The other person must also connect their wallet and be online with XMTP.
            Share your inbox ID with them so they can call you too.
          </p>
          <input
            type="text"
            placeholder="0x… or inbox ID"
            value={peerAddress}
            onChange={(e) => setPeerAddress(e.target.value)}
            className="input"
          />
          {inboxId && (
            <p className="hint" style={{ marginTop: 8 }}>
              Your XMTP inbox: <code>{inboxId}</code>{" "}
              <button
                className="btn-copy"
                onClick={() => { navigator.clipboard.writeText(inboxId); }}
                title="Copy to clipboard"
              >
                📋
              </button>
            </p>
          )}
        </div>
      )}

      {/* ── Encryption Info ── */}
      {connectionState === "connected" && (
        <div className="panel">
          <h4 className="panel-title">🔐 Encryption Details</h4>
          <div className="info-grid">
            <div className="info-item">
              <span className="label">Signaling</span>
              <span className="value green">XMTP MLS (E2EE)</span>
            </div>
            <div className="info-item">
              <span className="label">Media Transport</span>
              <span className="value green">DTLS-SRTP</span>
            </div>
            <div className="info-item">
              <span className="label">Key Exchange</span>
              <span className="value green">ECDHE (ephemeral)</span>
            </div>
            <div className="info-item">
              <span className="label">Signaling Server</span>
              <span className="value green">None (decentralized)</span>
            </div>
          </div>
        </div>
      )}

      {/* ── How It Works ── */}
      {!xmtpConnected && (
        <div className="panel">
          <h4 className="panel-title">How it works</h4>
          <div className="how-it-works">
            <div className="step-card">
              <span className="step">1</span>
              <div>
                <strong>Connect wallet</strong>
                <p>Use an ephemeral wallet or sign in with MetaMask</p>
              </div>
            </div>
            <div className="step-card">
              <span className="step">2</span>
              <div>
                <strong>Share addresses</strong>
                <p>Exchange Ethereum addresses with the person you want to call</p>
              </div>
            </div>
            <div className="step-card">
              <span className="step">3</span>
              <div>
                <strong>Call</strong>
                <p>WebRTC offer/answer is exchanged over XMTP's E2EE messaging layer</p>
              </div>
            </div>
            <div className="step-card">
              <span className="step">4</span>
              <div>
                <strong>Talk securely</strong>
                <p>Video & audio are encrypted end-to-end with no central server</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Log ── */}
      <div className="log-box">
        <div className="log-header">
          <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3M3.375 3h17.25c.621 0 1.125.504 1.125 1.125v15.75c0 .621-.504 1.125-1.125 1.125H3.375c-.621 0-1.125-.504-1.125-1.125V4.125C2.25 3.504 2.754 3 3.375 3z" />
          </svg>
          Event Log
        </div>
        <div className="log-content" ref={logBoxRef}>
          {logs.map((entry, i) => (
            <div key={i} className="log-entry">
              <span className="log-time">{entry.time}</span>
              <span className={`log-msg ${entry.type || ""}`}>{entry.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="log-entry">
              <span className="log-time">--:--:--</span>
              <span className="log-msg">Connect your wallet to begin</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
