import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  autoFixJsonInput,
  buildTreeFromValue,
  computeFieldStatistics,
  formatJsonInput,
  formatPropertyName,
  formatTypeName,
  generateMockDataFromSamples,
  generateOutputFromSamples,
  parseJsonInput,
  type FieldStatistics,
  type GeneratorOptions,
  type OutputFormat,
  type TreeNode,
  type NamingStyle,
} from "./lib/json-to-ts";
import { cn } from "./utils/cn";

const templates = {
  userProfile: {
    label: "User Profile",
    rootName: "User",
    data: {
      id: 1,
      name: "Alice Johnson",
      email: "alice@example.com",
      isAdmin: true,
      roles: ["owner", "editor"],
      address: {
        street: "123 Main Street",
        city: "Berlin",
        country: "Germany",
      },
    },
  },
  product: {
    label: "Product",
    rootName: "Product",
    data: {
      id: "sku_1001",
      name: "Mechanical Keyboard",
      price: 129.99,
      inStock: true,
      categories: ["keyboards", "accessories"],
      variants: [
        { color: "black", stock: 12 },
        { color: "white", stock: 4 },
      ],
    },
  },
  apiResponse: {
    label: "API Response",
    rootName: "ApiResponse",
    data: {
      success: true,
      meta: { page: 1, pageSize: 20, total: 250 },
      data: [
        {
          id: 1,
          name: "Alpha",
          createdAt: "2025-02-10T16:20:00Z",
        },
      ],
    },
  },
} as const;

const defaultInput = JSON.stringify(templates.userProfile.data, null, 2);

const defaultOptions: GeneratorOptions = {
  rootName: "User",
  namingStyle: "pascal",
  prefix: "",
  suffix: "",
  readonly: false,
  exportInterfaces: true,
  useEnums: true,
  splitNestedInterfaces: true,
};

type ThemeMode = "dark" | "light";
type CopyMode = "file" | "types" | "root";
type ExportMode = "full" | "rootOnly";

type ParseState = ReturnType<typeof parseJsonInput>;
type GeneratorState = ReturnType<typeof generateOutputFromSamples> | null;

const STORAGE_KEYS = {
  theme: "json-ts-theme",
  options: "json-ts-options",
  input: "json-ts-input",
  outputFormat: "json-ts-output-format",
} as const;

function readJsonStorage<T>(key: string, fallback: T) {
  const value = localStorage.getItem(key);
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function downloadTextFile(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function getCopyContent(code: string, mode: CopyMode) {
  if (!code) return "";
  if (mode === "file") return code;
  const blocks = code.split(/\n\n+/);
  if (mode === "root") return blocks[blocks.length - 1] ?? code;
  return blocks.filter((block) => /^(export\s+)?(interface|enum|type|const)\s/m.test(block)).join("\n\n");
}

function getDownloadContent(code: string, exportMode: ExportMode) {
  if (exportMode === "full") return code;
  return getCopyContent(code, "root");
}

function getOutputFilename(baseName: string, format: OutputFormat) {
  const safeBase = baseName || "Output";
  if (format === "typescript") return `${safeBase}.ts`;
  if (format === "zod") return `${safeBase}.zod.ts`;
  if (format === "typeGuards") return `${safeBase}.guards.ts`;
  return `${safeBase}.schema.json`;
}

function getOutputMime(format: OutputFormat) {
  return format === "jsonSchema" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8";
}

function getLineCount(value: string) {
  return Math.max(1, value.split("\n").length);
}

function highlightCode(source: string, language: "json" | "ts") {
  const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (!escaped) return "";
  let result = escaped.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, '<span class="token-string">$1</span>');
  result = result.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="token-number">$1</span>');
  result = result.replace(
    /\b(true|false|null|interface|export|enum|readonly|type|const|return|function|import)\b/g,
    '<span class="token-keyword">$1</span>'
  );
  if (language === "json") {
    result = result.replace(
      /(<span class="token-string">&quot;.*?&quot;<\/span>)(?=\s*:)/g,
      '<span class="token-property">$1</span>'
    );
  }
  return result;
}

function Button({
  children,
  lightMode,
  variant = "secondary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  lightMode: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
}) {
  const base = "inline-flex items-center justify-center font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const sizes = {
    sm: "rounded-lg px-2.5 py-1.5 text-xs",
    md: "rounded-lg px-3.5 py-2 text-sm",
  };
  const variants = {
    primary: lightMode
      ? "bg-slate-900 text-white hover:bg-slate-800 shadow-sm"
      : "bg-white text-slate-900 hover:bg-slate-100 shadow-sm",
    secondary: lightMode
      ? "bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200"
      : "bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700",
    ghost: lightMode
      ? "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      : "text-slate-400 hover:bg-slate-800 hover:text-white",
    danger: lightMode
      ? "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200"
      : "bg-red-950/40 text-red-400 hover:bg-red-950/60 border border-red-900/50",
  };

  return (
    <button {...props} className={cn(base, sizes[size], variants[variant], className)}>
      {children}
    </button>
  );
}

