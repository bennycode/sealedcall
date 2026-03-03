import type { XmtpSignaling } from "./XmtpSignaling";
import type { SignalingMessage } from "./SignalingMessage";
import type { LogLevel } from "./LogLevel";
import type { WebRTCCallbacks } from "./ConnectionState";
import { ICE_SERVERS } from "./RTCConfiguration";

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private readonly signaling: XmtpSignaling;
  private peerAddress = "";
  private readonly callbacks: WebRTCCallbacks;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

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
          this.callbacks.onConnectionStateChange("failed");
          break;
        case "disconnected":
          this.callbacks.onConnectionStateChange("disconnected");
          break;
      }
    };

    pc.ontrack = (event) => {
      this.callbacks.onLog("Remote media track received", "ok");
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

    const pc = this.createPeerConnection();
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
        this.hangUp();
        break;
    }
  }

  private async handleOffer(sdp: string) {
    this.callbacks.onLog("Incoming call", "ok");
    this.callbacks.onConnectionStateChange("connecting");

    const pc = this.createPeerConnection();
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

  hangUp() {
    if (this.pc) {
      if (this.peerAddress) {
        void this.sendSignal({ type: "hangup" }).catch(() => {});
      }
      this.pc.close();
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.callbacks.onConnectionStateChange("idle");
    this.callbacks.onLog("Call ended", "warn");
  }

  isActive() {
    return this.pc !== null && this.pc.connectionState !== "closed";
  }

  getVideoSender(): RTCRtpSender | undefined {
    return this.pc?.getSenders().find((s) => s.track?.kind === "video");
  }
}
