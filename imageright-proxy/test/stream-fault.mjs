// Verify streamPdfForPages throws cleanly when upstream returns:
//  (a) HTTP 500 with a SOAP fault body
//  (b) HTTP 200 with body that isn't %PDF after decoding
// Run with: `node test/stream-fault.mjs` from imageright-proxy/.

import { Writable } from 'node:stream';
import { streamPdfForPages, SoapSession, SoapError } from '../soap.js';

const IR_NS = 'http://imageright.com/imageright.webservice';
const sink = new Writable({ write(_c, _e, cb) { cb(); } });
const session = new SoapSession({ endpoint: 'http://test.invalid/asmx', hostHeader: 'test.invalid', contentTimeoutMs: 30_000 });
session.token = 'tok';

const original = globalThis.fetch;
let failures = 0;

// Case A: 500 + Fault envelope
globalThis.fetch = async () => new Response(
  '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Not logged in</faultstring></soap:Fault></soap:Body></soap:Envelope>',
  { status: 500, headers: { 'Content-Type': 'text/xml' } },
);
try {
  await streamPdfForPages(session, [1], sink);
  console.error('FAIL: case A did not throw'); failures++;
} catch (err) {
  if (err instanceof SoapError && /Not logged in/.test(err.message)) {
    console.log('PASS case A:', err.message);
  } else {
    console.error('FAIL case A: wrong error:', err); failures++;
  }
}

// Case B: 200 but body is not a PDF after decode (e.g. "<html>...</html>" base64'd)
const notPdf = Buffer.from('<html><body>oh no</body></html>'.repeat(50)).toString('base64');
globalThis.fetch = async () => new Response(
  `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Resp xmlns="${IR_NS}"><GetMultiPageImageFileUsingPagesResult>${notPdf}</GetMultiPageImageFileUsingPagesResult></Resp></soap:Body></soap:Envelope>`,
  { status: 200, headers: { 'Content-Type': 'text/xml' } },
);
try {
  await streamPdfForPages(session, [1], sink);
  console.error('FAIL: case B did not throw'); failures++;
} catch (err) {
  if (err instanceof SoapError && err.upstreamMessage === 'response_not_pdf') {
    console.log('PASS case B:', err.upstreamMessage);
  } else {
    console.error('FAIL case B: wrong error:', err); failures++;
  }
}

globalThis.fetch = original;
process.exit(failures === 0 ? 0 : 1);
