import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { openSignedDoc } from "@/utils/signedDocUrl";
import { getDocumentTypeLabel, getVerificationBadge } from "@/utils/docDisplay";
import { buildDocTree, type DocTreeInput, type TreeDocNode, type TreeFolderNode } from "@/utils/docTree";

// Folders and page collections are COLLAPSED by default; users expand to drill
// in. The tree mirrors Sor's File → Folder → Document → Page structure.
const PAGE_PREVIEW_LIMIT = 60;

const fmtDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

function PageList({ pages }: { pages: TreeDocNode["pages"] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? pages : pages.slice(0, PAGE_PREVIEW_LIMIT);
  return (
    <div className="mt-1 space-y-0.5">
      {visible.map((p) => (
        <button
          key={`${p.docRowId}-${p.n}`}
          type="button"
          onClick={() => openSignedDoc(p.docRowId, p.internalPage)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-surface-container-highest transition-colors group"
          title={`Open page ${p.n}`}
        >
          <Icon name="description" size={13} className="text-on-surface-variant shrink-0" />
          <span className="text-[10px] text-on-surface">Page {p.n}</span>
          {p.format && (
            <span className="text-[9px] text-outline uppercase">{p.format}</span>
          )}
          <Icon
            name="open_in_new"
            size={11}
            className="text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0"
          />
        </button>
      ))}
      {!showAll && pages.length > PAGE_PREVIEW_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-[10px] text-primary hover:underline px-2 py-1"
        >
          Show all {pages.length} pages
        </button>
      )}
    </div>
  );
}

function DocNode({ doc, depth }: { doc: TreeDocNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const badge = getVerificationBadge(doc.analysis);
  const date = fmtDate(doc.documentDate);
  const expandable = doc.pages.length > 0;
  const indent = { paddingLeft: `${depth * 14 + 4}px` };

  const meta = (
    <div className="min-w-0 flex-grow">
      <p className="text-[11px] font-bold text-on-surface truncate" title={doc.label}>{doc.label}</p>
      <p className="text-[9px] text-outline uppercase truncate">
        {doc.typeCode ? `${doc.typeCode} · ` : ""}
        {getDocumentTypeLabel(doc.documentType)}
        {date ? ` · ${date}` : ""}
        {doc.pageCount ? ` · ${doc.pageCount}p` : ""}
      </p>
    </div>
  );

  const openBtn = doc.openRowId ? (
    <button
      type="button"
      onClick={() => openSignedDoc(doc.openRowId!)}
      className="shrink-0 p-1 rounded hover:bg-surface-container-highest text-on-surface-variant hover:text-primary transition-colors"
      title={`Open ${doc.label}`}
    >
      <Icon name="open_in_new" size={14} />
    </button>
  ) : null;

  // Non-expandable (manual upload / no per-page manifest): a plain openable card.
  if (!expandable) {
    return (
      <div
        className="flex items-center gap-2 bg-surface-container-lowest border border-outline-variant rounded-lg py-2 pr-2"
        style={indent}
      >
        <Icon name="picture_as_pdf" size={18} filled className="text-destructive shrink-0 ml-1" />
        {meta}
        {badge && (
          <Badge variant="outline" className={cn("text-[9px] shrink-0 rounded-full", badge.className)}>
            {badge.label}
          </Badge>
        )}
        {openBtn}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="flex items-center gap-1.5 bg-surface-container-lowest border border-outline-variant rounded-lg py-2 pr-2"
        style={indent}
      >
        <CollapsibleTrigger className="flex min-w-0 flex-grow items-center gap-2 text-left">
          <Icon
            name="chevron_right"
            size={16}
            className={cn("text-on-surface-variant shrink-0 transition-transform", open && "rotate-90")}
          />
          <Icon name="picture_as_pdf" size={18} filled className="text-destructive shrink-0" />
          {meta}
        </CollapsibleTrigger>
        {badge && (
          <Badge variant="outline" className={cn("text-[9px] shrink-0 rounded-full", badge.className)}>
            {badge.label}
          </Badge>
        )}
        {openBtn}
      </div>
      <CollapsibleContent>
        <div style={{ paddingLeft: `${depth * 14 + 22}px` }}>
          <PageList pages={doc.pages} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function FolderNode({ folder, depth }: { folder: TreeFolderNode; depth: number }) {
  // Top-level folders open by default so the adjuster immediately sees the
  // Sor folder structure; nested folders, documents, and page lists
  // stay collapsed.
  const [open, setOpen] = useState(depth === 0);
  const indent = { paddingLeft: `${depth * 14 + 4}px` };
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-1.5 pr-2 text-left hover:bg-surface-container-highest rounded-lg transition-colors"
        style={indent}
      >
        <Icon
          name="chevron_right"
          size={16}
          className={cn("text-on-surface-variant shrink-0 transition-transform", open && "rotate-90")}
        />
        <Icon name={open ? "folder_open" : "folder"} size={16} filled className="text-primary shrink-0" />
        <span className="text-[11px] font-bold text-on-surface truncate flex-grow">{folder.name}</span>
        <span className="text-[9px] text-outline shrink-0">{folder.pageCount}p</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1 mt-1">
          {folder.folders.map((f) => (
            <FolderNode key={f.path} folder={f} depth={depth + 1} />
          ))}
          {folder.docs.map((d) => (
            <DocNode key={d.key} doc={d} depth={depth + 1} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function DocumentTree({ documents }: { documents: DocTreeInput[] }) {
  const tree = buildDocTree(documents);
  const hasFolders = tree.folders.length > 0;
  return (
    <div className="space-y-1">
      {tree.folders.map((f) => (
        <FolderNode key={f.path} folder={f} depth={0} />
      ))}
      {tree.looseDocs.length > 0 && (
        <div className={cn("space-y-1", hasFolders && "pt-1")}>
          {tree.looseDocs.map((d) => (
            <DocNode key={d.key} doc={d} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
