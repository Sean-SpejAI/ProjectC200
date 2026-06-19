// Derive the storage object path (within the `claim-documents` bucket) from a
// stored `claim_documents.file_url` value, regardless of which form it takes:
//   - legacy public URL:  https://<proj>.supabase.co/storage/v1/object/public/claim-documents/manual/<uuid>/<file>.pdf
//   - signed URL:         https://<proj>.supabase.co/storage/v1/object/sign/claim-documents/<path>?token=...
//   - bare path (new):    manual/<uuid>/<file>.pdf
//
// Returns the path relative to the bucket (e.g. "manual/<uuid>/<file>.pdf"),
// suitable for supabase.storage.from('claim-documents').download()/createSignedUrl().
export function storagePathFromFileUrl(fileUrl: string): string {
  // Strip query string / fragment (signed-URL token, #page=N anchor).
  const clean = String(fileUrl).trim().split("?")[0].split("#")[0];
  // If the bucket segment is present (public OR signed URL), take everything after it.
  const m = clean.match(/claim-documents\/(.+)$/);
  if (m) return m[1];
  // Otherwise it's already a bare path.
  return clean.replace(/^\/+/, "");
}
