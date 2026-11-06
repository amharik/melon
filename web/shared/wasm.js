// Minimal, dependency-free binding for the Melon Rust/WASM core.
//
// ABI: melon_alloc(len) -> ptr, melon_call(ptr, len) -> response_ptr,
// melon_out_len() -> response_len. Responses are UTF-8 JSON and live in a
// reusable buffer, so we copy them out before the next call.

export class MelonCore {
  constructor(exports) {
    this.exports = exports;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  static async load(url = "./wasm/melon_core.wasm") {
    let instance;
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(url), {});
      instance = result.instance;
    } catch (err) {
      // Some static servers do not send application/wasm.
      const bytes = await (await fetch(url)).arrayBuffer();
      const result = await WebAssembly.instantiate(bytes, {});
      instance = result.instance;
    }
    return new MelonCore(instance.exports);
  }

  call(command) {
    const bytes = this.encoder.encode(JSON.stringify(command));
    const ptr = this.exports.melon_alloc(bytes.length);
    if (!ptr) throw new Error("melon_alloc failed");
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    const outPtr = this.exports.melon_call(ptr, bytes.length);
    const outLen = this.exports.melon_out_len();
    // memory.buffer can be replaced when the heap grows.
    const view = new Uint8Array(this.exports.memory.buffer, outPtr, outLen);
    const text = this.decoder.decode(view);
    return JSON.parse(text);
  }

  ping() {
    return this.call({ op: "ping" });
  }
}
