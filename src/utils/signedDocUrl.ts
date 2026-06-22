import { supabase } from "@/integrations/supabase/client";

// The `claim-documents` bucket is PRIVATE — the browser never reads storage
// directly. PDFs are opened via a short-lived signed URL minted by the
// sign-claim-document edge function (which verifies the user's session).

// Route the signed storage URL through our own domain so the address bar reads
// c200.spej.dev/d/... instead of <project>.supabase.co. A Vercel rewrite
// (/d/:path* -> the Supabase storage sign endpoint) proxies it; the token query
// and #page=N anchor are preserved, so access control + paging are unchanged.
// Skipped on localhost (vite dev has no proxy) — there we open the raw URL.
function rewriteToAppDomain(url: string): string {
  try {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return url;
    return url.replace(
      /^https?:\/\/[^/]+\/storage\/v1\/object\/sign\/claim-documents\//,
      `${window.location.origin}/d/`,
    );
  } catch {
    return url;
  }
}

/** Mint a signed URL for a claim document's PDF (optionally with a #page=N anchor). */
export async function getSignedDocUrl(
  documentId: string,
  page?: number | null,
): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("sign-claim-document", {
    body: { documentId, page: page ?? undefined },
  });
  if (error || !data?.url) return null;
  return rewriteToAppDomain(data.url as string);
}

/**
 * Open a claim document's PDF in a new tab via a signed URL. Opens a blank tab
 * synchronously (within the click gesture, so it isn't popup-blocked), then
 * navigates it once the URL is signed. Returns false if signing failed.
 */
export async function openSignedDoc(
  documentId: string,
  page?: number | null,
): Promise<boolean> {
  const w = window.open("about:blank", "_blank");
  const url = await getSignedDocUrl(documentId, page);
  if (!url) {
    w?.close();
    return false;
  }
  if (w) {
    w.opener = null; // sever the opener link to the trusted storage origin
    w.location.href = url;
  } else {
    // Popup was blocked / no handle — best-effort direct open.
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return true;
}