function Toggle({
  label,
  checked,
  onToggle,
  lightMode,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  lightMode: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer select-none">
      <span className={cn("text-sm", lightMode ? "text-slate-600" : "text-slate-400")}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onToggle}
        className={cn(
          "relative h-5 w-9 rounded-full transition-colors",
          checked
            ? lightMode ? "bg-slate-900" : "bg-white"
            : lightMode ? "bg-slate-300" : "bg-slate-700"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full transition-all",
            checked ? "left-[18px]" : "left-0.5",
            checked
              ? lightMode ? "bg-white" : "bg-slate-900"
              : lightMode ? "bg-white" : "bg-slate-500"
          )}
        />
      </button>
    </label>
  );
}

function LineNumbers({ count, lightMode }: { count: number; lightMode: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0 border-r px-3 py-3 text-right text-xs leading-6 select-none",
        lightMode ? "border-slate-200 text-slate-300" : "border-slate-800 text-slate-600"
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

function CodeBlock({
  code,
  language,
  placeholder,
  lightMode,
}: {
  code: string;
  language: "json" | "ts";
  placeholder: string;
  lightMode: boolean;
}) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <pre
      className={cn(
        "min-h-[400px] overflow-auto p-4 text-[13px] leading-6",
        lightMode ? "text-slate-800" : "text-slate-300"
      )}
    >
      {code ? (
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className={lightMode ? "text-slate-400" : "text-slate-600"}>{placeholder}</code>
      )}
    </pre>
  );
}

