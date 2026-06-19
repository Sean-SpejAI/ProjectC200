import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { splitPDFInBrowser, type PDFChunk } from "@/lib/pdfSplitter";

interface NewAnalysisUploadProps {
  /** Switch the portal to the Review Queue view. */
  onGoToQueue: () => void;
}

type Phase = "idle" | "uploading" | "done" | "error";

const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");
const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

// Largest single PDF we accept for upload. Big files are split in the browser
// (below) into small chunks before upload, so this cap is about the browser's
// ability to load + split the PDF in memory — not the per-document analysis
// limit. 400 MB comfortably covers the largest known client documents.
const MAX_UPLOAD_MB = 400;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// A PDF larger than SPLIT_CHUNK_MB (or with more than SPLIT_MAX_PAGES pages) is
// split in the browser into chunks bounded by these limits. The Edge analysis
// worker can't hold or analyze the 200 MB+ originals (Supabase caps functions
// at 256 MB memory / 400 s), so each chunk is uploaded as its own document and
// analyzed in its own short Vertex call; the claim-level synthesis recombines
// them. Page count (not just MB) is bounded because Vertex inference time — and
// the connection resets we saw — scale with page count.
// 12 MB / 15 pages: dense scanned-medical pages are ~1.2 MB each, so 25-page /
// 25 MB chunks needed >90-150 s per Vertex pass and routinely failed or blew the
// 400 s worker budget. Smaller chunks finish each pass comfortably in-budget, at
// the cost of more chunks per claim — absorbed by the higher analyze concurrency
// (cap 6) and per-completion sibling chaining.
const SPLIT_CHUNK_MB = 12;
const SPLIT_MAX_PAGES = 15;

