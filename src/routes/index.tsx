import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  startTransition,
  useMemo,
} from "react";
import {
  ArrowLeft,
  SlidersHorizontal,
  Copy,
  Check,
  Download,
  ChevronUp,
  ClipboardList,
  User,
  Bot,
  Shield,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { ChatContinuation } from "../components/ui/chat-continuation";
import { cn } from "../lib/cn";
import { splitMarkdownForPreview } from "../lib/markdown-preview";
import { stripMarkdown } from "../lib/markdown-utils";
import { deleteShareConversationCacheEntry } from "../lib/share-cache";
import { renderConversationToMarkdown } from "../lib/render";
import type { NormalizedConversation } from "../lib/types";

const RECENT_URLS_KEY = "chatdump.recent-urls.v1";
const MAX_RECENT_URLS = 10;

type ConvertInput = {
  url: string;
};

type Toast = {
  id: number;
  kind: "error" | "warning";
  message: string;
};

type PersistedHomeState = {
  markdown: string;
  outputMode: "markdown" | "preview" | "plain";
  url: string;
  warnings: string[];
  conversation?: NormalizedConversation;
};

function buildImageCandidates(src: string | undefined): string[] {
  if (!src) {
    return [];
  }

  const candidates = new Set<string>();
  const trimmed = src.trim();

  if (!trimmed) {
    return [];
  }

  candidates.add(trimmed);

  try {
    const url = new URL(trimmed);

    if (url.hostname === "grok.com" && /^\/users\/.+/u.test(url.pathname)) {
      candidates.add(`https://assets.grok.com${url.pathname}`);
      candidates.add(`https://assets.grokusercontent.com${url.pathname}`);
    } else if (
      url.hostname === "assets.grok.com" &&
      /^\/users\/.+/u.test(url.pathname)
    ) {
      candidates.add(`https://assets.grokusercontent.com${url.pathname}`);
    }
  } catch {
    if (/^users\/.+/u.test(trimmed)) {
      candidates.add(`https://assets.grok.com/${trimmed}`);
      candidates.add(`https://assets.grokusercontent.com/${trimmed}`);
    }
  }

  return [...candidates];
}

function getImageReferrerPolicy(
  src: string | undefined,
): React.ImgHTMLAttributes<HTMLImageElement>["referrerPolicy"] | undefined {
  if (!src) {
    return undefined;
  }

  try {
    const url = new URL(src);

    if (
      url.hostname.endsWith("googleusercontent.com") ||
      url.hostname === "lh3.googleusercontent.com"
    ) {
      return "no-referrer";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function PreviewImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const candidates = buildImageCandidates(props.src);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const currentSrc = candidates[candidateIndex] ?? props.src;
  const fallbackHref = candidates.at(-1) ?? props.src;
  const referrerPolicy = getImageReferrerPolicy(currentSrc);

  return (
    <span className="preview-image-wrapper">
      <img
        {...props}
        crossOrigin="anonymous"
        decoding="async"
        loading="eager"
        referrerPolicy={referrerPolicy}
        src={currentSrc}
        onError={() => {
          if (candidateIndex < candidates.length - 1) {
            setCandidateIndex(candidateIndex + 1);
          }
        }}
      />
      {fallbackHref ? (
        <a
          className="preview-image-link"
          href={fallbackHref}
          rel="noreferrer"
          target="_blank"
        >
          Open image
        </a>
      ) : null}
    </span>
  );
}

function getRecentUrls(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_URLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((u): u is string => typeof u === "string")
      : [];
  } catch {
    return [];
  }
}

function addRecentUrl(url: string): void {
  if (typeof window === "undefined") return;
  try {
    const recent = getRecentUrls().filter((u) => u !== url);
    const updated = [url, ...recent].slice(0, MAX_RECENT_URLS);
    window.localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }
}

function removeRecentUrl(url: string): void {
  if (typeof window === "undefined") return;
  try {
    const recent = getRecentUrls().filter((u) => u !== url);
    window.localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(recent));
  } catch {
    // Ignore storage failures
  }
}

const monoCapsClass = "font-mono uppercase tracking-[0.14em]";

// ── Chat message parsing ──────────────────────────────────────────────────

type MessageRole = "user" | "assistant" | "system" | "title";

interface ParsedMessage {
  role: MessageRole;
  /** The raw heading text, e.g. "Assistant (GPT-4o)" */
  heading: string;
  /** The markdown content following the heading */
  content: string;
}

/**
 * Split a full conversation markdown string on `## ` boundaries.
 * The content before the first `## ` heading becomes a 'title' segment.
 */
function parseMarkdownIntoMessages(markdown: string): ParsedMessage[] {
  const segments: ParsedMessage[] = [];
  const parts = markdown.split(/^## /m);

  // First part: everything before any ## heading (title/metadata)
  if (parts[0] && parts[0].trim()) {
    segments.push({ role: "title", heading: "", content: parts[0].trim() });
  }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const newlineIdx = part.indexOf("\n");
    if (newlineIdx === -1) continue;

    const heading = part.slice(0, newlineIdx).trim();
    const content = part.slice(newlineIdx + 1).trim();
    if (!content) continue;

    const lower = heading.toLowerCase();
    let role: MessageRole = "user";
    if (lower.startsWith("assistant") || lower.startsWith("model")) {
      role = "assistant";
    } else if (lower.startsWith("system")) {
      role = "system";
    } else if (lower.startsWith("user")) {
      role = "user";
    } else {
      // Unknown headings — treat as title/passthrough
      role = "title";
    }

    segments.push({ role, heading, content });
  }

  return segments;
}
const persistedHomeStateKey = "chatdump.home-state.v1";

const useCases = [
  {
    id: 1,
    title: "Export AI chat conversations",
    description:
      "Export any AI chat to readable Markdown \u2014 no more copy-pasting messages manually. Copy, or download the file.",
  },
  {
    id: 2,
    title: "Continue conversations elsewhere",
    description:
      "Use the Share dropdown to copy a conversation and continue it in ChatGPT, Claude, or any other AI chat. Get a different perspective on the same context.",
  },
  {
    id: 3,
    title: "Works with any AI platform",
    description:
      "One tool for ChatGPT, Claude, Copilot, Gemini, and Grok. No need to switch between different export methods.",
  },
];

function renderInlineCell(value: string): React.ReactNode {
  const segments: React.ReactNode[] = [];
  let remaining = value;
  let key = 0;

  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(remaining)) !== null) {
    const before = remaining.slice(0, match.index);
    if (before) segments.push(<span key={key++}>{before}</span>);

    const token = match[1];
    if (token.startsWith("**") && token.endsWith("**")) {
      segments.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (
      token.startsWith("*") &&
      token.endsWith("*") &&
      !token.startsWith("**")
    ) {
      segments.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      segments.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        segments.push(
          <a key={key++} href={linkMatch[2]} rel="noreferrer" target="_blank">
            {linkMatch[1]}
          </a>,
        );
      }
    }

    remaining = remaining.slice(match.index + token.length);
  }

  if (remaining) segments.push(<span key={key++}>{remaining}</span>);

  return segments.length > 0 ? <span>{segments}</span> : value;
}

