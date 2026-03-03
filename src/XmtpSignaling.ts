import type { Dm, Signer } from "@xmtp/browser-sdk";
import { Client, IdentifierKind } from "@xmtp/browser-sdk";
import type { EncodedContent } from "@xmtp/wasm-bindings";
import { SignalingCodec, SignalingContentType } from "./SignalingCodec";
import type { SignalingCallback, SignalingMessage } from "./SignalingMessage";

export class XmtpSignaling {
  private client: Client | null = null;
  private onMessage: SignalingCallback | null = null;
  private streamAbort: AbortController | null = null;
  private readonly dmCache = new Map<string, Dm>();
  private readonly dmPending = new Map<string, Promise<Dm>>();

  async connect(signer: Signer, env: "dev" | "production" = "dev") {
    const client = await Client.create(signer, { env });
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
    await dm.send(SignalingCodec.encode(message));
  }

  async sendSignalByAddress(peerAddress: string, message: SignalingMessage) {
    if (!this.client) throw new Error("XMTP client not connected");

    const cached = this.dmCache.get(peerAddress);
    if (cached) {
      await cached.send(SignalingCodec.encode(message));
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
    await dm.send(SignalingCodec.encode(message));
  }

  async startListening(callback: SignalingCallback) {
    if (!this.client) throw new Error("XMTP client not connected");

    this.onMessage = callback;
    this.streamAbort = new AbortController();

    await this.client.conversations.sync();

    const ownInboxId = this.client.inboxId;
    await this.client.conversations.streamAllMessages({
      onValue: (decodedMessage) => {
        if (decodedMessage.senderInboxId === ownInboxId) return;

        const { contentType } = decodedMessage;
        if (
          contentType.authorityId === SignalingContentType.authorityId &&
          contentType.typeId === SignalingContentType.typeId
        ) {
          const encoded = decodedMessage.content as EncodedContent;
          const message = SignalingCodec.decode(encoded);
          this.onMessage?.(message, decodedMessage.senderInboxId);
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
