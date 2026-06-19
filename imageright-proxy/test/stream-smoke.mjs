// Synthetic test for streamPdfForPages — feeds a SOAP envelope with a known
// PDF base64'd inside through the same pipeline production uses, verifies
// the decoded bytes match the input. Run with: `node test/stream-smoke.mjs`
// from imageright-proxy/. Requires npm ci first.

import { Readable, Writable } from 'node:stream';
import { streamPdfForPages, SoapSession, SoapError } from '../soap.js';

const IR_NS = 'http://imageright.com/imageright.webservice';

// A tiny "PDF" — header bytes that satisfy the %PDF sanity check, plus enough
// payload to span multiple SAX chunks.
const fakePdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'ascii'),
  Buffer.alloc(200 * 1024, 0x41), // 200 KB of 'A' bytes
  Buffer.from('\n%%EOF\n', 'ascii'),
]);
const b64 = fakePdf.toString('base64');

const envelope =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
    `xmlns:tns="${IR_NS}">` +
    '<soap:Body>' +
      '<GetMultiPageImageFileUsingPagesResponse xmlns="' + IR_NS + '">' +
        '<GetMultiPageImageFileUsingPagesResult>' + b64 +
        '</GetMultiPageImageFileUsingPagesResult>' +
        '<securityToken>00000000-0000-0000-0000-000000000099</securityToken>' +
      '</GetMultiPageImageFileUsingPagesResponse>' +
    '</soap:Body>' +
  '</soap:Envelope>';

// Monkey-patch global fetch for this test.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  // Emit envelope in small chunks so the SAX/decoder pipeline sees real
  // streaming behavior (not one big chunk).
  const stream = new ReadableStream({
    async start(controller) {
      const buf = Buffer.from(envelope, 'utf8');
      const chunkSize = 8192;
      for (let off = 0; off < buf.length; off += chunkSize) {
        controller.enqueue(buf.subarray(off, Math.min(off + chunkSize, buf.length)));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/xml' } });
};

// Capture writes into a buffer (the production sink would be Express's res).
const chunks = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    chunks.push(chunk);
    cb();
  },
});

const session = new SoapSession({
  endpoint: 'http://test.invalid/asmx',
  hostHeader: 'test.invalid',
  contentTimeoutMs: 30_000,
});
session.token = 'pre-call-token';

let exitCode = 0;
try {
  const { bytesWritten } = await streamPdfForPages(session, [1, 2, 3], sink);
  sink.end();
  const out = Buffer.concat(chunks);
  console.log('streamed bytes:', bytesWritten);
  console.log('output length: ', out.length);
  console.log('input length:  ', fakePdf.length);
  console.log('first 4 bytes: ', out.subarray(0, 4).toString());
  console.log('token rotated: ', session.token);

  if (out.length !== fakePdf.length) {
    console.error('FAIL: length mismatch');
    exitCode = 1;
  }
  if (!out.equals(fakePdf)) {
    console.error('FAIL: byte mismatch');
    exitCode = 1;
  }
  if (session.token !== '00000000-0000-0000-0000-000000000099') {
    console.error('FAIL: token not rotated');
    exitCode = 1;
  }
  if (exitCode === 0) console.log('PASS');
} catch (err) {
  console.error('threw:', err);
  exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
process.exit(exitCode);
