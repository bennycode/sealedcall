import { useState, useRef, useCallback, useEffect } from "react";
import { Wallet } from "ethers";
import { XmtpSignaling } from "./XmtpSignaling";
import { createXmtpSigner } from "./createXmtpSigner";
import { WebRTCManager } from "./WebRTCManager";
import type { ConnectionState } from "./ConnectionState";
import type { LogLevel } from "./LogLevel";

type LogEntry = {
  readonly time: string;
  readonly message: string;
  readonly type?: LogLevel;
};

export default function App() {
  const [walletAddress, setWalletAddress] = useState("");
  const [xmtpConnected, setXmtpConnected] = useState(false);
  const [inboxId, setInboxId] = useState("");

  const [peerAddress, setPeerAddress] = useState(
    () => new URLSearchParams(window.location.search).get("partner") ?? "",
  );
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [cameraActive, setCameraActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const requestFullscreen = useCallback((ref: React.RefObject<HTMLVideoElement | null>) => {
    ref.current?.requestFullscreen();
  }, []);

  const [logs, setLogs] = useState<readonly LogEntry[]>([]);
  const [copiedLink, setCopiedLink] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const signalingRef = useRef<XmtpSignaling | null>(null);
  const rtcRef = useRef<WebRTCManager | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const log = useCallback((message: string, type?: LogLevel) => {
    const time = new Date().toLocaleTimeString("en", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setLogs((prev) => [...prev.slice(-100), { time, message, type }]);
  }, []);

  useEffect(() => {
    logBoxRef.current?.scrollTo(0, logBoxRef.current.scrollHeight);
  }, [logs]);

  const connectWithSigner = useCallback(
    async (address: string, signMessage: (msg: string) => Promise<string>) => {
      try {
        setWalletAddress(address);
        log(`Connected`, "ok");

        log("Connecting to secure network...");
        const signaling = new XmtpSignaling();
        const xmtpSigner = createXmtpSigner({ address, signMessage });

        const id = await signaling.connect(xmtpSigner, "dev");
        signalingRef.current = signaling;
        setInboxId(id);
        setXmtpConnected(true);
        log(`Ready — your ID: ${id.slice(0, 12)}...`, "ok");

        await signaling.startListening((msg, senderInboxId) => {
          log(`Incoming signal from ${senderInboxId.slice(0, 8)}...`, "ok");
          if (rtcRef.current && !rtcRef.current.isActive()) {
            rtcRef.current.setPeerAddress(senderInboxId);
          }
          rtcRef.current?.handleSignalingMessage(msg);
        });
        log("Ready for calls", "ok");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Connection failed: ${message}`, "err");
      }
    },
    [log],
  );

  const connectEphemeral = useCallback(async () => {
    log("Setting up...");
    const wallet = Wallet.createRandom();
    const { address } = wallet;
    log("XMTP Account created", "ok");
    await connectWithSigner(address, (msg) => wallet.signMessage(msg));
  }, [connectWithSigner, log]);

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

      const rtc = new WebRTCManager(signalingRef.current!, {
        onRemoteStream: (remoteStream) => {
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            remoteVideoRef.current.play().catch(() => {});
          }
        },
        onConnectionStateChange: setConnectionState,
        onLog: log,
      });
      rtc.setLocalStream(stream);
      rtcRef.current = rtc;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Camera failed: ${message}`, "err");
    }
  }, [log]);

  const callPeer = useCallback(async () => {
    if (!peerAddress || !rtcRef.current) return;
    rtcRef.current.setPeerAddress(peerAddress);
    try {
      await rtcRef.current.call();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Call failed: ${message}`, "err");
      setConnectionState("failed");
    }
  }, [peerAddress, log]);

  const hangUp = useCallback(() => {
    rtcRef.current?.hangUp();
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setConnectionState("idle");
  }, []);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const shouldMute = !isMuted;
    for (const track of localStreamRef.current.getAudioTracks()) {
      track.enabled = !shouldMute;
    }
    setIsMuted(shouldMute);
    log(shouldMute ? "Microphone muted" : "Microphone unmuted");
  }, [isMuted, log]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const shouldHide = !isVideoOff;
    for (const track of localStreamRef.current.getVideoTracks()) {
      track.enabled = !shouldHide;
    }
    setIsVideoOff(shouldHide);
    log(shouldHide ? "Camera off" : "Camera on");
  }, [isVideoOff, log]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      // Revert to camera
      const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
      if (cameraTrack) {
        const sender = rtcRef.current?.getVideoSender();
        await sender?.replaceTrack(cameraTrack);
        if (localVideoRef.current && localStreamRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }
      }
      setIsScreenSharing(false);
      log("Screen sharing stopped");
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      const sender = rtcRef.current?.getVideoSender();
      await sender?.replaceTrack(screenTrack ?? null);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      screenTrack.onended = () => {
        // User stopped sharing via browser UI
        const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
        if (cameraTrack) {
          void sender?.replaceTrack(cameraTrack);
          if (localVideoRef.current && localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
        }
        setIsScreenSharing(false);
        log("Screen sharing stopped");
      };

      setIsScreenSharing(true);
      log("Screen sharing started", "ok");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Screen share failed: ${message}`, "err");
    }
  }, [isScreenSharing, log]);

  useEffect(() => {
    if (rtcRef.current && peerAddress) {
      rtcRef.current.setPeerAddress(peerAddress);
    }
  }, [peerAddress]);

  // Auto-connect flow when opened via partner invite link
  useEffect(() => {
    if (!peerAddress || walletAddress) return;
    void connectEphemeral();
  }, [peerAddress, walletAddress, connectEphemeral]);

  useEffect(() => {
    if (!peerAddress || !xmtpConnected || cameraActive) return;
    void startCamera();
  }, [peerAddress, xmtpConnected, cameraActive, startCamera]);

  useEffect(() => {
    if (!peerAddress || !cameraActive || connectionState !== "idle") return;
    void callPeer();
  }, [peerAddress, cameraActive, connectionState, callPeer]);

  return (
    <div className="app">
      {/* Header */}
      <header>
        <div className="logo">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </div>
        <div>
          <h1>SealedCall.com</h1>
          <p className="subtitle">
            Private, encrypted video calls secured by{" "}
            <a
              href="https://xmtp.org"
              target="_blank"
              rel="noopener noreferrer"
            >
              XMTP
            </a>
            .
          </p>
        </div>
      </header>

      {/* Video Grid */}
      <div className="videos">
        <div className="video-box">
          <video ref={localVideoRef} autoPlay muted playsInline />
          <button
            className="fullscreen-btn"
            onClick={() => requestFullscreen(localVideoRef)}
            title="Fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          </button>
          {!cameraActive && (
            <div className="placeholder">
              <svg
                width="40"
                height="40"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" />
              </svg>
              You
            </div>
          )}
          {connectionState === "connected" && (
            <span className="e2ee-tag">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              Encrypted
            </span>
          )}
        </div>

        <div className="video-box">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <button
            className="fullscreen-btn"
            onClick={() => requestFullscreen(remoteVideoRef)}
            title="Fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          </button>
          {connectionState !== "connected" && (
            <div className="placeholder">
              <svg
                width="40"
                height="40"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" />
              </svg>
              Waiting...
            </div>
          )}
          {connectionState === "connected" && (
            <span className="e2ee-tag">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              Encrypted
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="controls">
        {!walletAddress ? (
          <button className="btn primary" onClick={connectEphemeral}>
            Start Call
          </button>
        ) : !cameraActive ? (
          <button className="btn primary" onClick={startCamera}>
            <svg
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="m15.75 10.5 4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Start Camera
          </button>
        ) : (
          <>
            <button className="btn" onClick={toggleMute}>
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button className="btn" onClick={toggleVideo}>
              {isVideoOff ? "Show Video" : "Hide Video"}
            </button>
            <button className={`btn${isScreenSharing ? " active" : ""}`} onClick={toggleScreenShare}>
              {isScreenSharing ? "Stop Sharing" : "Share Screen"}
            </button>
            {connectionState === "connected" ? (
              <button className="btn danger" onClick={hangUp}>
                End Call
              </button>
            ) : (
              <button
                className="btn primary"
                onClick={callPeer}
                disabled={!peerAddress || connectionState === "connecting"}
              >
                Call
              </button>
            )}
          </>
        )}
      </div>

      {/* Invite */}
      {xmtpConnected && inboxId && (
        <div className="panel">
          <h3>Invite someone to call</h3>
          <p className="hint">
            Copy your invite link and send it to the person who should join your
            call.
          </p>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <button
              className="btn primary"
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.set("partner", inboxId);
                void navigator.clipboard.writeText(url.toString());
                setCopiedLink(true);
                setTimeout(() => setCopiedLink(false), 2000);
              }}
            >
              {copiedLink ? "Copied!" : "Copy invite link"}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            They'll open the link and connect to you directly.
          </p>
        </div>
      )}

      {/* Onboarding */}
      {!walletAddress && (
        <div className="panel">
          <h3>Private video calls, no account needed</h3>
          <p className="hint">
            End-to-end encrypted. No sign-up required. Secured by{" "}
            <a
              href="https://xmtp.org/"
              target="_blank"
              rel="noopener noreferrer"
            >
              XMTP
            </a>
            .
          </p>
        </div>
      )}

      {/* Activity */}
      <div className="log-box">
        <div className="log-header">
          <svg
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          Activity
        </div>
        <div className="log-content" ref={logBoxRef}>
          {logs.map((entry, i) => (
            <div key={i} className="log-entry">
              <span className="log-time">{entry.time}</span>
              <span className={`log-msg ${entry.type ?? ""}`}>
                {entry.message}
              </span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="log-entry">
              <span className="log-time">--:--:--</span>
              <span className="log-msg">Click Get Started to begin</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
