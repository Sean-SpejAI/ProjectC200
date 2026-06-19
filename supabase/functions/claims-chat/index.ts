import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getAccessToken, getProjectId, getRegion } from "../_shared/vertex-auth.ts";
import { scannerShortCircuit } from "../_shared/scanner-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
};

interface ChatRequest {
  message: string;
  claimContext?: {
    claimNumber: string;
    claimType: string;
    incidentDate: string;
    incidentDescription: string;
    documents?: Array<{
      fileName: string;
      documentType: string;
      summary?: string;
    }>;
  };
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

const MODEL = "gemini-2.5-flash";

function buildSystemPrompt(claimContext?: ChatRequest["claimContext"]): string {
  let prompt = `You are a helpful claims processing assistant for Spej. You help the claims team review bodily injury claims by:

1. Answering questions about claims and documents
2. Explaining medical terminology and billing codes
3. Identifying potential issues or inconsistencies
4. Providing guidance on next steps
5. Summarizing complex medical information

Be professional, accurate, and helpful. If you're unsure about something, say so. Always prioritize accuracy over speed.`;

  if (claimContext) {
    prompt += `

CURRENT CLAIM CONTEXT:
- Claim Number: ${claimContext.claimNumber}
- Claim Type: ${claimContext.claimType}
- Incident Date: ${claimContext.incidentDate}
- Description: ${claimContext.incidentDescription}`;

    if (claimContext.documents && claimContext.documents.length > 0) {
      prompt += `

UPLOADED DOCUMENTS:`;
      claimContext.documents.forEach((doc, i) => {
        prompt += `
${i + 1}. ${doc.fileName} (${doc.documentType})${doc.summary ? ` - ${doc.summary}` : ""}`;
      });
    }
  }

  return prompt;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Scanner short-circuit. claims-chat has no in-code auth — platform-level
  // verify_jwt=true enforces it before the request reaches us, so by the
  // time we're executing, the caller is authenticated. Guard prevents
  // Vertex AI calls during scans.
  const scannerEarly = scannerShortCircuit(req, corsHeaders);
  if (scannerEarly) return scannerEarly;

  try {
    const { message, claimContext, conversationHistory = [] }: ChatRequest = await req.json();

    console.log("Processing chat message for claims assistant (Vertex AI / Gemini)");

    const systemPrompt = buildSystemPrompt(claimContext);
    const contents = [
      ...conversationHistory.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: message }] },
    ];

    const accessToken = await getAccessToken();
    const projectId = getProjectId();
    const region = getRegion();
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${MODEL}:streamGenerateContent?alt=sse`;

    const vertexResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          topP: 0.95,
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!vertexResponse.ok || !vertexResponse.body) {
      const errorText = await vertexResponse.text();
      console.error("Vertex AI error:", vertexResponse.status, errorText);
      if (vertexResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment.", code: "RATE_LIMITED" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: `Vertex AI error: ${vertexResponse.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Transform Gemini SSE → OpenAI-compatible delta SSE so the frontend
    // (ClaimsAgent.tsx) can keep parsing `parsed.choices[0].delta.content`
    // as it does for other LLM providers.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = vertexResponse.body!.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
              let line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;
              try {
                const chunk = JSON.parse(jsonStr);
                const text = chunk?.candidates?.[0]?.content?.parts
                  ?.map((p: { text?: string }) => p.text || "")
                  .join("");
                if (text) {
                  const out = { choices: [{ delta: { content: text } }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
                }
              } catch (e) {
                console.warn("Failed to parse Gemini chunk:", e);
              }
            }
          }
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        } catch (err) {
          console.error("Stream pump error:", err);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error) {
    console.error("Error in claims chat:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
