import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

interface MermaidChartProps { chart: string; className?: string; }

mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: { primaryColor: "#1e40af", primaryTextColor: "#ffffff", primaryBorderColor: "#1e3a8a", secondaryColor: "#6d28d9", secondaryTextColor: "#ffffff", secondaryBorderColor: "#5b21b6", tertiaryColor: "#0f172a", tertiaryTextColor: "#ffffff", tertiaryBorderColor: "#1e293b", background: "#ffffff", mainBkg: "#1e293b", textColor: "#0f172a", nodeBkg: "#1e40af", nodeTextColor: "#ffffff", nodeBorder: "#1e3a8a", lineColor: "#475569", labelTextColor: "#0f172a", labelBoxBkgColor: "#f1f5f9", labelBoxBorderColor: "#cbd5e1", clusterBkg: "#e2e8f0", clusterBorder: "#64748b", edgeLabelBackground: "#f8fafc", labelColor: "#0f172a", altBackground: "#f1f5f9", actorBkg: "#1e40af", actorTextColor: "#ffffff", actorBorder: "#1e3a8a", actorLineColor: "#475569", signalColor: "#0f172a", signalTextColor: "#0f172a", attributeBackgroundColorOdd: "#f1f5f9", attributeBackgroundColorEven: "#e2e8f0", fontSize: "14px", fontFamily: "ui-sans-serif, system-ui, sans-serif" }, flowchart: { htmlLabels: true, curve: "basis", nodeSpacing: 50, rankSpacing: 50, padding: 15 }, securityLevel: "loose" });

export function MermaidChart({ chart, className = "" }: MermaidChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const renderChart = async () => {
      if (!containerRef.current) return;
      try {
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        console.error("Mermaid rendering error:", err);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
      }
    };
    renderChart();
  }, [chart]);
  if (error) return (<div className="p-4 bg-destructive/10 rounded-lg text-destructive text-sm"><p className="font-medium">Diagram Error</p><p className="text-xs mt-1 opacity-75">{error}</p></div>);
  return (<div ref={containerRef} className={`mermaid-container overflow-x-auto bg-white rounded-lg p-4 ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />);
}