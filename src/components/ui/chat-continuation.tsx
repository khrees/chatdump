import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "../../lib/cn";
import {
  Bot,
  User,
  Send,
  Square,
  Settings,
  ChevronUp,
  X,
  RotateCcw,
  ExternalLink,
  MessageSquare,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  CLOUD_MODELS,
  WEB_APPS,
  PROVIDER_LABELS,
  fetchLocalModels as libFetchLocalModels,
  streamChatCompletion as libStreamChatCompletion,
  streamOpenAICompat,
} from "../../lib/chat";
import type { ChatProvider, ProviderSettings } from "../../lib/chat";

const CHAT_SETTINGS_KEY = "chatdump.chat-settings.v1";

interface ChatSettings {
  openai: ProviderSettings;
  anthropic: ProviderSettings;
  google: ProviderSettings;
  grok: ProviderSettings;
  mistral: ProviderSettings;
  ollama: ProviderSettings;
  lmstudio: ProviderSettings;
  custom: ProviderSettings;
  webapp: ProviderSettings;
  selectedProvider: ChatProvider;
  selectedModel: string;
}

interface ContinuationMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  provider?: ChatProvider;
}

const DEFAULT_SETTINGS: ChatSettings = {
  openai: { apiKey: "", baseUrl: "https://api.openai.com", enabled: false },
  anthropic: {
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
    enabled: false,
  },
  google: {
    apiKey: "",
    baseUrl: "https://generativelanguage.googleapis.com",
    enabled: false,
  },
  grok: { apiKey: "", baseUrl: "https://api.x.ai", enabled: false },
  mistral: { apiKey: "", baseUrl: "https://api.mistral.ai", enabled: false },
  ollama: { apiKey: "", baseUrl: "http://localhost:11434", enabled: false },
  lmstudio: { apiKey: "", baseUrl: "http://localhost:1234", enabled: false },
  custom: { apiKey: "", baseUrl: "", enabled: false },
  webapp: { apiKey: "", baseUrl: "", enabled: true },
  selectedProvider: "webapp",
  selectedModel: "chatgpt-web",
};

const monoCapsClass = "font-mono uppercase tracking-[0.14em]";

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn("Clipboard API failed, using fallback:", err);
    }
  }

  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error("Fallback copy failed:", err);
    return false;
  }
}

function loadSettings(): ChatSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(CHAT_SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: ChatSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures
  }
}

function conversationMarkdownToMessages(
  markdown: string,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] =
    [];
  const sections = markdown.split(/^## /m).slice(1);

  for (const section of sections) {
    const newlineIndex = section.indexOf("\n");
    if (newlineIndex === -1) continue;

    const heading = section.slice(0, newlineIndex).trim().toLowerCase();
    const content = section.slice(newlineIndex + 1).trim();

    if (!content) continue;

    let role: "user" | "assistant" | "system" = "user";
    if (heading.startsWith("assistant") || heading.startsWith("model")) {
      role = "assistant";
    } else if (heading.startsWith("system")) {
      role = "system";
    }

    messages.push({ role, content });
  }

  return messages;
}

interface ChatContinuationProps {
  markdown: string;
  disableCollapse?: boolean;
  className?: string;
}

