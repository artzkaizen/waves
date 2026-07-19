/**
 * waves · recorded-video container.
 *
 * A recording is a flat sequence of `[uint32 big-endian length][jpeg bytes]` frames.
 * Chosen over a real container so the server needs no ffmpeg dependency: frames arrive
 * from the Pi already JPEG-encoded, and appending them is a pure write with no transcode.
 * It is also trivially splittable — reading frame N does not require decoding 0..N-1.
 */

import { open } from "node:fs/promises";

const MAX_FRAME_BYTES = 32 * 1024 * 1024; // sanity bound against a corrupt length prefix

/** Stream JPEG payloads out of a recording, without loading the whole file into memory. */
export async function* iterMjpegFrames(path: string): AsyncGenerator<Uint8Array> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return; // no video recorded for this exercise
  }

  try {
    const header = Buffer.allocUnsafe(4);
    for (;;) {
      const { bytesRead } = await fh.read(header, 0, 4);
      if (bytesRead < 4) return; // clean EOF, or a truncated trailing header

      const length = header.readUInt32BE(0);
      if (length <= 0 || length > MAX_FRAME_BYTES) return; // corrupt — stop, don't guess

      const payload = Buffer.allocUnsafe(length);
      const read = await fh.read(payload, 0, length);
      if (read.bytesRead < length) return; // truncated final frame (e.g. crash mid-write)

      yield payload;
    }
  } finally {
    await fh.close();
  }
}

/** Count frames without decoding them — used to pace recorded playback. */
export async function countMjpegFrames(path: string): Promise<number> {
  let n = 0;
  for await (const _ of iterMjpegFrames(path)) n += 1;
  return n;
}
