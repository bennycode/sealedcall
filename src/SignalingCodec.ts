import type { ContentCodec } from "@xmtp/content-type-primitives";
import type { ContentTypeId, EncodedContent } from "@xmtp/wasm-bindings";
import type { SignalingMessage } from "./SignalingMessage";

export const SignalingContentType: ContentTypeId = {
  authorityId: "xmtp-webrtc.example",
  typeId: "webrtc-signaling",
  versionMajor: 1,
  versionMinor: 0,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SignalingCodec implements ContentCodec<SignalingMessage> {
  readonly contentType = SignalingContentType;

  encode(content: SignalingMessage): EncodedContent {
    return {
      type: SignalingContentType,
      parameters: {},
      content: encoder.encode(JSON.stringify(content)),
    };
  }

  decode(content: EncodedContent): SignalingMessage {
    const json: unknown = JSON.parse(decoder.decode(content.content));
    if (!isSignalingMessage(json)) {
      throw new Error("Invalid signaling message payload");
    }
    return json;
  }

  fallback(content: SignalingMessage): string {
    return `[WebRTC signaling: ${content.type}]`;
  }

  shouldPush(): boolean {
    return false;
  }
}

function isSignalingMessage(value: unknown): value is SignalingMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const { type } = value;
  return (
    type === "offer" ||
    type === "answer" ||
    type === "ice-candidate" ||
    type === "hangup" ||
    type === "mute-status" ||
    type === "video-status" ||
    type === "media-stream-encryption-key"
  );
}
