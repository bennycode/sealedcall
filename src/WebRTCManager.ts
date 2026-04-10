import type { XmtpSignaling } from "./XmtpSignaling";
import type { SignalingMessage } from "./SignalingMessage";
import type { LogLevel } from "./LogLevel";
import type { WebRTCCallbacks } from "./ConnectionState";
import { ICE_SERVERS } from "./RTCConfiguration";
import {
  isE2ESupported,
  generateEncryptionKey,
  exportKey,
  importKey,
  applySenderTransforms,
  applyReceiverTransform,
} from "./E2EEncryption";

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private readonly signaling: XmtpSignaling;
  private peerAddress = "";
  private readonly callbacks: WebRTCCallbacks;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private encryptionKeyBase64: string | null = null;

  constructor(signaling: XmtpSignaling, callbacks: WebRTCCallbacks) {
    this.signaling = signaling;
    this.callbacks = callbacks;
  }

  setLocalStream(stream: MediaStream) {
    this.localStream = stream;
  }

  setPeerAddress(address: string) {
    this.peerAddress = address;
  }

  private sendSignal(message: SignalingMessage) {
    if (this.peerAddress.startsWith("0x")) {
      return this.signaling.sendSignalByAddress(this.peerAddress, message);
    }
    return this.signaling.sendSignal(this.peerAddress, message);
  }

  private createPeerConnection() {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.callbacks.onLog("Sending connection info...");
      this.sendSignal({
        type: "ice-candidate",
        candidate: JSON.stringify(event.candidate.toJSON()),
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.callbacks.onLog(`ICE send failed: ${message}`, "err");
      });
    };

    pc.oniceconnectionstatechange = () => {
      const { iceConnectionState } = pc;
      const level = this.iceStateToLogLevel(iceConnectionState);
      this.callbacks.onLog(`ICE: ${iceConnectionState}`, level);
      this.mapConnectionState(iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      const { connectionState } = pc;
      const level = this.connectionStateToLogLevel(connectionState);
      this.callbacks.onLog(`Connection: ${connectionState}`, level);

      switch (connectionState) {
        case "connected":
          this.callbacks.onConnectionStateChange("connected");
          break;
        case "failed":
          this.logConnectionDetails(pc);
          this.callbacks.onConnectionStateChange("failed");
          break;
        case "disconnected":
          this.callbacks.onConnectionStateChange("disconnected");
          break;
      }
    };

    pc.ontrack = (event) => {
      this.callbacks.onLog("Remote media track received", "ok");
      if (this.encryptionKeyBase64) {
        applyReceiverTransform(event.receiver, this.encryptionKeyBase64);
      }
      const [stream] = event.streams;
      if (stream) {
        this.callbacks.onRemoteStream(stream);
      }
    };

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    this.pc = pc;
    return pc;
  }

  private iceStateToLogLevel(state: RTCIceConnectionState): LogLevel {
    switch (state) {
      case "connected":
      case "completed":
        return "ok";
      case "failed":
        return "err";
      default:
        return "warn";
    }
  }

  private connectionStateToLogLevel(
    state: RTCPeerConnectionState,
  ): LogLevel | undefined {
    switch (state) {
      case "connected":
        return "ok";
      case "failed":
        return "err";
      default:
        return undefined;
    }
  }

  private mapConnectionState(iceState: RTCIceConnectionState) {
    switch (iceState) {
      case "connected":
      case "completed":
        this.callbacks.onConnectionStateChange("connected");
        break;
      case "failed":
        this.callbacks.onConnectionStateChange("failed");
        break;
      case "disconnected":
        this.callbacks.onConnectionStateChange("disconnected");
        break;
      case "checking":
        this.callbacks.onConnectionStateChange("connecting");
        break;
    }
  }

  async call() {
    if (!this.peerAddress) throw new Error("Set peer address first");
    if (!this.localStream) throw new Error("Set local stream first");

    this.callbacks.onLog("Creating offer...");
    this.callbacks.onConnectionStateChange("connecting");

    if (isE2ESupported()) {
      const key = await generateEncryptionKey();
      this.encryptionKeyBase64 = await exportKey(key);
      await this.sendSignal({
        type: "media-stream-encryption-key",
        key: this.encryptionKeyBase64,
      });
      this.callbacks.onLog("E2E media encryption enabled", "ok");
    } else {
      this.callbacks.onLog(
        "E2E media encryption not supported by this browser",
        "warn",
      );
    }

    const pc = this.createPeerConnection();

    if (this.encryptionKeyBase64) {
      applySenderTransforms(pc, this.encryptionKeyBase64);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.callbacks.onLog("Calling...");
    await this.sendSignal({ type: "offer", sdp: offer.sdp! });
    this.callbacks.onLog("Call request sent", "ok");
  }

  async handleSignalingMessage(msg: SignalingMessage) {
    switch (msg.type) {
      case "offer":
        await this.handleOffer(msg.sdp);
        break;
      case "answer":
        await this.handleAnswer(msg.sdp);
        break;
      case "ice-candidate":
        await this.handleIceCandidate(msg);
        break;
      case "hangup":
        this.hangUp(false);
        break;
      case "mute-status":
        this.callbacks.onRemoteMuteChange(msg.muted);
        break;
      case "video-status":
        this.callbacks.onRemoteVideoChange(msg.hidden);
        break;
      case "media-stream-encryption-key":
        await this.handleEncryptionKey(msg.key);
        break;
    }
  }

  private async handleOffer(sdp: string) {
    this.callbacks.onLog("Incoming call", "ok");
    this.callbacks.onConnectionStateChange("connecting");

    if (this.encryptionKeyBase64) {
      this.callbacks.onLog("E2E media encryption enabled", "ok");
    }

    const pc = this.createPeerConnection();

    if (this.encryptionKeyBase64) {
      applySenderTransforms(pc, this.encryptionKeyBase64);
    }

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp }),
    );

    for (const candidate of this.pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingCandidates = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.callbacks.onLog("Answering call...");
    await this.sendSignal({ type: "answer", sdp: answer.sdp! });
    this.callbacks.onLog("Call answered", "ok");
  }

  private async handleAnswer(sdp: string) {
    if (!this.pc) return;
    this.callbacks.onLog("Call accepted", "ok");
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp }),
    );

    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingCandidates = [];
  }

  private async handleIceCandidate(
    msg: Extract<SignalingMessage, { type: "ice-candidate" }>,
  ) {
    const candidateInit: RTCIceCandidateInit = JSON.parse(msg.candidate);

    if (this.pc?.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } else {
      this.pendingCandidates.push(candidateInit);
    }
  }

  private async handleEncryptionKey(keyBase64: string) {
    try {
      await importKey(keyBase64);
      this.encryptionKeyBase64 = keyBase64;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.callbacks.onLog(`E2E key import failed: ${message}`, "err");
    }
  }

  hangUp(notifyPeer = true) {
    if (this.pc) {
      if (notifyPeer && this.peerAddress) {
        void this.sendSignal({ type: "hangup" }).catch(() => {});
      }
      this.pc.close();
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.encryptionKeyBase64 = null;
    this.callbacks.onConnectionStateChange("idle");
    this.callbacks.onLog("Call ended", "warn");
  }

  isActive() {
    return this.pc !== null && this.pc.connectionState !== "closed";
  }

  private logConnectionDetails(pc: RTCPeerConnection) {
    this.callbacks.onLog(`ICE: ${pc.iceConnectionState}, gathering: ${pc.iceGatheringState}`, "err");
    this.callbacks.onLog(`Signaling: ${pc.signalingState}`, "err");

    const local = pc.localDescription;
    const remote = pc.remoteDescription;
    this.callbacks.onLog(`Local SDP: ${local ? local.type : "none"}, Remote SDP: ${remote ? remote.type : "none"}`, "err");

    pc.getStats().then((stats) => {
      for (const report of stats.values()) {
        if (report.type === "candidate-pair" && report.state === "failed") {
          this.callbacks.onLog(`Failed pair: ${report.localCandidateId} <-> ${report.remoteCandidateId}`, "err");
        }
        if (report.type === "local-candidate" || report.type === "remote-candidate") {
          this.callbacks.onLog(`${report.type}: ${report.candidateType} ${report.address ?? ""}:${report.port ?? ""} ${report.protocol ?? ""}`, "err");
        }
      }
    }).catch(() => {});
  }

  sendMuteStatus(muted: boolean) {
    void this.sendSignal({ type: "mute-status", muted }).catch(() => {});
  }

  sendVideoStatus(hidden: boolean) {
    void this.sendSignal({ type: "video-status", hidden }).catch(() => {});
  }

  getVideoSender(): RTCRtpSender | undefined {
    return this.pc?.getSenders().find((s) => s.track?.kind === "video");
  }
}
