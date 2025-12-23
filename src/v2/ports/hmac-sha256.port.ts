export interface HmacSha256PortV2 {
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array; // 32 bytes
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
