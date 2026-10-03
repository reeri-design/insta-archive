import { parseByteRange } from "../../../../../archive-view/byte-range.ts";
import { readItemMedia } from "../../../../../archive-view/archive-view.ts";
import { archiveRepository, mediaStorage, OWNER_ID } from "../../../../archive-server.ts";

/** Serves one stored media asset of an item, with byte ranges for video. */
export async function GET(request: Request, { params }: RouteContext<"/items/[key]/media/[asset]">) {
  const { key, asset } = await params;
  const media = await readItemMedia(archiveRepository(), mediaStorage(), OWNER_ID, key, asset);
  if (!media) return new Response("Not found", { status: 404 });

  const size = media.bytes.byteLength;
  const headers = {
    "Content-Type": media.mimeType,
    "Accept-Ranges": "bytes",
    // Stored originals are never overwritten.
    "Cache-Control": "private, max-age=31536000, immutable",
  };
  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  if (!range) {
    return new Response(Buffer.from(media.bytes), { headers: { ...headers, "Content-Length": String(size) } });
  }
  const body = Buffer.from(media.bytes.subarray(range.start, range.end + 1));
  return new Response(body, {
    status: 206,
    headers: { ...headers, "Content-Length": String(body.byteLength), "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
  });
}
