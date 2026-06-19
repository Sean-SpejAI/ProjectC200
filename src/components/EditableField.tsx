import { useState, useRef, useEffect } from "react";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EditableFieldProps {
  value: string;
  onSave: (value: string) => void;
  className?: string;
  inputClassName?: string;
  multiline?: boolean;
  placeholder?: string;
  label?: string;
}

export function EditableField({
  value,
  onSave,
  className,
  inputClassName,
  multiline = false,
  placeholder = "Enter value...",
}: EditableFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  const handleSave = () => {
    // Skip no-op saves: re-committing an unchanged value would dirty the edit
    // buffer, write spurious audit rows, and (for adjuster-portion fields that
    // render a flattened object via formatAdjusterValue) silently replace the
    // structured object with its flattened string.
    if (editValue === value) {
      setIsEditing(false);
      return;
    }
    onSave(editValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) handleSave();
    else if (e.key === "Escape") handleCancel();
  };

  if (isEditing) {
    return (
      <div className="flex items-start gap-1">
        {multiline ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn("min-h-[60px] text-sm", inputClassName)}
            placeholder={placeholder}
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn("h-8 text-sm", inputClassName)}
            placeholder={placeholder}
          />
        )}
        <div className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-success hover:text-success hover:bg-success/10"
            onClick={handleSave}
          >
            <Icon name="check" size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleCancel}
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-1 cursor-pointer hover:bg-surface-container-low rounded px-1 -mx-1 transition-colors",
        className,
      )}
      onClick={() => setIsEditing(true)}
    >
      <span className="flex-1">
        {value || <span className="text-on-surface-variant italic">{placeholder}</span>}
      </span>
      <Icon name="edit" size={12} className="text-on-surface-variant/50 shrink-0 mt-1" />
    </div>
  );
}