function TreeItem({
  node,
  depth = 0,
  lightMode,
  expanded,
  toggle,
}: {
  node: TreeNode;
  depth?: number;
  lightMode: boolean;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const hasChildren = Boolean(node.children?.length);
  const isOpen = expanded.has(node.id);

  return (
    <div>
      <button
        type="button"
        onClick={() => hasChildren && toggle(node.id)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[13px] transition",
          lightMode ? "hover:bg-slate-100" : "hover:bg-slate-800"
        )}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        <span className={cn("w-3.5 text-center text-[10px]", lightMode ? "text-slate-400" : "text-slate-500")}>
          {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
        </span>
        <span className={cn("font-medium", lightMode ? "text-slate-800" : "text-slate-200")}>{node.label}</span>
        <span className={cn("ml-1 text-[11px]", lightMode ? "text-slate-400" : "text-slate-500")}>{node.type}</span>
      </button>
      {hasChildren && isOpen
        ? node.children?.map((child) => (
          <TreeItem key={child.id} node={child} depth={depth + 1} lightMode={lightMode} expanded={expanded} toggle={toggle} />
        ))
        : null}
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.theme);
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [options, setOptions] = useState<GeneratorOptions>(() => readJsonStorage(STORAGE_KEYS.options, defaultOptions));
  const [input, setInput] = useState(() => localStorage.getItem(STORAGE_KEYS.input) ?? defaultInput);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.outputFormat);
    return stored === "zod" || stored === "typeGuards" || stored === "jsonSchema" ? stored : "typescript";
  });
  const [dropActive, setDropActive] = useState(false);
  const [toast, setToast] = useState("");
  const [copyMode, setCopyMode] = useState<CopyMode>("file");
  const [exportMode, setExportMode] = useState<ExportMode>("full");
  const [copied, setCopied] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(["root"]));
  const [showSettings, setShowSettings] = useState(false);
  const [showTree, setShowTree] = useState(false);

  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const lightMode = theme === "light";
  const parsed: ParseState = useMemo(() => parseJsonInput(input), [input]);

  const generated: GeneratorState = useMemo(() => {
    if (!parsed.ok) return null;
    return generateOutputFromSamples(parsed.samples, options, outputFormat);
  }, [parsed, options, outputFormat]);

  const activeCode = generated?.code ?? "";
  const displayedCode = getDownloadContent(activeCode, exportMode);

  const treeData = useMemo(() => {
    if (!parsed.ok) return null;
    if (parsed.mode === "multiple") {
      return buildTreeFromValue(parsed.samples, `${options.rootName || "Root"} Samples`);
    }
    return buildTreeFromValue(parsed.value, options.rootName || "Root");
  }, [options.rootName, parsed]);

  const fieldStats: FieldStatistics | null = useMemo(() => {
    if (!parsed.ok) return null;
    return computeFieldStatistics(parsed.samples);
  }, [parsed]);

  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  }

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.options, JSON.stringify(options));
  }, [options]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.input, input);
  }, [input]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.outputFormat, outputFormat);
  }, [outputFormat]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = navigator.platform.toUpperCase().includes("MAC") ? event.metaKey : event.ctrlKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        handleFormat();
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void handleCopy();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  function updateOption<K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function handleFormat() {
    const result = formatJsonInput(input);
    if (result.ok) {
      setInput(result.formatted);
      notify("Formatted");
    } else {
      notify(result.error);
    }
  }

  function handleAutoFix() {
    const result = autoFixJsonInput(input);
    if (result.ok) {
      setInput(result.fixed);
      notify("Fixed");
    } else {
      notify(result.error ?? "Unable to fix");
    }
  }

  async function handleCopy() {
    const content = getCopyContent(activeCode, copyMode);
    if (!content) return notify("Nothing to copy");
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
    notify("Copied to clipboard");
  }

  function handleDownload() {
    if (!activeCode || !generated) return notify("Nothing to download");
    const content = getDownloadContent(activeCode, exportMode);
    const fileBase = formatTypeName(options.rootName || "Output", options.namingStyle, options.prefix, options.suffix);
    downloadTextFile(getOutputFilename(fileBase, outputFormat), content, getOutputMime(outputFormat));
    notify("Downloaded");
  }

  function clearAll() {
    setInput("");
    notify("Cleared");
    requestAnimationFrame(() => textAreaRef.current?.focus());
  }

  function loadTemplate(key: keyof typeof templates) {
    const t = templates[key];
    setInput(JSON.stringify(t.data, null, 2));
    setOptions((prev) => ({ ...prev, rootName: t.rootName }));
    notify(`Loaded ${t.label}`);
  }

  function readFile(file: File) {
    const ok = /\.(json|txt)$/i.test(file.name) || file.type.includes("json") || file.type.includes("text");
    if (!ok) return notify("Upload .json or .txt");
    const reader = new FileReader();
    reader.onload = () => {
      setInput(typeof reader.result === "string" ? reader.result : "");
      notify(`Loaded ${file.name}`);
    };
    reader.readAsText(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) readFile(file);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = `${input.slice(0, start)}  ${input.slice(end)}`;
      setInput(next);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  }

  function toggleNode(id: string) {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const inputLabel = lightMode ? "text-slate-500" : "text-slate-500";
  const cardBg = lightMode ? "bg-white border-slate-200" : "bg-slate-900 border-slate-800";
  const subtleBg = lightMode ? "bg-slate-50" : "bg-slate-900/60";
  const inputBg = lightMode
    ? "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400"
    : "border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500";

  return (
    <div className={cn("min-h-screen transition-colors", lightMode ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100")}>
      {/* Toast */}
      <div
        className={cn(
          "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg transition-all duration-300",
          toast
            ? "translate-y-0 opacity-100"
            : "translate-y-4 opacity-0 pointer-events-none",
          lightMode ? "bg-slate-900 text-white" : "bg-white text-slate-900"
        )}
      >
        {toast}
      </div>

      <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className={cn("text-xl font-semibold tracking-tight", lightMode ? "text-slate-900" : "text-white")}>
              JSON → TypeScript
            </h1>
            <p className={cn("mt-1 text-sm", lightMode ? "text-slate-500" : "text-slate-400")}>
              Generate interfaces, Zod schemas, type guards, or JSON Schema — entirely in your browser.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button lightMode={lightMode} variant="ghost" size="sm" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
              {lightMode ? "Dark" : "Light"}
            </Button>
            <Button lightMode={lightMode} variant="ghost" size="sm" onClick={() => setShowSettings(s => !s)}>
              Settings
            </Button>
          </div>
        </header>

        {/* Settings panel */}
        {showSettings && (
          <div className={cn("mb-6 rounded-xl border p-5", cardBg)}>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1.5">
                <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Root name</span>
                <input
                  value={options.rootName}
                  onChange={(e) => updateOption("rootName", e.target.value)}
                  placeholder="Root"
                  className={cn("w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400/30", inputBg)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Naming</span>
                <select
                  value={options.namingStyle}
                  onChange={(e) => updateOption("namingStyle", e.target.value as NamingStyle)}
                  className={cn("w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400/30", inputBg)}
                >
                  <option value="pascal">PascalCase</option>
                  <option value="camel">camelCase</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Prefix</span>
                <input
                  value={options.prefix}
                  onChange={(e) => updateOption("prefix", e.target.value)}
                  placeholder="I"
                  className={cn("w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400/30", inputBg)}
                />
              </label>
              <label className="space-y-1.5">
                <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Suffix</span>
                <input
                  value={options.suffix}
                  onChange={(e) => updateOption("suffix", e.target.value)}
                  placeholder="Type"
                  className={cn("w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400/30", inputBg)}
                />
              </label>
            </div>
            <div className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
              <Toggle label="Readonly" checked={options.readonly} onToggle={() => updateOption("readonly", !options.readonly)} lightMode={lightMode} />
              <Toggle label="Export statements" checked={options.exportInterfaces} onToggle={() => updateOption("exportInterfaces", !options.exportInterfaces)} lightMode={lightMode} />
              <Toggle label="Enum detection" checked={options.useEnums} onToggle={() => updateOption("useEnums", !options.useEnums)} lightMode={lightMode} />
              <Toggle label="Split nested" checked={options.splitNestedInterfaces} onToggle={() => updateOption("splitNestedInterfaces", !options.splitNestedInterfaces)} lightMode={lightMode} />
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className={cn("mb-4 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3", cardBg)}>
          <select
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
            className={cn("rounded-lg border px-2.5 py-1.5 text-sm outline-none", inputBg)}
          >
            <option value="typescript">TypeScript</option>
            <option value="zod">Zod Schema</option>
            <option value="typeGuards">Type Guards</option>
            <option value="jsonSchema">JSON Schema</option>
          </select>

          <div className={cn("mx-1 h-5 w-px", lightMode ? "bg-slate-200" : "bg-slate-700")} />

          <Button lightMode={lightMode} variant="ghost" size="sm" onClick={handleFormat}>Format</Button>
          <Button lightMode={lightMode} variant="ghost" size="sm" onClick={handleAutoFix}>Auto-fix</Button>
          <Button lightMode={lightMode} variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>Upload</Button>
          <Button lightMode={lightMode} variant="ghost" size="sm" onClick={clearAll}>Clear</Button>

          <div className={cn("mx-1 h-5 w-px", lightMode ? "bg-slate-200" : "bg-slate-700")} />

          {Object.entries(templates).map(([key, t]) => (
            <Button key={key} lightMode={lightMode} variant="ghost" size="sm" onClick={() => loadTemplate(key as keyof typeof templates)}>
              {t.label}
            </Button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <Button lightMode={lightMode} variant="ghost" size="sm" onClick={() => setShowTree(s => !s)}>
              {showTree ? "Hide tree" : "Tree"}
            </Button>
            {parsed.ok ? (
              <span className={cn("rounded-md px-2 py-1 text-[11px] font-medium", lightMode ? "bg-emerald-50 text-emerald-700" : "bg-emerald-950/50 text-emerald-400")}>
                Valid
              </span>
            ) : (
              <span className={cn("rounded-md px-2 py-1 text-[11px] font-medium", lightMode ? "bg-red-50 text-red-600" : "bg-red-950/50 text-red-400")}>
                Invalid
              </span>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.txt,application/json,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readFile(file);
            e.currentTarget.value = "";
          }}
        />

        {/* Main panels */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Input */}
          <div className={cn("overflow-hidden rounded-xl border", cardBg)}>
            <div className={cn("flex items-center justify-between border-b px-4 py-2.5", lightMode ? "border-slate-200" : "border-slate-800")}>
              <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Input</span>
              <span className={cn("text-xs tabular-nums", inputLabel)}>
                {getLineCount(input)} lines · {parsed.ok ? `${parsed.samples.length} sample${parsed.samples.length > 1 ? "s" : ""}` : "—"}
              </span>
            </div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
              onDragLeave={() => setDropActive(false)}
              onDrop={handleDrop}
              className={cn("relative", dropActive && (lightMode ? "ring-2 ring-slate-400/40" : "ring-2 ring-slate-500/40"))}
            >
              {dropActive && (
                <div className={cn(
                  "absolute inset-0 z-10 grid place-items-center text-sm font-medium backdrop-blur-sm",
                  lightMode ? "bg-white/80 text-slate-600" : "bg-slate-950/80 text-slate-300"
                )}>
                  Drop .json or .txt file
                </div>
              )}
              <div className="grid grid-cols-[auto_1fr]">
                <LineNumbers count={getLineCount(input)} lightMode={lightMode} />
                <textarea
                  ref={textAreaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  spellCheck={false}
                  placeholder="Paste JSON here..."
                  className={cn(
                    "min-h-[480px] w-full resize-none bg-transparent p-3 font-mono text-[13px] leading-6 outline-none",
                    lightMode ? "text-slate-800 placeholder:text-slate-400" : "text-slate-200 placeholder:text-slate-600"
                  )}
                  aria-label="JSON input"
                />
              </div>
            </div>
          </div>

          {/* Output */}
          <div className={cn("overflow-hidden rounded-xl border", cardBg)}>
            <div className={cn("flex items-center justify-between border-b px-4 py-2.5", lightMode ? "border-slate-200" : "border-slate-800")}>
              <span className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Output</span>
              <div className="flex items-center gap-1.5">
                <select
                  value={exportMode}
                  onChange={(e) => setExportMode(e.target.value as ExportMode)}
                  className={cn("rounded border px-2 py-1 text-xs outline-none", inputBg)}
                >
                  <option value="full">Full</option>
                  <option value="rootOnly">Root only</option>
                </select>
                <select
                  value={copyMode}
                  onChange={(e) => setCopyMode(e.target.value as CopyMode)}
                  className={cn("rounded border px-2 py-1 text-xs outline-none", inputBg)}
                >
                  <option value="file">Copy all</option>
                  <option value="types">Types only</option>
                  <option value="root">Root only</option>
                </select>
                <Button lightMode={lightMode} variant="primary" size="sm" onClick={() => void handleCopy()}>
                  {copied ? "Copied!" : "Copy"}
                </Button>
                <Button lightMode={lightMode} variant="secondary" size="sm" onClick={handleDownload}>
                  Download
                </Button>
              </div>
            </div>
            <CodeBlock
              code={displayedCode}
              language={outputFormat === "jsonSchema" ? "json" : "ts"}
              placeholder={parsed.ok ? "Output will appear here..." : "Fix JSON input to generate output."}
              lightMode={lightMode}
            />
            {generated && (
              <div className={cn("flex items-center gap-4 border-t px-4 py-2.5 text-xs", lightMode ? "border-slate-200 text-slate-500" : "border-slate-800 text-slate-500")}>
                <span>Root: <strong className={lightMode ? "text-slate-700" : "text-slate-300"}>{generated.rootTypeName}</strong></span>
                <span>{generated.interfaceCount} definition{generated.interfaceCount !== 1 ? "s" : ""}</span>
                {generated.enumCount > 0 && <span>{generated.enumCount} enum{generated.enumCount !== 1 ? "s" : ""}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Tree viewer */}
        {showTree && (
          <div className={cn("mt-4 grid gap-4", fieldStats ? "lg:grid-cols-[1fr_320px]" : "")}>
            <div className={cn("rounded-xl border p-4", cardBg)}>
              <h3 className={cn("mb-3 text-xs font-medium uppercase tracking-wider", inputLabel)}>Structure</h3>
              <div className="max-h-[360px] overflow-auto">
                {treeData ? (
                  <TreeItem node={treeData} lightMode={lightMode} expanded={expandedNodes} toggle={toggleNode} />
                ) : (
                  <p className={cn("text-sm", lightMode ? "text-slate-400" : "text-slate-600")}>Paste valid JSON to inspect structure.</p>
                )}
              </div>
            </div>
            {fieldStats && (
              <div className={cn("rounded-xl border p-4", cardBg)}>
                <h3 className={cn("mb-3 text-xs font-medium uppercase tracking-wider", inputLabel)}>Statistics</h3>
                <div className="space-y-2.5">
                  {[
                    ["Fields", fieldStats.totalFields],
                    ["Samples", fieldStats.sampleCount],
                    ["Max depth", fieldStats.maxDepth],
                    ["Top-level keys", fieldStats.topLevelKeys.length],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="flex items-center justify-between text-sm">
                      <span className={lightMode ? "text-slate-500" : "text-slate-400"}>{label}</span>
                      <span className={cn("font-medium tabular-nums", lightMode ? "text-slate-800" : "text-slate-200")}>{value}</span>
                    </div>
                  ))}
                  <div className={cn("my-3 h-px", lightMode ? "bg-slate-200" : "bg-slate-800")} />
                  <div className={cn("text-xs font-medium uppercase tracking-wider", inputLabel)}>Types</div>
                  {Object.entries(fieldStats.typeBreakdown).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between text-sm">
                      <span className={lightMode ? "text-slate-500" : "text-slate-400"}>{type}</span>
                      <span className={cn("font-medium tabular-nums", lightMode ? "text-slate-800" : "text-slate-200")}>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className={cn("mt-8 border-t pt-6 pb-8 text-center text-xs", lightMode ? "border-slate-200 text-slate-400" : "border-slate-800 text-slate-600")}>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <span>Runs locally — no data sent anywhere</span>
            <span className="hidden sm:inline">·</span>
            <span>
              <kbd className={cn("rounded border px-1.5 py-0.5 text-[10px]", lightMode ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-800")}>⌘⇧F</kbd> Format
              {" · "}
              <kbd className={cn("rounded border px-1.5 py-0.5 text-[10px]", lightMode ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-800")}>⌘⇧C</kbd> Copy
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}