function readPersistedHomeState(): PersistedHomeState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawState = window.sessionStorage.getItem(persistedHomeStateKey);

    if (!rawState) {
      return null;
    }

    const parsedState = JSON.parse(rawState);

    if (typeof parsedState !== "object" || parsedState === null) {
      window.sessionStorage.removeItem(persistedHomeStateKey);
      return null;
    }

    const outputMode = ["preview", "markdown", "plain"].includes(
      parsedState.outputMode,
    )
      ? parsedState.outputMode
      : "markdown";
    const url = typeof parsedState.url === "string" ? parsedState.url : "";
    const markdown =
      typeof parsedState.markdown === "string" ? parsedState.markdown : "";
    const warnings = Array.isArray(parsedState.warnings)
      ? parsedState.warnings.filter(
          (warning: unknown): warning is string => typeof warning === "string",
        )
      : [];
    const conversation = parsedState.conversation || null;

    if (
      !url &&
      !markdown &&
      warnings.length === 0 &&
      outputMode === "preview"
    ) {
      return null;
    }

    return {
      url,
      markdown,
      warnings,
      outputMode: outputMode as any,
      conversation,
    };
  } catch {
    window.sessionStorage.removeItem(persistedHomeStateKey);
    return null;
  }
}

function writePersistedHomeState(state: PersistedHomeState) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(persistedHomeStateKey, JSON.stringify(state));
}

function clearPersistedHomeState() {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(persistedHomeStateKey);
}

const convertShare = createServerFn({ method: "POST" })
  .inputValidator((data: ConvertInput) => ({
    url: data.url.trim(),
  }))
  .handler(async ({ data }) => {
    const { convertShareUrlToMarkdown } = await import("../lib/extract");
    const { ChatdumpError } = await import("../lib/errors");
    const exportedAt = new Date();

    try {
      const result = await convertShareUrlToMarkdown(data.url, { exportedAt });

      return {
        markdown: result.markdown,
        warnings: result.warnings,
        conversation: result.conversation,
      };
    } catch (cause) {
      console.error("[chatdump] Conversion failed", {
        cause: cause instanceof Error ? cause.message : String(cause),
        url: data.url,
      });

      if (cause instanceof ChatdumpError) {
        switch (cause.code) {
          case "INVALID_URL":
            throw new Error("That doesn't look like a valid URL.");
          case "UNSUPPORTED_URL":
            throw new Error(
              "That link isn't supported. Try a ChatGPT, Claude, Copilot, Gemini, or Grok share link.",
            );
          case "FETCH_FAILED":
            throw new Error(
              "Couldn't reach that page. It may no longer be public.",
            );
          case "EXTRACT_FAILED":
            throw new Error(
              "Couldn't extract the conversation. The link may have expired or changed.",
            );
        }
      }

      throw new Error("Something went wrong. Please try again.");
    }
  });

export const Route = createFileRoute("/")({
  component: Home,
});

function detectPlatform(urlStr: string) {
  if (!urlStr) return null;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.includes("chatgpt.com") || hostname.includes("openai.com")) {
      return {
        id: "chatgpt",
        name: "ChatGPT",
        color: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
        logo: "GPT",
        bg: "bg-emerald-500/10",
      };
    }
    if (hostname.includes("claude.ai")) {
      return {
        id: "claude",
        name: "Claude",
        color: "border-amber-500/30 text-amber-600 dark:text-amber-400",
        logo: "Claude",
        bg: "bg-amber-500/10",
      };
    }
    if (
      hostname.includes("copilot.microsoft.com") ||
      hostname.includes("bing.com")
    ) {
      return {
        id: "copilot",
        name: "Copilot",
        color: "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        logo: "Copilot",
        bg: "bg-cyan-500/10",
      };
    }
    if (hostname.includes("gemini.google.com")) {
      return {
        id: "gemini",
        name: "Gemini",
        color: "border-indigo-500/30 text-indigo-600 dark:text-indigo-400",
        logo: "Gemini",
        bg: "bg-indigo-500/10",
      };
    }
    if (hostname.includes("grok.com") || hostname.includes("x.ai")) {
      return {
        id: "grok",
        name: "Grok",
        color:
          "border-slate-800/30 dark:border-slate-200/30 text-slate-800 dark:text-slate-200",
        logo: "Grok",
        bg: "bg-slate-500/10",
      };
    }
    if (hostname.includes("meta.ai")) {
      return {
        id: "meta",
        name: "Meta AI",
        color: "border-blue-500/30 text-blue-600 dark:text-blue-400",
        logo: "Meta",
        bg: "bg-blue-500/10",
      };
    }
  } catch {
    // Ignore
  }
  return null;
}

