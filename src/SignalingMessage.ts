export type SignalingMessage =
  | { readonly type: "offer"; readonly sdp: string }
  | { readonly type: "answer"; readonly sdp: string }
  | {
      readonly type: "ice-candidate";
      readonly candidate: string;
      readonly sdpMid: string | null;
      readonly sdpMLineIndex: number | null;
    }
  | { readonly type: "hangup" }
  | { readonly type: "mute-status"; readonly muted: boolean }
  | { readonly type: "media-stream-encryption-key"; readonly key: string };

export type SignalingCallback = (
  msg: SignalingMessage,
  senderInboxId: string,
) => void;
