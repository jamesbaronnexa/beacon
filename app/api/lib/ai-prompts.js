// /lib/ai-prompts.js

// -----------------------------
// Tunables
// -----------------------------
const SILENT_BY_DEFAULT = true; // flip to false if you want the agent to talk by default
const MAX_RESULT_CONTENT_CHARS = 420; // how much chunk text we pass back to the model in summaries
const MAX_ITEMS_FOR_AI = 5; // cap how many hits we summarize back to the model
const MODEL_STYLE = [
  "You are an expert assistant for electricians using AS/NZS 3000:2018.",
  "You know how to interpret clause numbering and section headings.",
  "Never guess: if you don't have context, say so or ask to search again.",
].join(" ");

function wantsExplanation(text = "") {
  return /\b(explain|why|what|how|summary|summarise|summarize|details|define|meaning|answer|talk|speak)\b/i.test(
    text || ""
  );
}

// -----------------------------
// Builder: Session Instructions
// -----------------------------
function systemInstruction(selectedDocument, allDocuments) {
  const titles =
    (allDocuments || [])
      .map((d) => d?.title)
      .filter(Boolean)
      .slice(0, 6)
      .join(", ") || "documents";

  const silentBlock = SILENT_BY_DEFAULT
    ? [
        "Assistant policy: SILENT-BY-DEFAULT.",
        "- Do not speak after tool calls.",
        "- Only create a response if the user explicitly asks for an explanation",
        "  (contains: explain|why|what|how|summar*|details|define|meaning|answer),",
        "  or they say 'answer'/'summarise'.",
      ].join("\n")
    : "Assistant policy: You may speak after tool calls if helpful.";

  return [
    MODEL_STYLE,
    "",
    `Active library: ${titles}.`,
    "Primary document references use clause numbers, section titles, and page numbers.",
    "When the user asks for a *page* or *clause*, prefer tools to *open/show* the page.",
    "When you do speak, keep it concise, cite clause numbers, and avoid fluff.",
    "Never fabricate clause numbers or requirements.",
    silentBlock,
  ].join("\n");
}

// -----------------------------
// Tool Metadata (shown to the model in session.update)
// -----------------------------
const toolDescriptions = {
  search_document: {
    description:
      "Search the indexed regulations and return the most relevant hits. Prefer exact clause resolution if the user mentions a clause number.",
    parameterDescription:
      "Natural-language query or clause reference (e.g. '2.3.2.2', 'outdoor socket IP rating').",
  },
  show_page: {
    description:
      "Open the PDF viewer at the given page number (as displayed to the user).",
    parameterDescription: "Display page number to open (integer).",
  },
};

// -----------------------------
// Friendly strings
// -----------------------------
const greetings = {
  documentsLoaded: (n) =>
    n > 0
      ? `Ready. ${n} document${n === 1 ? "" : "s"} loaded. Ask a clause or a topic.`
      : "Ready. Ask a clause or a topic.",
  ready: "Ready for your next query.",
};

const errorPrompts = {
  noResults: (q) => `No results found for “${q}”. Try a clause number or rephrase.`,
  searchError:
    "Sorry — I hit a snag searching. Try again in a moment or rephrase the query.",
  pageError:
    "I couldn't show that page right now. Try choosing a different result.",
};

// -----------------------------
// Formatting helpers
// -----------------------------
function truncate(s = "", n = MAX_RESULT_CONTENT_CHARS) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function pageLabel(r) {
  const page = r?.pdf_page_number;
  const sec = r?.section_number ? ` · ${r.section_number}` : "";
  const title = r?.section_title ? ` · ${r.section_title}` : "";
  return `p.${page}${sec}${title}`;
}

/**
 * This is returned to the model as the "function_call_output" after search.
 * Keep it compact: we want the model to have enough structure to decide whether
 * to ask for an explanation or call show_page again, but we avoid free-form chatter.
 */
function formatSearchResultsForAI(results = [], userQuery = "") {
  const top = (results || []).slice(0, MAX_ITEMS_FOR_AI);

  // Make a terse, structured payload
  const payload = {
    query: userQuery,
    best_page: top[0]?.pdf_page_number ?? null,
    results: top.map((r) => ({
      page: r.pdf_page_number,
      section_number: r.section_number || null,
      section_title: r.section_title || null,
      score: r.relevance_score ?? r.similarity ?? null,
      preview: truncate(r.content || ""),
    })),
    policy: SILENT_BY_DEFAULT
      ? "silent-by-default"
      : "may-speak-after-tools-if-helpful",
  };

  // Return as a compact JSON string so it’s easy for the model to parse
  return JSON.stringify(payload);
}

/**
 * Optional: a short context message you can inject if you decide to let the model speak.
 * (In SILENT mode you typically won't send this, but it's handy for debugging or A/B tests.)
 */
function searchResultsContext(results = [], userQuery = "") {
  if (!results?.length) return `No results for: ${userQuery}`;
  const lines = results
    .slice(0, 5)
    .map(
      (r, i) =>
        `${i + 1}. ${pageLabel(r)} — ${truncate(r.content || "", 160)}`
    );
  return [
    `Search results for: ${userQuery}`,
    ...lines,
    "Use show_page if the user wants to open a page. Only explain if asked.",
  ].join("\n");
}

// -----------------------------
// Public API
// -----------------------------
export const AI_PROMPTS = {
  systemInstruction,
  toolDescriptions,
  greetings,
  errorPrompts,
  searchResultsContext,
  wantsExplanation,
  SILENT_BY_DEFAULT,
};

export { formatSearchResultsForAI, wantsExplanation };
