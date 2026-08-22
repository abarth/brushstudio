/**
 * CPU <-> GPU transfer utilities.
 *
 * All CPU->GPU uploads go through mappedAtCreation staging buffers and
 * GPU-side copies instead of queue.writeBuffer/writeTexture. Some Chromium
 * builds (e.g. SwiftShader-backed headless) silently drop queue.write*
 * ("A valid external Instance reference no longer exists") while encoder
 * copies keep working; this path is correct everywhere.
 */

export function uploadBuffer(
  device: GPUDevice,
  target: GPUBuffer,
  offset: number,
  data: ArrayBuffer | ArrayBufferView,
): void {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const size = Math.ceil(bytes.byteLength / 4) * 4;
  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint8Array(staging.getMappedRange()).set(bytes);
  staging.unmap();
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(staging, 0, target, offset, size);
  device.queue.submit([enc.finish()]);
  staging.destroy();
}

/** `data` is tightly packed rows of `bytesPerPixel * width` bytes. */
export function uploadTexture(
  device: GPUDevice,
  tex: GPUTexture,
  data: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): void {
  const unpadded = width * bytesPerPixel;
  const padded = Math.ceil(unpadded / 256) * 256;
  const staging = device.createBuffer({
    size: padded * height,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  const dst = new Uint8Array(staging.getMappedRange());
  if (padded === unpadded) {
    dst.set(data);
  } else {
    for (let y = 0; y < height; y++) {
      dst.set(data.subarray(y * unpadded, (y + 1) * unpadded), y * padded);
    }
  }
  staging.unmap();
  const enc = device.createCommandEncoder();
  enc.copyBufferToTexture(
    { buffer: staging, bytesPerRow: padded },
    { texture: tex },
    [width, height],
  );
  device.queue.submit([enc.finish()]);
  staging.destroy();
}

/** Reads a rectangle of RGBA8 texels back to the CPU (empty on failure). */
export async function readTextureRegion(
  device: GPUDevice,
  tex: GPUTexture,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const rowBytes = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({
    size: rowBytes * h,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex, origin: { x, y } },
      { buffer: buf, bytesPerRow: rowBytes },
      [w, h],
    );
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * 4 * h);
    for (let row = 0; row < h; row++) {
      out.set(mapped.subarray(row * rowBytes, row * rowBytes + w * 4), row * w * 4);
    }
    buf.unmap();
    return out;
  } catch (err) {
    // GPU readback can fail on broken WebGPU stacks; degrade gracefully
    // (e.g. the corresponding undo step is skipped) instead of crashing.
    console.warn('[northlight] texture readback failed:', err);
    return new Uint8Array(0);
  } finally {
    buf.destroy();
  }
}
