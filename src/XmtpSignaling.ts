import type { Dm, Signer } from "@xmtp/browser-sdk";
import { Client, IdentifierKind } from "@xmtp/browser-sdk";
import { SignalingCodec } from "./SignalingCodec";
import type { SignalingCallback, SignalingMessage } from "./SignalingMessage";

export type ChatCallback = (text: string, senderInboxId: string) => void;

const signalingCodec = new SignalingCodec();

export class XmtpSignaling {
  private client: Client | null = null;
  private onMessage: SignalingCallback | null = null;
  private streamAbort: AbortController | null = null;
  private readonly dmCache = new Map<string, Dm>();
  private readonly dmPending = new Map<string, Promise<Dm>>();

  async connect(signer: Signer, env: "dev" | "production" = "dev") {
    // Workaround: browser SDK stores the full options object (including codecs)
    // and later sends it to a Web Worker via postMessage. Functions can't be
    // cloned, so we make `codecs` non-enumerable — the CodecRegistry constructor
    // reads it before init() posts to the worker, and structured clone skips it.
    const options = { env } as Record<string, unknown>;
    Object.defineProperty(options, "codecs", {
      value: [signalingCodec],
      enumerable: false,
    });
    const client = await Client.create(signer, options);
    this.client = client;
    const { inboxId } = client;
    if (!inboxId) throw new Error("XMTP client created without inbox ID");
    return inboxId;
  }

  getClient() {
    return this.client;
  }

  getInboxId() {
    return this.client?.inboxId;
  }

  private async getOrCreateDm(peerInboxId: string): Promise<Dm> {
    const cached = this.dmCache.get(peerInboxId);
    if (cached) return cached;

    const pending = this.dmPending.get(peerInboxId);
    if (pending) return pending;

    const promise = (async () => {
      if (!this.client) throw new Error("XMTP client not connected");

      await this.client.conversations.sync();
      const dm =
        (await this.client.conversations.getDmByInboxId(peerInboxId)) ??
        (await this.client.conversations.createDm(peerInboxId));
      this.dmCache.set(peerInboxId, dm);
      this.dmPending.delete(peerInboxId);
      return dm;
    })();

    this.dmPending.set(peerInboxId, promise);
    return promise;
  }

  async sendSignal(peerInboxId: string, message: SignalingMessage) {
    if (!this.client) throw new Error("XMTP client not connected");
    const dm = await this.getOrCreateDm(peerInboxId);
    await dm.send(signalingCodec.encode(message));
  }

  async sendChat(peerInboxId: string, text: string) {
    if (!this.client) throw new Error("XMTP client not connected");
    const dm = await this.getOrCreateDm(peerInboxId);
    await dm.sendMarkdown(text);
  }

  async sendSignalByAddress(peerAddress: string, message: SignalingMessage) {
    if (!this.client) throw new Error("XMTP client not connected");

    const cached = this.dmCache.get(peerAddress);
    if (cached) {
      await cached.send(signalingCodec.encode(message));
      return;
    }

    const canMessage = await Client.canMessage([
      { identifier: peerAddress, identifierKind: IdentifierKind.Ethereum },
    ]);

    if (!canMessage.get(peerAddress.toLowerCase())) {
      throw new Error(
        `Address ${peerAddress} is not registered on XMTP. They need to connect first.`,
      );
    }

    const inboxId = await this.client.fetchInboxIdByIdentifier({
      identifier: peerAddress,
      identifierKind: IdentifierKind.Ethereum,
    });

    if (!inboxId) {
      throw new Error(`Could not resolve inbox ID for ${peerAddress}`);
    }

    const dm = await this.getOrCreateDm(inboxId);
    this.dmCache.set(peerAddress, dm);
    await dm.send(signalingCodec.encode(message));
  }

  async startListening(
    callback: SignalingCallback,
    onChat?: ChatCallback,
  ) {
    if (!this.client) throw new Error("XMTP client not connected");

    this.onMessage = callback;
    this.streamAbort = new AbortController();

    await this.client.conversations.sync();

    const ownInboxId = this.client.inboxId;
    await this.client.conversations.streamAllMessages({
      onValue: (decodedMessage) => {
        if (decodedMessage.senderInboxId === ownInboxId) return;

        const content = decodedMessage.content as
          | SignalingMessage
          | string
          | undefined;

        if (typeof content === "string") {
          onChat?.(content, decodedMessage.senderInboxId);
        } else if (
          content &&
          typeof content === "object" &&
          "type" in content
        ) {
          this.onMessage?.(content, decodedMessage.senderInboxId);
        }
      },
      onError: (error) => {
        console.error("[XMTP] Stream error:", error);
      },
    });
  }

  async disconnect() {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.onMessage = null;
    this.client = null;
  }
}
