// mySanskar media proxy — serves the mysanskar-media R2 bucket on
// media.mysanskar.workers.dev with byte-range support (video seeking),
// immutable cache headers, and CORS. Replaces the rate-limited r2.dev URL
// for production streaming. Deployed via Cloudflare API (see CLAUDE.md).
export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
    if (!key) return new Response('Not found', { status: 404 });

    // Parse a single byte range: "bytes=a-b" | "bytes=a-" | "bytes=-n"
    let range;
    const rh = request.headers.get('Range');
    if (rh) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rh.trim());
      if (m && (m[1] || m[2])) {
        if (m[1] && m[2]) range = { offset: +m[1], length: +m[2] - +m[1] + 1 };
        else if (m[1]) range = { offset: +m[1] };
        else range = { suffix: +m[2] };
      }
    }

    const obj = await env.MEDIA.get(key, range ? { range } : undefined);
    if (!obj) return new Response('Not found', { status: 404 });

    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('ETag', obj.httpEtag);
    h.set('Accept-Ranges', 'bytes');
    h.set('Cache-Control', 'public, max-age=31536000, immutable'); // content-addressed by name
    h.set('Access-Control-Allow-Origin', '*');

    if (range) {
      const offset = range.offset !== undefined ? range.offset
        : Math.max(0, obj.size - range.suffix);
      const length = range.length !== undefined ? Math.min(range.length, obj.size - offset)
        : obj.size - offset;
      h.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      h.set('Content-Length', String(length));
      return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
    }
    h.set('Content-Length', String(obj.size));
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
  },
};