export function ChatContinuation({
  markdown,
  disableCollapse = false,
  className,
}: ChatContinuationProps) {
  const [isExpanded, setIsExpanded] = useState(disableCollapse);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [continuationMessages, setContinuationMessages] = useState<
    ContinuationMessage[]
  >([]);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editableContext, setEditableContext] = useState("");
  const [contextEdited, setContextEdited] = useState(false);
  const [showContext, setShowContext] = useState(false);
  // Remember last route per mode so the API/Web-app toggle never loses it
  const lastApiRoute = useRef<{
    provider: ChatProvider;
    model: string;
  } | null>(null);
  const lastWebappModel = useRef<string | null>(null);

  // Compute a unique key for localStorage based on the base markdown's content
  const storageKey = useMemo(() => {
    if (!markdown) return null;
    let hash = 0;
    for (let i = 0; i < Math.min(markdown.length, 1000); i++) {
      const char = markdown.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return `chatdump.continuation.${hash}`;
  }, [markdown]);

  // Load saved continuation messages when the base markdown changes
  useEffect(() => {
    if (!storageKey) {
      setContinuationMessages([]);
      return;
    }
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        setContinuationMessages(JSON.parse(saved));
      } else {
        setContinuationMessages([]);
      }
    } catch {
      setContinuationMessages([]);
    }
  }, [storageKey]);

  // Persist continuation messages to localStorage whenever they change
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (continuationMessages.length > 0) {
        localStorage.setItem(storageKey, JSON.stringify(continuationMessages));
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      // Ignore storage failures
    }
  }, [continuationMessages, storageKey]);

  // Auto-dismiss error toast after 7 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      setError(null);
    }, 7000);
    return () => clearTimeout(timer);
  }, [error]);

  const [localModels, setLocalModels] = useState<
    { id: string; name: string; provider: ChatProvider }[]
  >([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    Record<ChatProvider, "idle" | "testing" | "ok" | "fail">
  >({
    openai: "idle",
    anthropic: "idle",
    google: "idle",
    grok: "idle",
    mistral: "idle",
    ollama: "idle",
    lmstudio: "idle",
    custom: "idle",
    webapp: "idle",
  });
  const [activeCloudEdit, setActiveCloudEdit] = useState<
    "openai" | "anthropic" | "google" | "grok" | "mistral"
  >("openai");
  const [activeLocalEdit, setActiveLocalEdit] = useState<
    "ollama" | "lmstudio" | "custom"
  >("ollama");

  // Synchronize active cloud and local edit providers with selected provider
  useEffect(() => {
    if (isSettingsOpen) {
      if (
        ["openai", "anthropic", "google", "grok", "mistral"].includes(
          settings.selectedProvider,
        )
      ) {
        setActiveCloudEdit(settings.selectedProvider as any);
      } else if (
        ["ollama", "lmstudio", "custom"].includes(settings.selectedProvider)
      ) {
        setActiveLocalEdit(settings.selectedProvider as any);
      }
    }
  }, [isSettingsOpen, settings.selectedProvider]);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Synchronize isExpanded with disableCollapse
  useEffect(() => {
    if (disableCollapse) {
      setIsExpanded(true);
    }
  }, [disableCollapse]);

  // Load settings on mount
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Save settings when they change
  const updateSettings = useCallback((update: Partial<ChatSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...update };
      saveSettings(next);
      return next;
    });
  }, []);

  const updateProviderSettings = useCallback(
    (provider: ChatProvider, update: Partial<ProviderSettings>) => {
      setSettings((prev) => {
        const next = {
          ...prev,
          [provider]: { ...prev[provider], ...update },
        };
        saveSettings(next);
        return next;
      });
    },
    [],
  );

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [continuationMessages, streamingContent]);

  // Get available models for current provider
  const availableModels =
    settings.selectedProvider === "ollama" ||
    settings.selectedProvider === "lmstudio" ||
    settings.selectedProvider === "custom"
      ? localModels.filter((m) => m.provider === settings.selectedProvider)
      : settings.selectedProvider === "webapp"
        ? WEB_APPS.map((w) => ({
            id: w.id,
            name: w.name,
            provider: "webapp" as ChatProvider,
          }))
        : CLOUD_MODELS.filter((m) => m.provider === settings.selectedProvider);

  const selectedModelName =
    settings.selectedProvider === "webapp"
      ? (WEB_APPS.find((w) => w.id === settings.selectedModel)?.name ??
        settings.selectedModel)
      : (availableModels.find((m) => m.id === settings.selectedModel)?.name ??
        settings.selectedModel ??
        "No model selected");

  // Fetch local models
  async function handleFetchModels(provider: ChatProvider) {
    setIsFetchingModels(true);
    const baseUrl = settings[provider].baseUrl;
    const models = await libFetchLocalModels(provider as any, baseUrl);
    setLocalModels((prev) => [
      ...prev.filter((m) => m.provider !== provider),
      ...models.map((m) => ({ id: m.id, name: m.name, provider: m.provider })),
    ]);
    if (
      models.length > 0 &&
      (!settings.selectedModel || settings.selectedProvider !== provider)
    ) {
      updateSettings({
        selectedModel: models[0]!.id,
        selectedProvider: provider,
      });
    }
    setIsFetchingModels(false);
  }

  // Test connection
  async function handleTestConnection(provider: ChatProvider) {
    setConnectionStatus((prev) => ({ ...prev, [provider]: "testing" }));
    try {
      const baseUrl = settings[provider].baseUrl.replace(/\/+$/, "");
      if (provider === "ollama") {
        const r = await fetch(`${baseUrl}/api/tags`);
        setConnectionStatus((prev) => ({
          ...prev,
          [provider]: r.ok ? "ok" : "fail",
        }));
      } else if (provider === "lmstudio" || provider === "custom") {
        const r = await fetch(`${baseUrl}/v1/models`);
        setConnectionStatus((prev) => ({
          ...prev,
          [provider]: r.ok ? "ok" : "fail",
        }));
      } else {
        // Cloud providers — just check if key is set
        setConnectionStatus((prev) => ({
          ...prev,
          [provider]: settings[provider].apiKey ? "ok" : "fail",
        }));
      }
    } catch {
      setConnectionStatus((prev) => ({ ...prev, [provider]: "fail" }));
    }
  }

  // Send message
  async function handleSend() {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;
    if (!settings.selectedModel) {
      setError("Select a model first. Open settings with the ⚙ button.");
      return;
    }

    const provider = settings.selectedProvider;
    const providerSettings = settings[provider];

    // Pre-check for missing cloud API keys
    if (
      ["openai", "anthropic", "grok", "mistral", "google"].includes(provider) &&
      !providerSettings.apiKey
    ) {
      setError(
        `API key is missing for ${PROVIDER_LABELS[provider] || provider}. Please click the settings button (⚙) to enter your API key.`,
      );
      return;
    }

    setError(null);
    setInputValue("");

    const userMessage: ContinuationMessage = { role: "user", content: trimmed };
    setContinuationMessages((prev) => [...prev, userMessage]);

    // Build full message history
    const historyMessages = conversationMarkdownToMessages(markdown);
    const continuationChatMessages = continuationMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const allMessages = [
      ...historyMessages,
      ...continuationChatMessages,
      { role: "user" as const, content: trimmed },
    ];

    setIsStreaming(true);
    setStreamingContent("");

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      let fullContent = "";

      if (settings.selectedProvider === "webapp") {
        throw new Error("Web Apps do not support direct API streaming.");
      }

      const stream = libStreamChatCompletion({
        provider: settings.selectedProvider as any,
        model: settings.selectedModel,
        messages: allMessages,
        providerConfig: {
          apiKey: settings[provider].apiKey,
          baseUrl: settings[provider].baseUrl,
          enabled: settings[provider].enabled,
        },
        signal: controller.signal,
      });

      for await (const token of stream) {
        fullContent += token;
        setStreamingContent(fullContent);
      }

      const assistantMessage: ContinuationMessage = {
        role: "assistant",
        content: fullContent,
        model: settings.selectedModel,
        provider: settings.selectedProvider,
      };
      setContinuationMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // User cancelled
      } else {
        const message =
          err instanceof Error ? err.message : "Something went wrong";
        setError(message);
      }
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      abortControllerRef.current = null;
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
  }

  // ── Routing: API chat vs web-app redirect ──────────────────────────────
  const isWebappMode = settings.selectedProvider === "webapp";

  function switchMode(mode: "api" | "webapp") {
    if (mode === "webapp") {
      if (settings.selectedProvider !== "webapp") {
        lastApiRoute.current = {
          provider: settings.selectedProvider,
          model: settings.selectedModel,
        };
      }
      updateSettings({
        selectedProvider: "webapp",
        selectedModel: lastWebappModel.current ?? "chatgpt-web",
      });
      return;
    }
    if (settings.selectedProvider === "webapp") {
      lastWebappModel.current = settings.selectedModel;
    }
    const saved = lastApiRoute.current;
    const fallbackModel =
      CLOUD_MODELS.find((m) => m.provider === "openai") ?? CLOUD_MODELS[0];
    updateSettings({
      selectedProvider: saved?.provider ?? "openai",
      selectedModel:
        saved?.model ?? fallbackModel?.id ?? settings.selectedModel,
    });
  }

  function handleRouteSelect(value: string) {
    const [provider, ...modelParts] = value.split(":");
    const model = modelParts.join(":");
    updateSettings({
      selectedProvider: provider as ChatProvider,
      selectedModel: model,
    });
  }

  // Readiness of the current route (surfaced in the header pill)
  function routeStatus(): { dot: string; label: string } {
    if (isWebappMode) {
      return { dot: "bg-sky-500", label: "Free · no key" };
    }
    const provider = settings.selectedProvider;
    if (
      provider === "ollama" ||
      provider === "lmstudio" ||
      provider === "custom"
    ) {
      const tested = connectionStatus[provider];
      if (tested === "ok") return { dot: "bg-emerald-500", label: "Connected" };
      if (tested === "fail")
        return { dot: "bg-rose-500", label: "Unreachable" };
      return { dot: "bg-slate-400", label: "Local · untested" };
    }
    const hasKey = Boolean(settings[provider]?.apiKey?.trim());
    if (hasKey) return { dot: "bg-emerald-500", label: "Key set" };
    return { dot: "bg-amber-500", label: "Needs key" };
  }

  const status = routeStatus();

  // Generate packaged prompt context including imported history and continuation messages
  function getFullConversationMarkdown() {
    let fullMarkdown = markdown;
    if (continuationMessages.length > 0) {
      fullMarkdown +=
        "\n\n" +
        continuationMessages
          .map((m) => {
            const roleName = m.role === "user" ? "You" : m.model || "Assistant";
            return `## ${roleName}\n\n${m.content}`;
          })
          .join("\n\n");
    }
    return fullMarkdown;
  }

  const fullMarkdownContext = getFullConversationMarkdown();
  const promptLength = fullMarkdownContext.length;
  const isTooLong = promptLength > 8000;

  // Keep editableContext in sync when the source markdown changes, unless user has edited it
  useEffect(() => {
    if (!contextEdited) {
      setEditableContext(fullMarkdownContext);
    }
  }, [fullMarkdownContext, contextEdited]);

  async function handleWebappRedirect() {
    const copied = await copyToClipboard(editableContext);

    // Determine provider redirect URL
    let redirectUrl = "https://chatgpt.com/";
    if (settings.selectedModel === "chatgpt-web") {
      redirectUrl = isTooLong
        ? "https://chatgpt.com/"
        : `https://chatgpt.com/?prompt=${encodeURIComponent(editableContext)}`;
    } else if (settings.selectedModel === "claude-web") {
      redirectUrl = isTooLong
        ? "https://claude.ai/new"
        : `https://claude.ai/new?q=${encodeURIComponent(editableContext)}`;
    } else if (settings.selectedModel === "gemini-web") {
      redirectUrl = isTooLong
        ? "https://gemini.google.com/"
        : `https://gemini.google.com/?prompt=${encodeURIComponent(editableContext)}`;
    } else if (settings.selectedModel === "grok-web") {
      redirectUrl = isTooLong
        ? "https://grok.com/"
        : `https://grok.com/?prompt=${encodeURIComponent(editableContext)}`;
    } else if (settings.selectedModel === "copilot-web") {
      redirectUrl = isTooLong
        ? "https://copilot.microsoft.com/"
        : `https://copilot.microsoft.com/?prompt=${encodeURIComponent(editableContext)}`;
    }

    if (copied) {
      setError(
        `Context copied to clipboard! Opening ${
          settings.selectedModel === "chatgpt-web"
            ? "ChatGPT"
            : settings.selectedModel === "claude-web"
              ? "Claude"
              : settings.selectedModel === "gemini-web"
                ? "Gemini"
                : settings.selectedModel === "grok-web"
                  ? "Grok"
                  : "Copilot"
        }...`,
      );
    } else {
      setError(`Failed to copy to clipboard, opening web app anyway...`);
    }

    window.open(redirectUrl, "_blank", "noopener,noreferrer");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Close settings on Escape
  useEffect(() => {
    if (!isSettingsOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setIsSettingsOpen(false);
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isSettingsOpen]);

  if (!isExpanded && !disableCollapse) {
    return (
      <button
        type="button"
        onClick={() => setIsExpanded(true)}
        className="group mt-4 flex w-full items-center justify-between gap-3 rounded-lg border border-border-contrast bg-paper-solid-elevated px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent hover:bg-paper-solid hover:shadow-soft text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent text-[0.9rem] transition-colors group-hover:bg-accent/20">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="text-[0.95rem] font-bold text-ink">
            Continue this conversation
          </span>
        </div>
        <span
          className={cn(
            monoCapsClass,
            "text-[0.68rem] font-bold text-ink-soft group-hover:text-accent transition-colors",
          )}
        >
          Pick any model
        </span>
      </button>
    );
  }

  return (
    <>
      {/* Settings Modal — uses shadcn Dialog */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-paper-solid border-border-contrast">
          <DialogHeader>
            <DialogTitle className="text-[1.05rem] font-extrabold text-ink uppercase tracking-wider">
              Model Settings
            </DialogTitle>
          </DialogHeader>

          <div className="grid gap-5 mt-1">
            {/* Cloud Providers */}
            <div className="grid gap-3">
              <p
                className={cn(
                  monoCapsClass,
                  "text-[0.72rem] font-bold text-ink-soft",
                )}
              >
                Cloud Providers
              </p>
              <div
                role="group"
                aria-label="Cloud provider to configure"
                className="flex flex-wrap gap-1.5"
              >
                {(
                  ["openai", "anthropic", "google", "grok", "mistral"] as const
                ).map((p) => {
                  const active = activeCloudEdit === p;
                  const hasKey = Boolean(settings[p].apiKey?.trim());
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setActiveCloudEdit(p)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[0.72rem] font-bold uppercase tracking-wider transition-all",
                        active
                          ? "border-line-strong bg-paper-solid text-ink shadow-sm"
                          : "border-line bg-paper text-ink-soft hover:text-ink hover:border-line-strong",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          hasKey ? "bg-emerald-500" : "bg-slate-400",
                        )}
                      />
                      {PROVIDER_LABELS[p]}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg border border-border-contrast bg-paper-solid-elevated p-4 shadow-sm mt-1">
                <div className="flex items-center justify-between pb-3">
                  <span className="text-[0.9rem] font-bold text-ink">
                    {PROVIDER_LABELS[activeCloudEdit]} Settings
                  </span>
                  <ConnectionBadge status={connectionStatus[activeCloudEdit]} />
                </div>
                <div className="grid gap-2.5">
                  <input
                    type="password"
                    placeholder="API Key"
                    value={settings[activeCloudEdit].apiKey}
                    onChange={(e) =>
                      updateProviderSettings(activeCloudEdit, {
                        apiKey: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 placeholder:text-ink-soft"
                  />
                  <button
                    type="button"
                    onClick={() => handleTestConnection(activeCloudEdit)}
                    className="w-fit rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset"
                  >
                    Test Connection
                  </button>
                </div>
              </div>
            </div>

            {/* Local Providers */}
            <div className="grid gap-3">
              <p
                className={cn(
                  monoCapsClass,
                  "text-[0.72rem] font-bold text-ink-soft",
                )}
              >
                Local Models
              </p>
              <div
                role="group"
                aria-label="Local provider to configure"
                className="flex flex-wrap gap-1.5"
              >
                {(["ollama", "lmstudio", "custom"] as const).map((p) => {
                  const active = activeLocalEdit === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setActiveLocalEdit(p)}
                      aria-pressed={active}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[0.72rem] font-bold uppercase tracking-wider transition-all",
                        active
                          ? "border-line-strong bg-paper-solid text-ink shadow-sm"
                          : "border-line bg-paper text-ink-soft hover:text-ink hover:border-line-strong",
                      )}
                    >
                      {PROVIDER_LABELS[p]}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg border border-border-contrast bg-paper-solid-elevated p-4 shadow-sm mt-1">
                <div className="flex items-center justify-between pb-3">
                  <span className="text-[0.9rem] font-bold text-ink">
                    {PROVIDER_LABELS[activeLocalEdit]} Settings
                  </span>
                  <ConnectionBadge status={connectionStatus[activeLocalEdit]} />
                </div>
                <div className="grid gap-2.5">
                  <input
                    type="text"
                    placeholder="Endpoint URL"
                    value={settings[activeLocalEdit].baseUrl}
                    onChange={(e) =>
                      updateProviderSettings(activeLocalEdit, {
                        baseUrl: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 placeholder:text-ink-soft"
                  />
                  {activeLocalEdit === "custom" && (
                    <input
                      type="password"
                      placeholder="API Key (optional)"
                      value={settings[activeLocalEdit].apiKey}
                      onChange={(e) =>
                        updateProviderSettings(activeLocalEdit, {
                          apiKey: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2 font-mono text-[0.82rem] text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 placeholder:text-ink-soft"
                    />
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleFetchModels(activeLocalEdit)}
                      disabled={isFetchingModels}
                      className="rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset disabled:opacity-50"
                    >
                      {isFetchingModels ? "Fetching..." : "Fetch Models"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTestConnection(activeLocalEdit)}
                      className="rounded-lg border border-border-contrast bg-paper-solid px-3.5 py-2 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink transition-colors hover:border-line-strong hover:bg-paper-solid-inset"
                    >
                      Test
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <p className="text-center text-[0.75rem] text-ink-soft mt-2">
              All keys are stored in your browser only. Nothing is sent to our
              server.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Continuation Panel */}
      <div
        className={cn(
          "mt-4 rounded-xl border border-border-contrast bg-paper-solid-elevated shadow-lg animate-fade-in overflow-hidden",
          className,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-contrast px-5 py-3.5 bg-paper-solid">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent text-[0.85rem]">
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[0.9rem] font-extrabold text-ink uppercase tracking-wide">
              Continue Chat
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Readiness pill — opens settings to fix it */}
            <button
              type="button"
              onClick={() => setIsSettingsOpen(true)}
              title="Model settings"
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 font-mono text-[0.7rem] font-bold uppercase tracking-wider text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", status.dot)}
              />
              {status.label}
            </button>

            {/* Settings button */}
            <button
              type="button"
              disabled={settings.selectedProvider === "webapp"}
              onClick={() => setIsSettingsOpen(true)}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors",
                settings.selectedProvider === "webapp" &&
                  "opacity-35 cursor-not-allowed",
              )}
              title={
                settings.selectedProvider === "webapp"
                  ? "No configuration needed for web apps"
                  : "Model settings"
              }
            >
              <Settings aria-hidden="true" className="h-4 w-4" />
            </button>

            {/* Reset/Clear Continuation history button */}
            {continuationMessages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Reset continuation chat history?")) {
                    setContinuationMessages([]);
                  }
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors"
                title="Reset continuation history"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
              </button>
            )}

            {/* Collapse button */}
            {!disableCollapse && (
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-contrast bg-paper-solid text-ink-soft hover:text-ink hover:bg-paper-solid-inset transition-colors"
              >
                <ChevronUp aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Route bar: mode first, model second */}
        <div className="flex items-center gap-2 border-b border-line bg-paper-solid px-5 py-2.5">
          <div
            role="group"
            aria-label="Continuation mode"
            className="flex shrink-0 rounded-lg border border-line bg-paper-inset p-0.5"
          >
            {(["api", "webapp"] as const).map((mode) => {
              const active =
                mode === "webapp" ? isWebappMode : !isWebappMode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => switchMode(mode)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-mono text-[0.68rem] font-bold uppercase tracking-wider transition-all",
                    active
                      ? "bg-paper-elevated text-ink shadow-sm ring-1 ring-line-strong"
                      : "text-ink-soft hover:text-ink",
                  )}
                >
                  {mode === "api" ? "Chat here" : "Web app"}
                </button>
              );
            })}
          </div>

          <div className="relative min-w-0 flex-1">
            <select
              aria-label={isWebappMode ? "Web app target" : "Model"}
              value={`${settings.selectedProvider}:${settings.selectedModel}`}
              onChange={(e) => handleRouteSelect(e.target.value)}
              className="h-8 w-full appearance-none truncate rounded-lg border border-line bg-paper px-3 pr-7 font-mono text-[0.72rem] font-bold uppercase tracking-wider text-ink outline-none transition-all hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/20"
            >
              {!isWebappMode && (
                <optgroup label="Cloud API (Requires Key)">
                  {CLOUD_MODELS.map((m) => (
                    <option
                      key={`${m.provider}:${m.id}`}
                      value={`${m.provider}:${m.id}`}
                    >
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {!isWebappMode && localModels.length > 0 && (
                <optgroup label="Local API">
                  {localModels.map((m) => (
                    <option
                      key={`${m.provider}:${m.id}`}
                      value={`${m.provider}:${m.id}`}
                    >
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {isWebappMode &&
                WEB_APPS.map((w) => (
                  <option key={w.id} value={`webapp:${w.id}`}>
                    {w.name}
                  </option>
                ))}
            </select>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft"
              viewBox="0 0 24 24"
            >
              <path
                d="M6 9l6 6 6-6"
                className="fill-none stroke-current stroke-[2] stroke-linecap-round stroke-linejoin-round"
              />
            </svg>
          </div>
        </div>

        {/* Dynamic Body content */}
        {settings.selectedProvider === "webapp" ? (
          <div className="bg-paper-solid p-6 border-b border-border-contrast flex flex-col items-center justify-center gap-4 text-center animate-fade-in">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent text-[1.2rem] mb-1">
              <svg
                className="h-5.5 w-5.5 text-accent"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </span>
            <div className="max-w-md">
              <p className="text-[0.92rem] font-bold text-ink">
                Continue this conversation in{" "}
                {settings.selectedModel === "chatgpt-web"
                  ? "ChatGPT"
                  : settings.selectedModel === "claude-web"
                    ? "Claude"
                    : settings.selectedModel === "gemini-web"
                      ? "Gemini"
                      : settings.selectedModel === "grok-web"
                        ? "Grok"
                        : "Copilot"}
              </p>
              <p className="text-[0.78rem] text-ink-soft mt-1 leading-relaxed">
                Browser web apps do not support API streaming. Instead, we'll
                package the entire conversation context (including any
                continuation messages below), copy it to your clipboard, and
                launch the platform.
              </p>
            </div>

            {/* Editable context prompt (collapsed by default) */}
            <div className="w-full max-w-md text-left mt-2">
              <button
                type="button"
                onClick={() => setShowContext((v) => !v)}
                aria-expanded={showContext}
                className="flex w-full items-center justify-between rounded-lg border border-line bg-paper px-3 py-2 transition-colors hover:border-line-strong"
              >
                <span className="text-[0.68rem] font-mono font-bold uppercase tracking-wider text-ink-soft">
                  Review context
                </span>
                <span className="flex items-center gap-2">
                  {contextEdited && (
                    <span className="text-[0.6rem] font-mono text-amber-500 font-bold uppercase tracking-wide">
                      Edited
                    </span>
                  )}
                  <span className="text-[0.6rem] font-mono bg-paper-solid border border-border-contrast rounded px-1.5 py-0.5 text-ink-soft">
                    {editableContext.length.toLocaleString()} chars
                  </span>
                  <ChevronUp
                    aria-hidden="true"
                    className={cn(
                      "h-3.5 w-3.5 text-ink-soft transition-transform",
                      !showContext && "rotate-180",
                    )}
                  />
                </span>
              </button>
              {showContext && (
                <div className="mt-2 animate-fade-in">
                  {contextEdited && (
                    <div className="mb-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setEditableContext(fullMarkdownContext);
                          setContextEdited(false);
                        }}
                        className="text-[0.6rem] font-mono font-bold uppercase tracking-wide text-ink-soft hover:text-ink border border-border-contrast rounded px-1.5 py-0.5 bg-paper-solid hover:bg-paper-solid-inset transition-colors"
                      >
                        Reset
                      </button>
                    </div>
                  )}
                  <textarea
                    value={editableContext}
                    onChange={(e) => {
                      setEditableContext(e.target.value);
                      setContextEdited(true);
                    }}
                    rows={8}
                    spellCheck={false}
                    className="w-full rounded-lg border border-border-contrast bg-paper-solid-inset px-3 py-2.5 font-mono text-[0.72rem] text-ink-muted whitespace-pre-wrap leading-normal resize-y outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 min-h-[8rem] max-h-64"
                  />
                </div>
              )}
            </div>

            <Button
              type="button"
              variant="primary"
              onClick={handleWebappRedirect}
              className="w-full max-w-md gap-2 py-2.5 px-4"
            >
              Copy Context & Open Web App
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div className="max-h-[30rem] min-h-[8rem] overflow-y-auto overscroll-contain px-5 py-5 border-b border-border-contrast bg-paper-solid flex flex-col gap-4">
              {continuationMessages.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent text-[1.2rem] mb-2">
                    <svg
                      className="h-6 w-6 text-accent"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  </span>
                  <p className="text-[0.92rem] font-bold text-ink-muted">
                    Type a message to continue the conversation with{" "}
                    <span className="text-accent font-extrabold">
                      {selectedModelName}
                    </span>
                  </p>
                  <p className="text-[0.78rem] text-ink-soft max-w-sm">
                    The imported conversation above is automatically loaded in
                    context.
                  </p>
                </div>
              )}

              {continuationMessages.map((msg, index) => (
                <div
                  key={index}
                  className={cn(
                    "flex flex-col w-full",
                    msg.role === "user" ? "items-end" : "items-start",
                  )}
                >
                  {msg.role === "user" ? (
                    // User: right-aligned amber bubble
                    <div className="flex flex-col items-end gap-1 max-w-[80%]">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <User
                          aria-hidden="true"
                          className="h-3 w-3 text-amber-500"
                        />
                      </div>
                      <div className="rounded-2xl rounded-tr-sm bg-amber-50 dark:bg-amber-950/40 border border-amber-200/60 dark:border-amber-800/40 px-4 py-2.5 text-[0.88rem] text-ink shadow-sm">
                        <div className="whitespace-pre-wrap leading-[1.6]">
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  ) : (
                    // Assistant: left-aligned accent-border card
                    <div className="flex flex-col items-start gap-1 max-w-[85%]">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Bot aria-hidden="true" className="h-3 w-3 text-accent" />
                      </div>
                      <div className="rounded-xl rounded-tl-sm border-l-2 border-l-accent/50 border border-border-contrast bg-paper-solid-elevated px-4 py-3 text-[0.88rem] shadow-sm w-full">
                        <div className="markdown-preview leading-[1.68]">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            rehypePlugins={[rehypeHighlight]}
                            components={{
                              a: ({ node: _node, ...props }) => (
                                <a
                                  {...props}
                                  rel="noreferrer"
                                  target="_blank"
                                />
                              ),
                            }}
                          >
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Streaming message */}
              {isStreaming && streamingContent && (
                <div className="flex flex-col items-start w-full">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Bot aria-hidden="true" className="h-3 w-3 text-accent" />
                    <span className="inline-flex items-center text-[0.6rem] font-mono font-bold uppercase text-accent animate-pulse">
                      (STREAMING)
                    </span>
                  </div>
                  <div className="rounded-xl rounded-tl-sm border-l-2 border-l-accent/50 border border-border-contrast bg-paper-solid-elevated p-4 text-[0.88rem] shadow-sm max-w-[85%] w-full">
                    <div className="markdown-preview leading-[1.68]">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} rel="noreferrer" target="_blank" />
                          ),
                        }}
                      >
                        {streamingContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              )}

              {isStreaming && !streamingContent && (
                <div className="flex flex-col items-start w-full">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Bot aria-hidden="true" className="h-3 w-3 text-accent" />
                    <span
                      className={cn(
                        monoCapsClass,
                        "font-mono text-[0.68rem] font-bold text-accent",
                      )}
                    >
                      Thinking
                    </span>
                  </div>
                  <div className="rounded-xl rounded-tl-sm border-l-2 border-l-accent/50 border border-border-contrast bg-paper-solid-elevated p-4 max-w-[85%]">
                    <div className="flex gap-1.5">
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-accent/60"
                        style={{ animationDelay: "0ms" }}
                      />
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-accent/60"
                        style={{ animationDelay: "150ms" }}
                      />
                      <span
                        className="h-2 w-2 animate-bounce rounded-full bg-accent/60"
                        style={{ animationDelay: "300ms" }}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className="bg-paper-solid-elevated px-5 py-4">
              <div className="flex items-end gap-2">
                <Textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Ask ${selectedModelName || "the model"} a question...`}
                  rows={1}
                  className="min-h-[2.8rem] max-h-32 flex-1 resize-none border-border-contrast bg-paper-solid-inset font-mono text-[0.82rem] text-ink focus-visible:border-accent focus-visible:ring-accent/20 placeholder:text-ink-soft"
                />

                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="flex h-[2.8rem] w-[2.8rem] shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors"
                    title="Stop generation"
                  >
                    <Square className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="flex h-[2.8rem] w-[2.8rem] shrink-0 items-center justify-center rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Send message"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ConnectionBadge({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  if (status === "idle") return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[0.62rem] font-mono font-bold uppercase border",
        status === "testing" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
        status === "ok" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
        status === "fail" &&
          "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
      )}
    >
      {status === "testing" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
      )}
      {status === "ok" && "Connected"}
      {status === "fail" && "Failed"}
      {status === "testing" && "Testing..."}
    </span>
  );
}
