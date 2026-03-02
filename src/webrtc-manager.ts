/**
 * webrtc-manager.ts
 *
 * Manages the WebRTC peer connection lifecycle. Uses an XmtpSignaling
 * instance to exchange SDP offers/answers and ICE candidates over
 * XMTP's E2EE messaging network.
 *
 * Encryption layers:
 *   1. XMTP MLS (Messaging Layer Security) — encrypts all signaling messages
 *   2. DTLS-SRTP — encrypts the actual media (audio/video) in transit
 *   3. (Optional) Insertable Streams — adds application-level E2EE on media frames
 */

import type { XmtpSignaling, SignalingMessage } from "./xmtp-signaling";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export interface WebRTCCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange: (state: ConnectionState) => void;
  onLog: (message: string, type?: "ok" | "warn" | "err") => void;
}

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private signaling: XmtpSignaling;
  private peerAddress: string = "";
  private callbacks: WebRTCCallbacks;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(signaling: XmtpSignaling, callbacks: WebRTCCallbacks) {
    this.signaling = signaling;
    this.callbacks = callbacks;
  }

  /** Set the local media stream to be sent to the peer */
  setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
  }

  /** Set the target peer's Ethereum address or XMTP inbox ID */
  setPeerAddress(address: string): void {
    this.peerAddress = address;
  }

  /** Send a signaling message to the peer, auto-detecting address vs inbox ID */
  private sendSignal(message: SignalingMessage): Promise<void> {
    if (this.peerAddress.startsWith("0x")) {
      return this.signaling.sendSignalByAddress(this.peerAddress, message);
    }
    return this.signaling.sendSignal(this.peerAddress, message);
  }

  /** Create the RTCPeerConnection and wire up event handlers */
  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Send ICE candidates to peer via XMTP
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onLog("Sending ICE candidate via XMTP");
        this.sendSignal({
          type: "ice-candidate",
          candidate: JSON.stringify(event.candidate.toJSON()),
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        }).catch((err) =>
          this.callbacks.onLog(`ICE send failed: ${err.message}`, "err")
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.callbacks.onLog(`ICE: ${state}`, state === "connected" || state === "completed" ? "ok" : state === "failed" ? "err" : "warn");
      this.mapConnectionState(state);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.callbacks.onLog(`Connection: ${state}`, state === "connected" ? "ok" : state === "failed" ? "err" : undefined);
      if (state === "connected") {
        this.callbacks.onConnectionStateChange("connected");
      } else if (state === "failed") {
        this.callbacks.onConnectionStateChange("failed");
      } else if (state === "disconnected") {
        this.callbacks.onConnectionStateChange("disconnected");
      }
    };

    // Receive remote media tracks
    pc.ontrack = (event) => {
      this.callbacks.onLog("Remote media track received", "ok");
      if (event.streams[0]) {
        this.callbacks.onRemoteStream(event.streams[0]);
      }
    };

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    this.pc = pc;
    return pc;
  }

  private mapConnectionState(iceState: string): void {
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

  /**
   * CALLER: Create an SDP offer and send it to the peer via XMTP.
   */
  async call(): Promise<void> {
    if (!this.peerAddress) throw new Error("Set peer address first");
    if (!this.localStream) throw new Error("Set local stream first");

    this.callbacks.onLog("Creating offer...");
    this.callbacks.onConnectionStateChange("connecting");

    const pc = this.createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.callbacks.onLog(`Sending offer via XMTP to ${this.peerAddress.slice(0, 8)}...`);
    await this.sendSignal({
      type: "offer",
      sdp: offer.sdp!,
    });
    this.callbacks.onLog("Offer sent via E2EE XMTP channel", "ok");
  }

  /**
   * Handle an incoming signaling message from XMTP.
   * This is called by the app when the XMTP stream receives a message.
   */
  async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
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

  /**
   * CALLEE: Receive an offer, create an answer, and send it back via XMTP.
   */
  private async handleOffer(sdp: string): Promise<void> {
    this.callbacks.onLog("Received offer via XMTP", "ok");
    this.callbacks.onConnectionStateChange("connecting");

    const pc = this.createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));

    // Apply any ICE candidates that arrived before the offer
    for (const candidate of this.pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingCandidates = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.callbacks.onLog("Sending answer via XMTP...");
    await this.sendSignal({
      type: "answer",
      sdp: answer.sdp!,
    });
    this.callbacks.onLog("Answer sent via E2EE XMTP channel", "ok");
  }

  /** CALLER: Receive the answer from the callee */
  private async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    this.callbacks.onLog("Received answer via XMTP", "ok");
    await this.pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp })
    );

    // Apply any pending ICE candidates
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingCandidates = [];
  }

  /** Add an ICE candidate from the remote peer */
  private async handleIceCandidate(msg: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
  }): Promise<void> {
    const candidateInit: RTCIceCandidateInit = JSON.parse(msg.candidate);

    if (this.pc && this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
    } else {
      // Queue candidates that arrive before the remote description is set
      this.pendingCandidates.push(candidateInit);
    }
  }

  /** Hang up and clean up */
  hangUp(): void {
    if (this.pc) {
      // Notify the peer
      if (this.peerAddress) {
        this.sendSignal({ type: "hangup" }).catch(() => {});
      }
      this.pc.close();
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.callbacks.onConnectionStateChange("idle");
    this.callbacks.onLog("Call ended", "warn");
  }

  /** Check if we have an active peer connection */
  isActive(): boolean {
    return this.pc !== null && this.pc.connectionState !== "closed";
  }
}
