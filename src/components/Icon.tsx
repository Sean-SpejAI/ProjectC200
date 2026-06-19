import { cn } from "@/lib/utils";
import type { CSSProperties, HTMLAttributes } from "react";

export interface IconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  name: string;
  filled?: boolean;
  size?: number;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
}

export function Icon({ name, filled = false, size, weight = 400, className, style, ...rest }: IconProps) {
  const variationSettings = `'FILL' ${filled ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' 24`;
  const mergedStyle: CSSProperties = {
    fontVariationSettings: variationSettings,
    ...(size ? { fontSize: `${size}px`, width: `${size}px`, height: `${size}px`, lineHeight: `${size}px` } : null),
    ...style,
  };
  return (
    <span
      aria-hidden="true"
      className={cn("material-symbols-outlined select-none inline-flex items-center justify-center", className)}
      style={mergedStyle}
      {...rest}
    >
      {name}
    </span>
  );
}

export default Icon;