function Home() {
  const [url, setUrl] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [conversation, setConversation] =
    useState<NormalizedConversation | null>(null);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeSystemMessages, setIncludeSystemMessages] = useState(false);
  const [removeEmojis, setRemoveEmojis] = useState(false);
  const [cleanHtml, setCleanHtml] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [outputMode, setOutputMode] = useState<
    "markdown" | "preview" | "plain"
  >("preview");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hasHydratedState, setHasHydratedState] = useState(false);
  const [recentUrls, setRecentUrls] = useState<string[]>([]);
  const [searchRecent, setSearchRecent] = useState("");
  const [isWhyModalOpen, setIsWhyModalOpen] = useState(false);
  const [showAdvancedModal, setShowAdvancedModal] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const outputSectionRef = useRef<HTMLElement | null>(null);
  const outputBodyRef = useRef<HTMLElement | null>(null);
  const nextToastIdRef = useRef(0);
  const toastTimeoutsRef = useRef(new Map<number, number>());
  const previousFeedbackRef = useRef<{
    error: string | null;
    warnings: string[];
  }>({
    error: null,
    warnings: [],
  });

  const processedMarkdown = useMemo(() => {
    if (!conversation) return markdown;

    // 1. Generate markdown using options
    let md = renderConversationToMarkdown(conversation, {
      includeMetadata,
      includeSystemMessages,
    });

    // 2. Clean Emojis if selected
    if (removeEmojis) {
      const emojiRegex =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F191}-\u{1F251}\u{1F004}\u{1F0CF}\u{1F900}-\u{1F9FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
      md = md.replace(emojiRegex, "");
    }

    // 3. Clean custom HTML tags and comments
    if (cleanHtml) {
      md = md.replace(/<!--[\s\S]*?-->/g, "");
      md = md.replace(/<\/?[a-zA-Z]+(?:\s+[a-zA-Z]+="[^"]*")*\s*\/?>/g, "");
    }

    return md;
  }, [
    conversation,
    markdown,
    includeMetadata,
    includeSystemMessages,
    removeEmojis,
    cleanHtml,
  ]);

  const deferredMarkdown = useDeferredValue(processedMarkdown);
  const hasResult = deferredMarkdown.length > 0;

  const isRenderedPreview = outputMode === "preview";
  const isPlainText = outputMode === "plain";
  const lineCount = hasResult ? deferredMarkdown.split("\n").length : 0;
  const characterCount = hasResult ? deferredMarkdown.length : 0;
  const warningCount = warnings.length;
  const previewSegments = splitMarkdownForPreview(deferredMarkdown);
  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "error"
        ? "Copy failed"
        : ".md";
  const displayMarkdown = isPlainText
    ? stripMarkdown(deferredMarkdown)
    : deferredMarkdown;
  const platform = detectPlatform(url);

  function removeToast(id: number) {
    const timeoutId = toastTimeoutsRef.current.get(id);

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      toastTimeoutsRef.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function clearToasts() {
    toastTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    toastTimeoutsRef.current.clear();
    setToasts([]);
  }

  function pushToast(kind: Toast["kind"], message: string) {
    const id = nextToastIdRef.current + 1;
    nextToastIdRef.current = id;

    setToasts((current) => [...current, { id, kind, message }]);

    const timeoutId = window.setTimeout(
      () => {
        removeToast(id);
      },
      kind === "error" ? 7000 : 5600,
    );

    toastTimeoutsRef.current.set(id, timeoutId);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsPending(true);
    setError(null);
    setCopyState("idle");
    clearToasts();
    addRecentUrl(url);
    setRecentUrls(getRecentUrls());

    startTransition(() => {
      convertShare({
        data: {
          url,
        },
      })
        .then((result) => {
          if (
            !result ||
            typeof result.markdown !== "string" ||
            !Array.isArray(result.warnings)
          ) {
            throw new Error(
              "Received an invalid response while loading this share URL",
            );
          }

          setMarkdown(result.markdown);
          if (result.conversation) {
            setConversation(result.conversation);
          }
          setWarnings(result.warnings);
        })
        .catch((cause) => {
          const message =
            cause instanceof Error ? cause.message : "Conversion failed";

          setError(message);
        })
        .finally(() => {
          setIsPending(false);
        });
    });
  }

  function handleRemoveRecentUrl(urlToRemove: string, event: React.MouseEvent) {
    event.stopPropagation();
    removeRecentUrl(urlToRemove);
    deleteShareConversationCacheEntry(urlToRemove);
    setRecentUrls(getRecentUrls());
  }

  function handleSelectRecentUrl(recentUrl: string) {
    setUrl(recentUrl);
    urlInputRef.current?.focus();
  }

  function handleEditUrl() {
    setMarkdown("");
    setConversation(null);
    setWarnings([]);
    setError(null);
    setOutputMode("preview");
    setCopyState("idle");
    clearToasts();
    previousFeedbackRef.current = {
      error: null,
      warnings: [],
    };

    window.requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    });
  }

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  async function handleCopy() {
    if (!displayMarkdown) {
      return;
    }

    try {
      await navigator.clipboard.writeText(displayMarkdown);
      setCopyState("copied");
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
    }
  }

  function handleDownload() {
    if (!deferredMarkdown) {
      return;
    }

    const title = conversation?.title || "conversation";
    const cleanTitle =
      title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "conversation";

    const blob = new Blob([deferredMarkdown], { type: "text/markdown" });
    const urlBlob = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlBlob;
    a.download = `${cleanTitle}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(urlBlob);
  }

  function handleLogoClick() {
    if (typeof window === "undefined") return;
    localStorage.removeItem("chatdump.home-state.v1");
    localStorage.removeItem("chatdump.recent-urls.v1");
    setUrl("");
    setMarkdown("");
    setConversation(null);
    setWarnings([]);
    setOutputMode("preview");
    setError(null);
    urlInputRef.current?.focus();
  }

  useEffect(() => {
    const previousFeedback = previousFeedbackRef.current;

    if (error && error !== previousFeedback.error) {
      pushToast("error", error);
    }

    const previousWarnings = new Set(previousFeedback.warnings);

    warnings.forEach((warning) => {
      if (!previousWarnings.has(warning)) {
        pushToast("warning", warning);
      }
    });

    previousFeedbackRef.current = {
      error,
      warnings,
    };
  }, [error, warnings]);

  useEffect(() => {
    setRecentUrls(getRecentUrls());
  }, []);

  useEffect(() => {
    return () => {
      toastTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      toastTimeoutsRef.current.clear();
      clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isWhyModalOpen) return;

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsWhyModalOpen(false);
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isWhyModalOpen]);

  useEffect(() => {
    const persistedState = readPersistedHomeState();

    if (persistedState) {
      setUrl(persistedState.url);
      setMarkdown(persistedState.markdown);
      setWarnings(persistedState.warnings);
      setOutputMode(persistedState.outputMode as any);
      if (persistedState.conversation) {
        setConversation(persistedState.conversation);
      }
      previousFeedbackRef.current = {
        error: null,
        warnings: persistedState.warnings,
      };
    }

    setHasHydratedState(true);
  }, []);

  useEffect(() => {
    if (!hasHydratedState) {
      return;
    }

    if (
      !url &&
      !markdown &&
      warnings.length === 0 &&
      outputMode === "preview"
    ) {
      clearPersistedHomeState();
      return;
    }

    try {
      writePersistedHomeState({
        url,
        markdown,
        warnings,
        outputMode: outputMode as any,
        conversation: conversation || undefined,
      });
    } catch {
      // Ignore storage failures and keep the in-memory state intact.
    }
  }, [hasHydratedState, markdown, outputMode, url, warnings, conversation]);

  useEffect(() => {
    if (!hasResult) {
      return;
    }

    outputSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [hasResult]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredRecentUrls = recentUrls.filter((u) =>
    u.toLowerCase().includes(searchRecent.toLowerCase()),
  );

  return (
    <main className="app-frame font-sans">
      {toasts.length > 0 ? (
        <div
          aria-live="polite"
          className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] gap-2.5"
        >
          {toasts.map((toast) => (
            <div
              className={cn(
                "pointer-events-auto grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border p-3.5 pr-3 pl-4 shadow-lg backdrop-blur-md transition-all duration-300 animate-slide-up",
                toast.kind === "error"
                  ? "border-rose-200 bg-rose-50/95 dark:bg-rose-950/90 dark:border-rose-900/50 text-rose-800 dark:text-rose-200"
                  : "border-amber-200 bg-amber-50/95 dark:bg-amber-950/90 dark:border-amber-900/50 text-amber-800 dark:text-amber-200",
              )}
              key={toast.id}
              role={toast.kind === "error" ? "alert" : "status"}
            >
              <div className="grid gap-[0.2rem]">
                <p
                  className={cn(
                    monoCapsClass,
                    "font-mono text-[0.68rem] font-bold uppercase tracking-wider",
                    toast.kind === "error"
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {toast.kind === "error" ? "Error" : "Warning"}
                </p>
                <p className="text-[0.85rem] leading-[1.5] font-medium">
                  {toast.message}
                </p>
              </div>

              <button
                aria-label={`Dismiss ${toast.kind}`}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-paper/50 hover:bg-paper-raised text-ink-soft hover:text-ink transition-colors"
                type="button"
                onClick={() => removeToast(toast.id)}
              >
                <span
                  aria-hidden="true"
                  className="inline-block rotate-45 text-base leading-none"
                >
                  +
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isWhyModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
          onClick={() => setIsWhyModalOpen(false)}
        >
          <div
            className="panel-shell w-full max-w-lg p-6 max-[720px]:p-5 animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-5 border-b border-line">
              <h2 className="text-[1.05rem] font-bold text-ink">
                Why use chatdump?
              </h2>
              <button
                type="button"
                onClick={() => setIsWhyModalOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line bg-paper/50 text-ink-soft hover:text-ink transition-colors"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>

            <div className="grid gap-5 mt-5">
              {useCases.map((useCase) => (
                <div
                  key={useCase.id}
                  className="rounded-lg border border-line bg-paper-elevated p-4 shadow-sm"
                >
                  <div className="mb-2 flex items-center gap-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded bg-accent/10 text-accent text-[0.8rem] font-bold">
                      {useCase.id}
                    </span>
                    <h3 className="font-bold text-ink">{useCase.title}</h3>
                  </div>
                  <p className="text-[0.82rem] leading-relaxed text-ink-muted">
                    {useCase.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto grid max-w-[1380px] gap-6">
        <header className="sticky top-0 z-30 -mx-1 border-b border-line bg-paper/80 px-1 py-2 backdrop-blur-xl flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={handleLogoClick}
            className="flex items-center gap-[0.9rem] rounded-lg p-1 -m-1 transition-opacity hover:opacity-75"
            aria-label="Deep refresh"
          >
            <span className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-paper-elevated shadow-sm">
              <img
                src="/logo-mark.svg"
                alt="chatdump logo"
                className="h-6 w-6 object-contain"
              />
            </span>
            <span className="font-mono text-sm font-bold uppercase tracking-wider text-ink">
              chatdump
            </span>
          </button>

          {!hasResult && (
            <button
              type="button"
              onClick={() => setIsWhyModalOpen(true)}
              className="rounded-md border border-line bg-paper px-4 py-1.5 text-[0.75rem] font-bold uppercase tracking-wider text-ink-soft hover:bg-paper-raised hover:text-ink transition-colors"
            >
              Why use chatdump
            </button>
          )}
        </header>

        <div className="grid gap-6">
          {!hasResult ? (
            <div className="grid gap-6 animate-fade-in">
              {/* Bento Grid layout */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Large URL Input Bento Item */}
                <section className="lg:col-span-2 panel-shell flex flex-col justify-between p-6 md:p-8 hover:-translate-y-0.5 hover:shadow-md transition-all">
                  <div>
                    <h1 className="text-[clamp(2.2rem,5vw,3.6rem)] font-extrabold leading-[1.05] tracking-tight mb-3">
                      Turn public share links into{" "}
                      <span className="text-accent font-extrabold">Markdown</span>
                      .
                    </h1>
                    <p className="text-[0.95rem] leading-[1.6] text-ink-muted mb-6">
                      Paste a supported ChatGPT, Claude, Copilot, Gemini, Grok,
                      or Meta AI share URL to extract and export clean,
                      structured Markdown.
                    </p>
                  </div>

                  <form onSubmit={handleSubmit} className="grid gap-3.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs uppercase tracking-wider text-ink-soft">
                        Enter public share link
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="hidden sm:inline-block text-[0.65rem] font-mono px-1.5 py-0.5 rounded border border-line bg-paper text-ink-soft">
                          Press ⌘K to focus
                        </span>
                        {platform && (
                          <span
                            className={cn(
                              "text-[0.65rem] font-mono font-bold uppercase px-1.5 py-0.5 rounded",
                              platform.bg,
                              platform.color,
                            )}
                          >
                            {platform.name} Link Detected
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 border border-line-strong focus-within:border-accent bg-paper-inset rounded-xl p-2.5 pl-4 shadow-sm transition-all focus-within:bg-paper-raised focus-within:ring-4 focus-within:ring-accent/15 focus-within:shadow-[0_16px_40px_-20px_rgba(79,70,229,0.45)]">
                      <svg
                        aria-hidden="true"
                        className="h-[1.1rem] w-[1.1rem] text-ink-soft"
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M14 5h5v5M10 14 19 5M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"
                          className="fill-none stroke-current stroke-[1.9] stroke-linecap-round stroke-linejoin-round"
                        />
                      </svg>
                      <input
                        autoComplete="off"
                        className="flex-1 bg-transparent border-none outline-none font-mono text-[0.9rem] text-ink placeholder:text-ink-soft"
                        inputMode="url"
                        name="url"
                        placeholder="https://chatgpt.com/share/... or claude.ai/share/..."
                        ref={urlInputRef}
                        required
                        type="url"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                      <Button
                        disabled={isPending}
                        type="submit"
                        variant="primary"
                        className="min-h-10 px-4 py-1.5 rounded-md"
                      >
                        <span>{isPending ? "Converting..." : "Convert"}</span>
                      </Button>
                    </div>
                  </form>
                </section>

                {/* History Bento Item */}
                <section className="panel-shell p-6 flex flex-col justify-between hover:-translate-y-0.5 hover:shadow-md transition-all">
                  <div>
                    <div className="flex items-center justify-between mb-4 pb-2 border-b border-line">
                      <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-ink">
                        Recent History
                      </h2>
                      {recentUrls.length > 0 && (
                        <input
                          type="text"
                          placeholder="Search..."
                          value={searchRecent}
                          onChange={(e) => setSearchRecent(e.target.value)}
                          className="w-24 px-1.5 py-0.5 text-[0.7rem] border border-line rounded bg-paper-inset text-ink outline-none"
                        />
                      )}
                    </div>

                    {recentUrls.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-center border border-dashed border-line rounded-lg">
                        <span className="mb-2 grid h-10 w-10 place-items-center rounded-full bg-paper-inset text-ink-soft">
                          <ClipboardList aria-hidden="true" className="h-5 w-5" />
                        </span>
                        <p className="text-xs text-ink-soft">
                          No conversions yet.
                        </p>
                      </div>
                    ) : filteredRecentUrls.length === 0 ? (
                      <p className="text-xs text-ink-soft py-4">
                        No matching URLs found.
                      </p>
                    ) : (
                      <div className="grid gap-2.5 max-h-[16rem] overflow-y-auto pr-1">
                        {filteredRecentUrls.map((recentUrl) => {
                          const recentPlatform = detectPlatform(recentUrl) || {
                            name: "AI Link",
                            color: "text-slate-400 border-slate-400/20",
                            bg: "bg-slate-400/10",
                          };
                          return (
                            <div
                              key={recentUrl}
                              onClick={() => handleSelectRecentUrl(recentUrl)}
                              className="group relative flex flex-col gap-1 p-2.5 rounded-md border border-line bg-paper/50 hover:bg-paper-raised cursor-pointer transition-all hover:border-accent/30"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={cn(
                                    "text-[0.58rem] font-mono font-bold uppercase px-1.5 py-0.5 rounded",
                                    recentPlatform.bg,
                                    recentPlatform.color,
                                  )}
                                >
                                  {recentPlatform.name}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) =>
                                    handleRemoveRecentUrl(recentUrl, e)
                                  }
                                  className="text-xs text-ink-soft hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
                                  title="Remove from history"
                                >
                                  ×
                                </button>
                              </div>
                              <span className="font-mono text-[0.68rem] text-ink-muted truncate">
                                {recentUrl}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="pt-4 border-t border-line mt-4 flex items-center justify-between text-[0.72rem] text-ink-soft">
                    <span>Clean Markdown</span>
                    <span>No data stored on server</span>
                  </div>
                </section>
              </div>

              {/* Three Bento Feature Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-5 rounded-lg border border-line bg-paper-elevated shadow-sm hover:shadow-md transition-all hover:border-accent/20">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded bg-accent/10 text-accent">
                    <svg
                      aria-hidden="true"
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"
                        className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </div>
                  <h3 className="font-bold text-ink mb-1">
                    Visual & MD Export
                  </h3>
                  <p className="text-[0.82rem] leading-relaxed text-ink-muted">
                    Export complete chat logs into clean, readable Markdown,
                    plain text, or rich responsive preview.
                  </p>
                </div>

                <div className="p-5 rounded-lg border border-line bg-paper-elevated shadow-sm hover:shadow-md transition-all hover:border-accent/20">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded bg-accent/10 text-accent">
                    <svg
                      aria-hidden="true"
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M16 6l-4-4-4 4M12 2v13M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"
                        className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </div>
                  <h3 className="font-bold text-ink mb-1">Continue Context</h3>
                  <p className="text-[0.82rem] leading-relaxed text-ink-muted">
                    Seamlessly transition to a different model (ChatGPT, Claude,
                    Gemini, Copilot, Grok) with one-click share context.
                  </p>
                </div>

                <div className="p-5 rounded-lg border border-line bg-paper-elevated shadow-sm hover:shadow-md transition-all hover:border-accent/20">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded bg-accent/10 text-accent">
                    <svg
                      aria-hidden="true"
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM9 9h6M9 13h6"
                        className="fill-none stroke-current stroke-[1.8] stroke-linecap-round stroke-linejoin-round"
                      />
                    </svg>
                  </div>
                  <h3 className="font-bold text-ink mb-1">Multi-Platform</h3>
                  <p className="text-[0.82rem] leading-relaxed text-ink-muted">
                    Universal compatibility: fully supports standard export
                    patterns of all major AI web products.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {isPending && !hasResult ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4 border border-line bg-paper-elevated rounded-lg animate-pulse">
              <span className="font-mono text-xs uppercase tracking-[0.15em] text-ink-soft">
                Converting share link context...
              </span>
              <div className="relative w-64 h-2 bg-paper-inset border border-line rounded-full overflow-hidden">
                <div className="absolute top-0 bottom-0 w-8 h-full bg-accent rounded-full animate-pipeline" />
              </div>
            </div>
          ) : null}

          {hasResult ? (
            <div className="grid gap-6 animate-fade-in">
              <div className="grid grid-cols-1 gap-6 items-start">
                {/* Left Column: Exported Chat Content (Occupies 8/12 or 9/12 cols) */}
                <section
                  className="panel-shell flex flex-col h-[calc(100vh-6rem)] md:h-[calc(100vh-8rem)] p-4 gap-4"
                  ref={outputSectionRef}
                >
                  {/* Sticky floating toolbar */}
                  <div className="sticky top-0 z-10 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-paper-elevated/85 backdrop-blur-md border border-line p-3 rounded-lg shadow-sm">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleEditUrl}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-ink-soft hover:bg-paper-raised hover:text-ink transition-colors"
                        aria-label="Edit URL"
                      >
                        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                        Back
                      </button>

                      <span className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
                        {lineCount} L • {characterCount} C
                      </span>
                    </div>

                    {/* Tabs */}
                    <div className="flex border border-line bg-paper-inset p-0.5 rounded-lg">
                      {(["preview", "markdown", "plain"] as const).map(
                        (tabId) => (
                          <button
                            key={tabId}
                            type="button"
                            onClick={() => setOutputMode(tabId)}
                            className={cn(
                              "px-2.5 py-1 text-[0.68rem] font-mono font-semibold uppercase tracking-wider rounded-md transition-all",
                              outputMode === tabId
                                ? "bg-paper-elevated text-ink shadow-sm border border-line-strong"
                                : "text-ink-soft hover:text-ink",
                            )}
                          >
                            {tabId === "preview"
                              ? "Preview"
                              : tabId === "markdown"
                                ? "Markdown"
                                : "Plain"}
                          </button>
                        ),
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {/* Advanced Options trigger */}
                      <button
                        type="button"
                        aria-label="Advanced Options"
                        onClick={() => setShowAdvancedModal(true)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 font-mono text-[0.7rem] uppercase tracking-[0.06em] text-ink-soft hover:bg-paper-raised hover:text-ink transition-colors"
                      >
                        <SlidersHorizontal
                          aria-hidden="true"
                          className="h-3.5 w-3.5"
                        />
                        Options
                      </button>

                      <Button
                        aria-label={copyLabel}
                        className="min-h-8 h-8 px-3 rounded-md gap-1.5"
                        onClick={handleCopy}
                      >
                        {copyState === "copied" ? (
                          <Check
                            aria-hidden="true"
                            className="h-[0.95rem] w-[0.95rem] text-accent"
                          />
                        ) : (
                          <Copy
                            aria-hidden="true"
                            className="h-[0.95rem] w-[0.95rem]"
                          />
                        )}
                        <span className="text-xs">{copyLabel}</span>
                      </Button>

                      <Button
                        aria-label="Download
                        "
                        className="min-h-8 h-8 px-3 rounded-md gap-1.5"
                        onClick={handleDownload}
                      >
                        <Download
                          aria-hidden="true"
                          className="h-[0.95rem] w-[0.95rem]"
                        />
                        <span className="text-xs">.md</span>
                      </Button>
                    </div>
                  </div>

                  {/* View Panes */}
                  <div className="flex-1 min-h-0 overflow-hidden relative">
                    <div className="h-full">
                      {/* Left Pane (Preview) — chat message cards */}
                      {outputMode === "preview" && (
                        <article
                          className="output-surface h-full overflow-auto leading-[1.68] text-ink"
                          ref={(node) => {
                            outputBodyRef.current = node;
                          }}
                          tabIndex={0}
                        >
                          {/* Shared ReactMarkdown component configs */}
                          {(() => {
                            // Build the common ReactMarkdown components once
                            const mdComponents: React.ComponentProps<
                              typeof ReactMarkdown
                            >["components"] = {
                              a: ({ node: _node, ...props }) => (
                                <a
                                  {...props}
                                  rel="noreferrer"
                                  target="_blank"
                                />
                              ),
                              img: ({ node: _node, ...props }) => (
                                <PreviewImage {...props} />
                              ),
                              pre: ({ node: _node, children, ...props }) => {
                                const getTextContent = (
                                  child: React.ReactNode,
                                ): string => {
                                  if (typeof child === "string") return child;
                                  if (typeof child === "number")
                                    return String(child);
                                  if (!child) return "";
                                  if (Array.isArray(child))
                                    return child.map(getTextContent).join("");
                                  if (
                                    typeof child === "object" &&
                                    child !== null &&
                                    "props" in child
                                  ) {
                                    const el = child as unknown as {
                                      props: { children?: React.ReactNode };
                                    };
                                    return getTextContent(el.props.children);
                                  }
                                  return "";
                                };
                                const textContent = getTextContent(children);
                                if (!textContent.trim()) return null;
                                let lang: string | undefined;
                                const firstChild = Array.isArray(children)
                                  ? children[0]
                                  : children;
                                if (
                                  firstChild &&
                                  typeof firstChild === "object" &&
                                  "props" in firstChild
                                ) {
                                  const el = firstChild as unknown as {
                                    props: { className?: string };
                                  };
                                  const cls = el.props.className;
                                  if (typeof cls === "string") {
                                    const match = cls.match(/language-(\S+)/);
                                    if (match) lang = match[1];
                                  }
                                }
                                return (
                                  <div className="code-block-wrapper">
                                    {lang ? (
                                      <span className="code-block-lang">
                                        {lang}
                                      </span>
                                    ) : null}
                                    <pre {...props}>{children}</pre>
                                  </div>
                                );
                              },
                              hr: ({ node: _node, ...props }) => (
                                <hr {...props} />
                              ),
                            };

                            // Parse markdown into typed message segments
                            const messages =
                              parseMarkdownIntoMessages(deferredMarkdown);
                            const hasMessages = messages.some(
                              (m) => m.role !== "title",
                            );

                            // If no role-based messages detected, fall back to flat render
                            if (!hasMessages) {
                              return previewSegments.map((segment, index) => {
                                if (segment.kind === "table") {
                                  const tableMd = [
                                    `| ${segment.headers.join(" | ")} |`,
                                    `| ${segment.headers.map(() => "---").join(" | ")} |`,
                                    ...segment.rows.map(
                                      (row) => `| ${row.join(" | ")} |`,
                                    ),
                                  ].join("\n");
                                  return (
                                    <div
                                      className="table-scroll-wrapper"
                                      key={`table-${index}`}
                                    >
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                          table: ({
                                            node: _node,
                                            ...props
                                          }) => <table {...props} />,
                                        }}
                                      >
                                        {tableMd}
                                      </ReactMarkdown>
                                    </div>
                                  );
                                }
                                return (
                                  <ReactMarkdown
                                    key={`markdown-${index}`}
                                    remarkPlugins={[remarkGfm]}
                                    rehypePlugins={[rehypeHighlight]}
                                    components={mdComponents}
                                  >
                                    {segment.content}
                                  </ReactMarkdown>
                                );
                              });
                            }

                            // Render as structured chat message cards
                            return (
                              <div className="chat-messages-list flex flex-col gap-3 p-1">
                                {messages.map((msg, idx) => {
                                  if (msg.role === "title") {
                                    // Title/metadata block — flat render, no card wrapper
                                    return (
                                      <div
                                        key={`title-${idx}`}
                                        className="markdown-preview pb-1 mb-1 border-b border-line"
                                      >
                                        <ReactMarkdown
                                          remarkPlugins={[remarkGfm]}
                                          rehypePlugins={[rehypeHighlight]}
                                          components={mdComponents}
                                        >
                                          {msg.content}
                                        </ReactMarkdown>
                                      </div>
                                    );
                                  }

                                  // Extract model name from assistant headings like "Assistant (GPT-4o)"
                                  const modelMatch =
                                    msg.role === "assistant"
                                      ? msg.heading.match(/\(([^)]+)\)/)
                                      : null;
                                  const modelName = modelMatch
                                    ? modelMatch[1]
                                    : null;

                                  // Split the message content through previewSegments so tables still get their wrapper
                                  const msgSegments = splitMarkdownForPreview(
                                    msg.content,
                                  );

                                  return (
                                    <div
                                      key={`msg-${idx}`}
                                      className="chat-message"
                                      data-role={msg.role}
                                    >
                                      <div className="chat-message-header">
                                        {msg.role === "user" && (
                                          <User
                                            aria-hidden="true"
                                            className="h-3.5 w-3.5 shrink-0"
                                          />
                                        )}
                                        {msg.role === "assistant" && (
                                          <Bot
                                            aria-hidden="true"
                                            className="h-3.5 w-3.5 shrink-0"
                                          />
                                        )}
                                        {msg.role === "system" && (
                                          <>
                                            <Shield
                                              aria-hidden="true"
                                              className="h-3.5 w-3.5 shrink-0"
                                            />
                                            <span>System</span>
                                          </>
                                        )}
                                      </div>
                                      <div className="chat-message-body markdown-preview">
                                        {msgSegments.map((segment, segIdx) => {
                                          if (segment.kind === "table") {
                                            const tableMd = [
                                              `| ${segment.headers.join(" | ")} |`,
                                              `| ${segment.headers.map(() => "---").join(" | ")} |`,
                                              ...segment.rows.map(
                                                (row) =>
                                                  `| ${row.join(" | ")} |`,
                                              ),
                                            ].join("\n");
                                            return (
                                              <div
                                                className="table-scroll-wrapper"
                                                key={`seg-table-${segIdx}`}
                                              >
                                                <ReactMarkdown
                                                  remarkPlugins={[remarkGfm]}
                                                  components={{
                                                    table: ({
                                                      node: _node,
                                                      ...props
                                                    }) => <table {...props} />,
                                                  }}
                                                >
                                                  {tableMd}
                                                </ReactMarkdown>
                                              </div>
                                            );
                                          }
                                          return (
                                            <ReactMarkdown
                                              key={`seg-md-${segIdx}`}
                                              remarkPlugins={[remarkGfm]}
                                              rehypePlugins={[rehypeHighlight]}
                                              components={mdComponents}
                                            >
                                              {segment.content}
                                            </ReactMarkdown>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </article>
                      )}

                      {/* Right Pane (Markdown / Plain) */}
                      {(outputMode === "markdown" ||
                        outputMode === "plain") && (
                        <pre
                          className="output-surface m-0 h-full overflow-auto whitespace-pre-wrap font-mono text-[0.88rem] leading-[1.65] text-ink"
                          ref={(node) => {
                            outputBodyRef.current = node;
                          }}
                          tabIndex={0}
                        >
                          {displayMarkdown}
                        </pre>
                      )}
                    </div>

                    {/* Animated copy success celebration overlay */}
                    {copyState === "copied" && (
                      <div className="absolute inset-0 bg-accent/5 flex items-center justify-center pointer-events-none z-30 animate-fade-in">
                        <div className="bg-paper border border-accent text-accent text-xs font-mono font-bold px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-bounce">
                          <Check aria-hidden="true" className="h-4 w-4" />
                          SUCCESSFULLY COPIED TO CLIPBOARD! 🎉
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>

              {/* Bottom: Continue Chat (collapsible as before) */}
              <ChatContinuation markdown={deferredMarkdown} />
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Advanced Options Modal ── */}
      {showAdvancedModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Advanced Options"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowAdvancedModal(false)}
          />

          {/* Panel */}
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-border-contrast bg-paper-solid-elevated shadow-2xl overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-border-contrast px-6 py-4 bg-paper-solid">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
                </span>
                <span className="text-[0.9rem] font-extrabold text-ink uppercase tracking-wide">
                  Advanced Options
                </span>
              </div>
              <button
                type="button"
                aria-label="Close Advanced Options"
                onClick={() => setShowAdvancedModal(false)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-soft hover:bg-paper-raised hover:text-ink transition-colors"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>

            {/* Options */}
            <div className="p-6 flex flex-col gap-5">
              <label className="flex items-start gap-4 cursor-pointer group">
                <input
                  type="checkbox"
                  id="opt-metadata"
                  checked={includeMetadata}
                  onChange={(e) => setIncludeMetadata(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-contrast text-accent focus:ring-accent/20 cursor-pointer"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.82rem] font-bold text-ink group-hover:text-accent transition-colors">
                    Include Metadata Header
                  </span>
                  <span className="text-[0.72rem] text-ink-soft leading-relaxed">
                    Add the source URL, export date, and chat creator to the top
                    of the file.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-4 cursor-pointer group">
                <input
                  type="checkbox"
                  id="opt-system"
                  checked={includeSystemMessages}
                  onChange={(e) => setIncludeSystemMessages(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-contrast text-accent focus:ring-accent/20 cursor-pointer"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.82rem] font-bold text-ink group-hover:text-accent transition-colors">
                    Include System Prompts
                  </span>
                  <span className="text-[0.72rem] text-ink-soft leading-relaxed">
                    Export any internal developer instructions or system roles
                    from the session.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-4 cursor-pointer group">
                <input
                  type="checkbox"
                  id="opt-emojis"
                  checked={removeEmojis}
                  onChange={(e) => setRemoveEmojis(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-contrast text-accent focus:ring-accent/20 cursor-pointer"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.82rem] font-bold text-ink group-hover:text-accent transition-colors">
                    Clean Emojis
                  </span>
                  <span className="text-[0.72rem] text-ink-soft leading-relaxed">
                    Strip all graphical emojis from the output text for a
                    cleaner documentation format.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-4 cursor-pointer group">
                <input
                  type="checkbox"
                  id="opt-html"
                  checked={cleanHtml}
                  onChange={(e) => setCleanHtml(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-contrast text-accent focus:ring-accent/20 cursor-pointer"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[0.82rem] font-bold text-ink group-hover:text-accent transition-colors">
                    Strip HTML Tags
                  </span>
                  <span className="text-[0.72rem] text-ink-soft leading-relaxed">
                    Remove raw HTML tags and comments to leave only pure
                    Markdown syntax.
                  </span>
                </div>
              </label>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-border-contrast px-6 py-4 bg-paper-solid">
              <button
                type="button"
                onClick={() => setShowAdvancedModal(false)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-paper px-4 font-mono text-[0.72rem] uppercase tracking-wider text-ink-soft hover:bg-paper-raised hover:text-ink transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
