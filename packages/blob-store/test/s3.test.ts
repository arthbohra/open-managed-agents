import { describe, expect, it, vi } from "vitest";
import { S3BlobStore } from "../src/adapters/s3";

function fakeStore(body: ReadableStream<Uint8Array>, size: number) {
  const transformed = vi.fn(() => body);
  const oldEagerRead = vi.fn(async () => { throw new Error("eager object buffering"); });
  const store = new S3BlobStore({ endpoint: "http://localhost:9000", bucket: "test",
    accessKeyId: "test", secretAccessKey: "test" });
  (store as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
    client: { send: async () => ({ ContentLength: size, Body: {
      transformToWebStream: transformed,
      transformToByteArray: oldEagerRead,
    } }) },
    GetObjectCommand: class { constructor(_input: unknown) {} },
  });
  return { store, transformed, oldEagerRead };
}

describe("S3 BlobStore GET", () => {
  it("streams GET bodies without eager whole-object buffering and supports the convenience reader", async () => {
    const payload = new TextEncoder().encode("streamed");
    const { store, transformed, oldEagerRead } = fakeStore(new ReadableStream({
      start(controller) { controller.enqueue(payload); controller.close(); },
    }), payload.byteLength);
    const blob = await store.get("session/archive");
    expect(blob?.size).toBe(payload.byteLength);
    expect(oldEagerRead).not.toHaveBeenCalled();
    expect(transformed).toHaveBeenCalledOnce();
    expect(await blob?.text()).toBe("streamed");
    expect(oldEagerRead).not.toHaveBeenCalled();
  });
});
