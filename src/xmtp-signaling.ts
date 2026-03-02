/**
 * xmtp-signaling.ts
 *
 * Uses XMTP's end-to-end encrypted messaging protocol as the signaling
 * channel for WebRTC. SDP offers, answers, and ICE candidates are sent
 * as JSON messages through XMTP DMs — meaning the entire signaling
 * handshake is encrypted and no central server can read it.
 */

import { Client, IdentifierKind } from "@xmtp/browser-sdk";
import type { Signer, Identifier } from "@xmtp/browser-sdk";

// ── Signaling message types ──────────────────────────────────────────

export type SignalingMessage =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { type: "hangup" };

// ── Create an XMTP-compatible signer from an ethers.js wallet ────────

export function createXmtpSigner(wallet: {
  address: string;
  signMessage: (message: string) => Promise<string>;
}): Signer {
  return {
    type: "EOA" as const,
    getIdentifier: (): Identifier => ({
      identifier: wallet.address,
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message: string): Promise<Uint8Array> => {
      const hexSig = await wallet.signMessage(message);
      // Convert hex string → Uint8Array
      const bytes = new Uint8Array(
        hexSig
          .replace(/^0x/, "")
          .match(/.{1,2}/g)!
          .map((b) => parseInt(b, 16))
      );
      return bytes;
    },
  };
}

// ── XMTP Signaling Client ───────────────────────────────────────────

export class XmtpSignaling {
  private client: Client | null = null;
  private onMessage: ((msg: SignalingMessage, senderInboxId: string) => void) | null = null;
  private streamAbort: AbortController | null = null;
  private dmCache: Map<string, any> = new Map();
  private dmPending: Map<string, Promise<any>> = new Map();

  /** Connect to XMTP with the given signer */
  async connect(signer: Signer, env: "dev" | "production" = "dev"): Promise<string> {
    this.client = await Client.create(signer, {
      env,
    });
    return this.client.inboxId!;
  }

  /** Get the underlying XMTP client */
  getClient(): Client | null {
    return this.client;
  }

  /** Get our inbox ID */
  getInboxId(): string | undefined {
    return this.client?.inboxId;
  }

  /** Get or create a cached DM conversation for a peer inbox ID */
  private async getOrCreateDm(peerInboxId: string) {
    // Return cached DM if available
    const cached = this.dmCache.get(peerInboxId);
    if (cached) return cached;

    // If another call is already resolving this DM, wait for it
    const pending = this.dmPending.get(peerInboxId);
    if (pending) return pending;

    // Resolve the DM and cache it
    const promise = (async () => {
      await this.client!.conversations.sync();
      let dm = await this.client!.conversations.getDmByInboxId(peerInboxId);
      if (!dm) {
        dm = await this.client!.conversations.createDm(peerInboxId);
      }
      this.dmCache.set(peerInboxId, dm);
      this.dmPending.delete(peerInboxId);
      return dm;
    })();

    this.dmPending.set(peerInboxId, promise);
    return promise;
  }

  /**
   * Send a signaling message to a peer by their inbox ID.
   * Creates or finds an existing DM conversation with them.
   */
  async sendSignal(peerInboxId: string, message: SignalingMessage): Promise<void> {
    if (!this.client) throw new Error("XMTP client not connected");
    const dm = await this.getOrCreateDm(peerInboxId);
    await dm.sendText(JSON.stringify(message));
  }

  /**
   * Send a signaling message to a peer by their Ethereum address.
   * Looks up their inbox ID first.
   */
  async sendSignalByAddress(
    peerAddress: string,
    message: SignalingMessage
  ): Promise<void> {
    if (!this.client) throw new Error("XMTP client not connected");

    // Check cache first (address may have been resolved before)
    if (this.dmCache.has(peerAddress)) {
      const dm = this.dmCache.get(peerAddress);
      await dm.sendText(JSON.stringify(message));
      return;
    }

    // Check if the address is reachable on XMTP
    const canMessage = await Client.canMessage([
      { identifier: peerAddress, identifierKind: IdentifierKind.Ethereum },
    ]);

    if (!canMessage.get(peerAddress.toLowerCase())) {
      throw new Error(
        `Address ${peerAddress} is not registered on XMTP. They need to connect first.`
      );
    }

    // Resolve the address to an inbox ID
    const inboxId = await this.client.fetchInboxIdByIdentifier({
      identifier: peerAddress,
      identifierKind: IdentifierKind.Ethereum,
    });

    if (!inboxId) {
      throw new Error(`Could not resolve inbox ID for ${peerAddress}`);
    }

    // Get or create DM via the cached helper, then also cache under the address
    const dm = await this.getOrCreateDm(inboxId);
    this.dmCache.set(peerAddress, dm);
    await dm.sendText(JSON.stringify(message));
  }

  /**
   * Start listening for incoming signaling messages.
   * Calls the provided callback whenever a signaling message arrives.
   */
  async startListening(callback: (msg: SignalingMessage, senderInboxId: string) => void): Promise<void> {
    if (!this.client) throw new Error("XMTP client not connected");

    this.onMessage = callback;
    this.streamAbort = new AbortController();

    // Sync existing conversations
    await this.client.conversations.sync();

    // Stream all incoming messages
    await this.client.conversations.streamAllMessages({
      onValue: (decodedMessage) => {
        // Skip our own messages
        if (decodedMessage.senderInboxId === this.client?.inboxId) return;

        try {
          // Parse the message content as a signaling message
          const content =
            typeof decodedMessage.content === "string"
              ? decodedMessage.content
              : String(decodedMessage.content);

          const parsed = JSON.parse(content) as SignalingMessage;

          // Validate it's a known signaling message type
          if (
            parsed.type === "offer" ||
            parsed.type === "answer" ||
            parsed.type === "ice-candidate" ||
            parsed.type === "hangup"
          ) {
            this.onMessage?.(parsed, decodedMessage.senderInboxId);
          }
        } catch {
          // Not a signaling message — ignore
        }
      },
      onError: (error) => {
        console.error("[XMTP] Stream error:", error);
      },
    });
  }

  /** Stop listening and disconnect */
  async disconnect(): Promise<void> {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.onMessage = null;
    this.client = null;
  }
}
