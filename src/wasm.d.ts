// Cloudflare Workers supports importing .wasm as bytes (BufferSource).
// We type it as ArrayBuffer; the runtime value is accepted by WebAssembly.Module/Instance constructors.

declare module "*.wasm" {
  const bytes: ArrayBuffer;
  export default bytes;
}
