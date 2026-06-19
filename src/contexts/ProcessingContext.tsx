import React, { createContext, useContext, useState, useCallback, useRef } from "react";

export type ProcessingStep = 
  | "idle"
  | "uploading"
  | "splitting"
  | "validating"
  | "storing"
  | "categorizing"
  | "extracting"
  | "analyzing"
  | "summarizing"
  | "saving"
  | "complete"
  | "error";

export interface ProcessingState {
  currentStep: ProcessingStep;
  fileName: string | null;
  startTime: number | null;
  documentId: string | null;
  jobId: string | null;
  stepHistory: Array<{
    step: ProcessingStep;
    timestamp: number;
    message: string;
  }>;
  error: string | null;
}

interface ProcessingContextType {
  state: ProcessingState;
  startProcessing: (fileName: string) => void;
  setStep: (step: ProcessingStep, message?: string) => void;
  completeProcessing: () => void;
  setError: (error: string) => void;
  resetProcessing: () => void;
  setDocumentId: (id: string) => void;
  setJobId: (id: string) => void;
  hasPersistedClaimDetails: (documentId: string) => boolean;
  markClaimDetailsPersisted: (documentId: string) => void;
  clearPersistedClaimDetails: () => void;
}

const initialState: ProcessingState = {
  currentStep: "idle",
  fileName: null,
  startTime: null,
  documentId: null,
  jobId: null,
  stepHistory: [],
  error: null,
};

const ProcessingContext = createContext<ProcessingContextType | undefined>(undefined);

export function ProcessingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ProcessingState>(initialState);
  const persistedClaimDetailsRef = useRef<Set<string>>(new Set());

  const startProcessing = useCallback((fileName: string) => {
    const now = Date.now();
    setState({
      currentStep: "uploading",
      fileName,
      startTime: now,
      documentId: null,
      jobId: null,
      stepHistory: [{ step: "uploading", timestamp: now, message: `Starting upload: ${fileName}` }],
      error: null,
    });
  }, []);

  const setStep = useCallback((step: ProcessingStep, message?: string) => {
    setState((prev) => ({
      ...prev,
      currentStep: step,
      stepHistory: [
        ...prev.stepHistory,
        { step, timestamp: Date.now(), message: message || getDefaultMessage(step, prev.fileName) },
      ],
    }));
  }, []);

  const completeProcessing = useCallback(() => {
    setState((prev) => ({
      ...prev,
      currentStep: "complete",
      stepHistory: [...prev.stepHistory, { step: "complete", timestamp: Date.now(), message: "Analysis complete" }],
    }));
  }, []);

  const setError = useCallback((error: string) => {
    setState((prev) => ({
      ...prev,
      currentStep: "error",
      error,
      stepHistory: [...prev.stepHistory, { step: "error", timestamp: Date.now(), message: error }],
    }));
  }, []);

  const resetProcessing = useCallback(() => { setState(initialState); }, []);

  const setDocumentId = useCallback((id: string) => {
    setState((prev) => ({ ...prev, documentId: id }));
  }, []);

  const setJobId = useCallback((id: string) => {
    setState((prev) => ({ ...prev, jobId: id }));
  }, []);

  const hasPersistedClaimDetails = useCallback((documentId: string): boolean => {
    return persistedClaimDetailsRef.current.has(documentId);
  }, []);

  const markClaimDetailsPersisted = useCallback((documentId: string): void => {
    persistedClaimDetailsRef.current.add(documentId);
  }, []);

  const clearPersistedClaimDetails = useCallback((): void => {
    persistedClaimDetailsRef.current.clear();
  }, []);

  return (
    <ProcessingContext.Provider
      value={{ state, startProcessing, setStep, completeProcessing, setError, resetProcessing, setDocumentId, setJobId, hasPersistedClaimDetails, markClaimDetailsPersisted, clearPersistedClaimDetails }}
    >
      {children}
    </ProcessingContext.Provider>
  );
}

export function useProcessing() {
  const context = useContext(ProcessingContext);
  if (!context) throw new Error("useProcessing must be used within a ProcessingProvider");
  return context;
}

function getDefaultMessage(step: ProcessingStep, fileName: string | null): string {
  const name = fileName || "document";
  switch (step) {
    case "uploading": return `Uploading ${name}...`;
    case "splitting": return "Splitting large PDF for processing...";
    case "validating": return "Validating file type and size...";
    case "storing": return "Storing document in secure storage...";
    case "categorizing": return "Categorizing document type...";
    case "extracting": return "Extracting text and images...";
    case "analyzing": return "AI analyzing content with Gemini 2.5 Flash...";
    case "summarizing": return "Generating summary and insights...";
    case "saving": return "Saving analysis results...";
    case "complete": return "Analysis complete";
    case "error": return "An error occurred";
    default: return "";
  }
}