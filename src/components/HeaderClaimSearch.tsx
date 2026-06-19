import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface SearchResult {
  id: string;
  claim_number: string | null;
  claimant_name: string | null;
}

interface HeaderClaimSearchProps {
  onSelectClaim: (claimId: string) => void;
}

// Global claim quick-search shown in the page header. Debounced server-side
// query against `claims` restricted to synthesis_status='completed' so it
// mirrors the Review Queue visibility rule. Single input matches either
// claim_number OR claimant_name via postgrest's .or(...ilike...).
export function HeaderClaimSearch({ onSelectClaim }: HeaderClaimSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }

    setLoading(true);
    setOpen(true);
    const handle = setTimeout(async () => {
      // Escape % and , so a claimant name like "Smith, John" doesn't break
      // the .or() expression. Postgrest treats commas as filter separators.
      const safe = q.replace(/[%,]/g, " ");
      const pattern = `%${safe}%`;
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, claimant_name")
        .eq("synthesis_status", "completed")
        .or(`claim_number.ilike.${pattern},claimant_name.ilike.${pattern}`)
        .order("claim_number", { ascending: true })
        .limit(10);

      if (error) {
        console.error("HeaderClaimSearch query error:", error);
        setResults([]);
      } else {
        setResults((data ?? []) as SearchResult[]);
      }
      setLoading(false);
    }, 200);

    return () => clearTimeout(handle);
  }, [query]);

  const handleSelect = (id: string) => {
    setQuery("");
    setResults([]);
    setOpen(false);
    inputRef.current?.blur();
    onSelectClaim(id);
  };

  return (
    <Popover open={open && query.trim().length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="flex items-center gap-2 bg-surface-container-low border border-outline-variant rounded-full px-4 py-1.5 min-w-[320px]">
          <Icon name="search" size={16} className="text-on-surface-variant shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              if (query.trim().length > 0) setOpen(true);
            }}
            placeholder="Search by claim number or claimant name"
            className="flex-1 bg-transparent text-label-md placeholder:text-outline focus:outline-none"
            aria-label="Search claims"
          />
          {loading && (
            <Icon
              name="progress_activity"
              size={14}
              className="text-on-surface-variant shrink-0 animate-spin"
            />
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="p-0 w-[420px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            {results.length === 0 && !loading && (
              <CommandEmpty>No claims found.</CommandEmpty>
            )}
            {results.map((r) => (
              <CommandItem
                key={r.id}
                value={r.id}
                onSelect={() => handleSelect(r.id)}
                className="group cursor-pointer flex items-center gap-3"
              >
                <span
                  className={cn(
                    "font-mono font-bold text-secondary text-label-md min-w-[110px]",
                  )}
                >
                  {r.claim_number ?? "—"}
                </span>
                <span className="text-body-md text-on-surface truncate flex-1">
                  {r.claimant_name ?? "—"}
                </span>
                <Icon
                  name="arrow_forward"
                  size={14}
                  className="text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