export function NewAnalysisUpload({ onGoToQueue }: NewAnalysisUploadProps) {
  const { toast } = useToast();
  const [claimantName, setClaimantName] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Split status shown before uploads start, plus overall progress (0-100).
  // pct is computed across files since the total chunk count isn't known until
  // each large file is split in the browser.
  const [prepMsg, setPrepMsg] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const all = Array.from(incoming);
      const pdfs = all.filter(isPdf);
      const rejected = all.length - pdfs.length;
      if (rejected > 0) {
        toast({
          title: "Only PDF files are supported",
          description: `${rejected} non-PDF file${rejected === 1 ? "" : "s"} skipped.`,
          variant: "destructive",
        });
      }
      const accepted = pdfs.filter((f) => f.size <= MAX_UPLOAD_BYTES);
      const oversize = pdfs.filter((f) => f.size > MAX_UPLOAD_BYTES);
      if (oversize.length > 0) {
        toast({
          title: `File${oversize.length === 1 ? "" : "s"} too large`,
          description: `${oversize.map((f) => f.name).join(", ")} — each file must be ${MAX_UPLOAD_MB} MB or smaller.`,
          variant: "destructive",
        });
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
        const next = [...prev];
        for (const f of accepted) {
          const key = `${f.name}:${f.size}`;
          if (!seen.has(key)) {
            seen.add(key);
            next.push(f);
          }
        }
        return next;
      });
    },
    [toast],
  );

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  // Warn the user if they try to close/reload the tab mid-upload.
  useEffect(() => {
    if (phase !== "uploading") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const canProcess =
    files.length > 0 &&
    claimantName.trim().length > 0 &&
    claimNumber.trim().length > 0 &&
    phase !== "uploading";

  const resetForm = () => {
    setFiles([]);
    setClaimantName("");
    setClaimNumber("");
    setPhase("idle");
    setUploadedCount(0);
    setPrepMsg(null);
    setPct(0);
    setErrorMsg(null);
    setDialogOpen(false);
  };

  const handleProcess = async () => {
    if (!canProcess) return;
    setPhase("uploading");
    setUploadedCount(0);
    setPct(0);
    setPrepMsg(null);
    setErrorMsg(null);
    setDialogOpen(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("You must be signed in to upload.");

      // 1. Create the claim first so documents can be attached as they upload.
      const { data: claim, error: claimErr } = await supabase
        .from("claims")
        .insert({
          source: "manual",
          claim_number: claimNumber.trim(),
          claimant_name: claimantName.trim(),
          status: "pending",
          synthesis_status: "not_run",
          assigned_to: user.id,
        })
        .select("id")
        .single();
      if (claimErr || !claim) throw new Error(claimErr?.message || "Failed to create the claim record.");

      // 2. Split each PDF in the browser, then upload its chunks. Small files
      //    come back as a single chunk (the original); large files are broken
      //    into SPLIT_CHUNK_MB / SPLIT_MAX_PAGES pieces. We split-then-upload one
      //    source file at a time and let each chunk blob fall out of scope after
      //    upload, so the tab never holds more than one source file's worth of
      //    PDF data in memory (a full claim can exceed 1 GB). Each chunk becomes
      //    its own 'pending' document; the claim-level synthesis recombines them.
      //    We deliberately do NOT set was_split — that triggers the old
      //    one-invocation chunk loop, which can't fit the 400 s Edge worker limit.
      type DocRow = {
        claim_id: string;
        source: "manual";
        file_name: string;
        file_url: string;
        file_size: number;
        mime_type: string;
        document_type: string;
        processing_status: "pending";
        claim_details: Record<string, unknown> | null;
      };
      const rows: DocRow[] = [];
      const fileCount = files.length;
      for (let fi = 0; fi < fileCount; fi++) {
        const file = files[fi];
        const base = file.name.replace(/\.pdf$/i, "");
        let chunks: PDFChunk[];
        try {
          setPrepMsg(`Preparing ${file.name}…`);
          chunks = await splitPDFInBrowser(
            file,
            (p) => setPrepMsg(`Preparing ${file.name}: ${p.message}`),
            { maxChunkMB: SPLIT_CHUNK_MB, maxPagesPerChunk: SPLIT_MAX_PAGES },
          );
        } catch (splitErr) {
          // Couldn't parse the PDF to split it — upload it whole and let the
          // pipeline handle/flag it rather than failing the whole batch.
          console.warn(`Could not split ${file.name}; uploading whole`, splitErr);
          chunks = [{ index: 0, startPage: 1, endPage: 0, blob: file, sizeMB: file.size / 1024 / 1024 }];
        }
        setPrepMsg(null);
        const multi = chunks.length > 1;
        for (let ci = 0; ci < chunks.length; ci++) {
          const c = chunks[ci];
          const displayName = multi
            ? `${base} — part ${ci + 1} of ${chunks.length} (pp. ${c.startPage}-${c.endPage}).pdf`
            : file.name;
          const path = `manual/${crypto.randomUUID()}/${sanitize(displayName)}`;
          const { error: upErr } = await supabase.storage
            .from("claim-documents")
            .upload(path, c.blob, { cacheControl: "3600", upsert: false, contentType: "application/pdf" });
          if (upErr) throw new Error(`Upload failed for ${displayName}: ${upErr.message}`);
          // Store the bare storage path; the bucket is private and PDFs are served
          // via the sign-claim-document edge proxy (no public URLs).
          rows.push({
            claim_id: claim.id,
            source: "manual",
            file_name: displayName,
            file_url: path,
            file_size: c.blob.size,
            mime_type: "application/pdf",
            document_type: "user_upload",
            processing_status: "pending",
            claim_details: multi
              ? {
                  original_file_name: file.name,
                  chunk_index: ci + 1,
                  chunk_count: chunks.length,
                  page_start: c.startPage,
                  page_end: c.endPage,
                }
              : null,
          });
          setUploadedCount((u) => u + 1);
          setPct(Math.round(((fi + (ci + 1) / chunks.length) / fileCount) * 100));
        }
      }

      // 3. Insert one document row per uploaded chunk, in 'pending'.
      const { error: docsErr } = await supabase.from("claim_documents").insert(rows);
      if (docsErr) throw new Error(docsErr.message);

      // 4. Kick off server-side analysis. Returns fast; processing then runs
      //    independently of this browser. If the call fails, the stuck-pending
      //    watchdog re-dispatches the documents within ~10 minutes.
      const { error: fnErr } = await supabase.functions.invoke("process-uploaded-claim", {
        body: { claimId: claim.id },
      });
      if (fnErr) {
        console.warn("process-uploaded-claim invoke failed; watchdog will recover", fnErr);
      }

      setPhase("done");
      toast({
        title: "Upload complete",
        description: "Processing continues in the background — you can safely navigate away.",
      });
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="flex-grow overflow-auto bg-surface">
      <div className="max-w-2xl px-6 py-10">
        <div className="mb-6">
          <h1 className="text-headline-md text-primary">New Analysis</h1>
          <p className="text-body-md text-on-surface-variant mt-1">
            Enter the claimant and claim number, add one or more PDF files, then process them. The documents run
            through the same analysis as System of Record claims and appear in the Review Queue.
          </p>
        </div>

        {/* Claimant + claim number */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-label-sm text-outline uppercase">Claimant Name</label>
            <Input
              value={claimantName}
              onChange={(e) => setClaimantName(e.target.value)}
              placeholder="e.g. Smith, John"
              disabled={phase === "uploading"}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-label-sm text-outline uppercase">Claim Number</label>
            <Input
              value={claimNumber}
              onChange={(e) => setClaimNumber(e.target.value)}
              placeholder="e.g. 0000385134"
              disabled={phase === "uploading"}
              className="mt-1 font-mono"
            />
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (phase !== "uploading") setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (phase !== "uploading" && e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-2xl border-2 border-dashed p-8 text-center transition-colors",
            isDragging ? "border-secondary bg-secondary-container/30" : "border-outline-variant bg-surface-container-lowest",
            phase === "uploading" && "opacity-60 pointer-events-none",
          )}
        >
          <div className="w-14 h-14 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center mx-auto mb-3">
            <Icon name="upload_file" size={28} />
          </div>
          <p className="text-body-md text-on-surface">
            Drag &amp; drop PDF files here, or{" "}
            <button
              type="button"
              className="text-secondary font-semibold underline underline-offset-2 hover:opacity-80"
              onClick={() => fileInputRef.current?.click()}
            >
              browse to upload
            </button>
          </p>
          <p className="text-label-sm text-on-surface-variant mt-1">
            One or more PDF files · up to {MAX_UPLOAD_MB} MB each · large PDFs are split automatically
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />

          {/* Selected files */}
          {files.length > 0 && (
            <div className="mt-5 space-y-2 text-left">
              {files.map((file, idx) => (
                <div
                  key={`${file.name}:${file.size}:${idx}`}
                  className="flex items-center gap-3 bg-surface-container rounded-lg px-3 py-2"
                >
                  <Icon name="picture_as_pdf" size={18} className="text-on-surface-variant shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-body-md text-on-surface">{file.name}</span>
                  <span className="text-label-sm text-on-surface-variant shrink-0">{fmtSize(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    disabled={phase === "uploading"}
                    className="text-on-surface-variant hover:text-destructive shrink-0"
                    title="Remove"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Process button */}
        <div className="mt-6 flex items-center justify-end gap-3">
          {files.length > 0 && (
            <span className="text-label-sm text-on-surface-variant">
              {files.length} file{files.length === 1 ? "" : "s"} selected
            </span>
          )}
          <Button onClick={handleProcess} disabled={!canProcess} className="gap-2">
            <Icon name="play_arrow" size={18} />
            Process These Files
          </Button>
        </div>
      </div>

      {/* Upload / completion dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          // Block closing while the upload is in flight.
          if (!open && phase === "uploading") return;
          if (!open) setDialogOpen(false);
        }}
      >
        <DialogContent
          onInteractOutside={(e) => {
            if (phase === "uploading") e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (phase === "uploading") e.preventDefault();
          }}
        >
          {phase === "uploading" && (
            <>
              <DialogHeader>
                <DialogTitle>Preparing &amp; uploading — please keep this window open</DialogTitle>
                <DialogDescription>
                  Large PDFs are split into smaller parts in your browser before upload. Don't close or reload this
                  tab until it finishes. Once it's done, processing continues on its own and you can safely leave.
                </DialogDescription>
              </DialogHeader>
              <div className="py-2">
                {prepMsg ? (
                  <p className="text-label-sm text-on-surface-variant">{prepMsg}</p>
                ) : (
                  <>
                    <Progress value={pct} className="h-2" />
                    <p className="text-label-sm text-on-surface-variant mt-2">
                      Uploaded {uploadedCount} document{uploadedCount === 1 ? "" : "s"}…
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          {phase === "done" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon name="check_circle" size={20} className="text-success" filled />
                  Upload complete
                </DialogTitle>
                <DialogDescription>
                  Your files are uploaded. Processing now runs in the background — it's safe to navigate away or close
                  this window. The claim appears in the Review Queue and becomes available to open once processing
                  finishes.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={resetForm}>
                  Upload another
                </Button>
                <Button
                  onClick={() => {
                    resetForm();
                    onGoToQueue();
                  }}
                  className="gap-2"
                >
                  <Icon name="list_alt" size={18} />
                  Go to Review Queue
                </Button>
              </DialogFooter>
            </>
          )}

          {phase === "error" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon name="error" size={20} className="text-destructive" filled />
                  Upload failed
                </DialogTitle>
                <DialogDescription>{errorMsg || "Something went wrong during upload."}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPhase("idle");
                    setDialogOpen(false);
                  }}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
