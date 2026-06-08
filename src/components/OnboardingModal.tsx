import { clsx } from "clsx";
import {
  ArrowLeft, ArrowRight, ChevronDown, Eye, FolderOpen, GitBranch, Laptop,
  Search, Share2, Sparkles, Tag, Workflow, X, Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useState } from "react";
import { useStore } from "../store/useStore";

// ─── Mini demos ───────────────────────────────────────────────────────────────
// Each demo is a small inline mockup that visually demonstrates the step's
// feature. Sized to fit inside the modal content area (~320px wide max).
// Animated via the parent's `onboard-icon-pop` so they enter with a bounce.
//
// Demos must be PURE — no real data, no Tauri invokes, no store access.
// They render the same way every time so the onboarding stays deterministic.

function WorkspacesDemo() {
  const items = [
    { icon: "📁", name: "Work", active: true },
    { icon: "🎨", name: "Design", active: false },
    { icon: "🏠", name: "Personal", active: false },
  ];
  return (
    <div className="flex flex-col gap-1.5 w-60">
      {items.map((ws) => (
        <div
          key={ws.name}
          className={clsx(
            "flex items-center gap-2 px-3 py-2 rounded-md text-[12px] transition-colors",
            ws.active
              ? "bg-blue-400/15 border border-blue-400/40 text-text-primary"
              : "bg-surface-3 border border-transparent text-text-secondary",
          )}
        >
          <span>{ws.icon}</span>
          <span className="flex-1 text-left">{ws.name}</span>
          {ws.active && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
        </div>
      ))}
    </div>
  );
}

function TagsDemo() {
  const files: { icon: string; name: string; tags: { label: string; cls: string }[] }[] = [
    { icon: "📄", name: "report.pdf", tags: [
      { label: "PDF", cls: "bg-blue-500/25 text-blue-300" },
      { label: "Q4", cls: "bg-amber-500/25 text-amber-300" },
    ]},
    { icon: "🎵", name: "song.mp3", tags: [
      { label: "Audio", cls: "bg-cyan-500/25 text-cyan-300" },
    ]},
    { icon: "📷", name: "photo.jpg", tags: [
      { label: "Image", cls: "bg-pink-500/25 text-pink-300" },
      { label: "vacation", cls: "bg-emerald-500/25 text-emerald-300" },
    ]},
  ];
  return (
    <div className="flex flex-col gap-1 w-72">
      {files.map((f) => (
        <div key={f.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-3">
          <span className="text-[12px]">{f.icon}</span>
          <span className="text-[11px] text-text-primary flex-1 truncate text-left">{f.name}</span>
          <div className="flex gap-1">
            {f.tags.map((tag) => (
              <span key={tag.label} className={clsx("text-[9px] px-1.5 py-0.5 rounded font-medium", tag.cls)}>
                {tag.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchDemo() {
  return (
    <div className="flex flex-col gap-2 w-72">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-surface-3 border border-emerald-400/40">
        <Search size={11} className="text-emerald-400" />
        <span className="text-[11px] text-text-primary font-mono">budget</span>
        <span className="ml-auto text-[9px] text-emerald-300">3 hits</span>
      </div>
      <div className="px-3 py-2 rounded bg-surface-3 border border-border">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[11px]">📄</span>
          <span className="text-[11px] text-text-primary">finance.pdf</span>
          <span className="ml-auto text-[8px] px-1 rounded bg-emerald-500/25 text-emerald-300">content</span>
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed text-left">
          …quarterly <mark className="bg-emerald-400/35 text-text-primary px-0.5 rounded">budget</mark> allocations for Q4 marketing spend…
        </p>
      </div>
    </div>
  );
}

function AiDemo({ lang }: { lang: "en" | "fr" }) {
  const userMsg = lang === "fr" ? "range mes téléchargements" : "organize my downloads";
  const aiMsg = lang === "fr" ? "Je vais trier par type et déplacer…" : "I'll sort them by type and move…";
  return (
    <div className="flex flex-col gap-1.5 w-72">
      <div className="self-end max-w-[80%] px-3 py-1.5 rounded-2xl rounded-br-sm bg-violet-500/25 border border-violet-400/40 text-[11px] text-text-primary">
        {userMsg}
      </div>
      <div className="self-start max-w-[88%] px-3 py-1.5 rounded-2xl rounded-bl-sm bg-surface-3 border border-border text-[11px] text-text-secondary flex items-center gap-1.5">
        <Sparkles size={10} className="text-violet-400 shrink-0" />
        <span>{aiMsg}</span>
        <span className="inline-block w-[2px] h-3 bg-violet-400 animate-pulse" />
      </div>
    </div>
  );
}

function AutomationsDemo({ lang }: { lang: "en" | "fr" }) {
  const steps = lang === "fr"
    ? [
        { kind: "trigger", label: "Si PDF dans Downloads", cls: "bg-pink-500/15 border-pink-400/40 text-pink-300" },
        { kind: "action",  label: "Étiqueter « Reçu »",   cls: "bg-amber-500/15 border-amber-400/40 text-amber-300" },
        { kind: "action",  label: "Déplacer vers /Reçus", cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
      ]
    : [
        { kind: "trigger", label: "When PDF in Downloads", cls: "bg-pink-500/15 border-pink-400/40 text-pink-300" },
        { kind: "action",  label: "Tag as \"Receipt\"",     cls: "bg-amber-500/15 border-amber-400/40 text-amber-300" },
        { kind: "action",  label: "Move to /Receipts",      cls: "bg-emerald-500/15 border-emerald-400/40 text-emerald-300" },
      ];
  const kindLabel = lang === "fr"
    ? { trigger: "DÉCLENCHEUR", action: "ACTION" }
    : { trigger: "TRIGGER",     action: "ACTION" };
  return (
    <div className="flex flex-col items-center gap-1 w-64">
      {steps.map((s, i) => (
        <Fragment key={i}>
          <div className={clsx("w-full px-2.5 py-1.5 rounded border text-[11px] flex items-center gap-2", s.cls)}>
            <span className="text-[8px] tracking-wider opacity-70 font-semibold">
              {kindLabel[s.kind as keyof typeof kindLabel]}
            </span>
            <span className="text-text-primary text-left">{s.label}</span>
          </div>
          {i < steps.length - 1 && <ChevronDown size={12} className="text-text-muted" />}
        </Fragment>
      ))}
    </div>
  );
}

function GitDemo() {
  const files: { status: string; color: string; name: string }[] = [
    { status: "M", color: "text-amber-400",   name: "src/main.rs" },
    { status: "A", color: "text-emerald-400", name: "README.md" },
    { status: "?", color: "text-sky-400",     name: ".env.local" },
  ];
  return (
    <div className="flex flex-col gap-1 w-64">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-surface-3 border border-border">
        <GitBranch size={12} className="text-orange-400" />
        <span className="text-[11px] text-text-primary font-mono">main</span>
        <span className="text-[10px] text-emerald-400">↑2</span>
        <span className="text-[10px] text-text-muted">↓0</span>
      </div>
      {files.map((f) => (
        <div key={f.name} className="flex items-center gap-2.5 px-3 py-1 text-[11px]">
          <span className={clsx("font-mono font-bold w-3 text-center", f.color)}>{f.status}</span>
          <span className="text-text-secondary font-mono text-left">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

function SharingDemo({ lang }: { lang: "en" | "fr" }) {
  return (
    <div className="flex items-center gap-3 w-72 justify-center">
      <div className="flex flex-col items-center gap-1">
        <div className="w-14 h-10 rounded bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center">
          <Laptop size={16} className="text-cyan-400" />
        </div>
        <span className="text-[9px] text-text-muted">{lang === "fr" ? "Toi" : "You"}</span>
      </div>
      <div className="flex flex-col items-center gap-1 px-2">
        <div className="flex items-center gap-0.5">
          <div className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
          <div className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:120ms]" />
          <div className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse [animation-delay:240ms]" />
        </div>
        <span className="text-[9px] font-mono text-cyan-300 mt-1">AB-7K</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="w-14 h-10 rounded bg-cyan-500/20 border border-cyan-400/40 flex items-center justify-center">
          <Laptop size={16} className="text-cyan-400" />
        </div>
        <span className="text-[9px] text-text-muted">{lang === "fr" ? "Invité" : "Guest"}</span>
      </div>
    </div>
  );
}

type Accent = {
  /** Text color for the icon glyph itself. */
  iconText: string;
  /** Soft tint for the icon container's background. */
  iconBg: string;
  /** Glowing orb behind the icon (heavier opacity). Must be a literal Tailwind class
   * so JIT picks it up — don't compose dynamically. */
  blob: string;
  /** Color of the active progress dot. */
  dot: string;
  /** Primary CTA button background — solid color, includes its own hover state. */
  btn: string;
};

type Step = {
  icon: ReactNode;
  accent: Accent;
  title: string;
  body: ReactNode;
  /** Optional mini visual demo replacing the icon. Framing steps (Welcome,
   * "All set") keep the plain icon — the icon IS the moment. */
  visual?: ReactNode;
};

// Per-step palette. Every class must be a STRING LITERAL so Tailwind's JIT
// scanner can find it at build time. Don't generate these with string
// concatenation or `.replace()` — the resulting classes won't exist in the
// final CSS bundle.
const ACCENTS = {
  indigo:  { iconText: "text-indigo-400",  iconBg: "bg-indigo-400/10",  blob: "bg-indigo-500/30",  dot: "bg-indigo-400",  btn: "bg-indigo-500 hover:bg-indigo-400" },
  blue:    { iconText: "text-blue-400",    iconBg: "bg-blue-400/10",    blob: "bg-blue-500/30",    dot: "bg-blue-400",    btn: "bg-blue-500 hover:bg-blue-400" },
  amber:   { iconText: "text-amber-400",   iconBg: "bg-amber-400/10",   blob: "bg-amber-500/30",   dot: "bg-amber-400",   btn: "bg-amber-500 hover:bg-amber-400" },
  emerald: { iconText: "text-emerald-400", iconBg: "bg-emerald-400/10", blob: "bg-emerald-500/30", dot: "bg-emerald-400", btn: "bg-emerald-500 hover:bg-emerald-400" },
  violet:  { iconText: "text-violet-400",  iconBg: "bg-violet-400/10",  blob: "bg-violet-500/30",  dot: "bg-violet-400",  btn: "bg-violet-500 hover:bg-violet-400" },
  pink:    { iconText: "text-pink-400",    iconBg: "bg-pink-400/10",    blob: "bg-pink-500/30",    dot: "bg-pink-400",    btn: "bg-pink-500 hover:bg-pink-400" },
  orange:  { iconText: "text-orange-400",  iconBg: "bg-orange-400/10",  blob: "bg-orange-500/30",  dot: "bg-orange-400",  btn: "bg-orange-500 hover:bg-orange-400" },
  cyan:    { iconText: "text-cyan-400",    iconBg: "bg-cyan-400/10",    blob: "bg-cyan-500/30",    dot: "bg-cyan-400",    btn: "bg-cyan-500 hover:bg-cyan-400" },
  fuchsia: { iconText: "text-fuchsia-400", iconBg: "bg-fuchsia-400/10", blob: "bg-fuchsia-500/30", dot: "bg-fuchsia-400", btn: "bg-fuchsia-500 hover:bg-fuchsia-400" },
} satisfies Record<string, Accent>;

const T = {
  en: {
    skip: "Skip",
    prev: "Previous",
    next: "Next",
    finish: "Get started",
    stepOf: (n: number, total: number) => `${n} of ${total}`,
    steps: (): Step[] => [
      {
        icon: <Zap size={30} />,
        accent: ACCENTS.indigo,
        title: "Welcome to nxs",
        body: (
          <>
            A fast, <b className="text-text-primary">local-first</b> file manager built with Tauri + Rust.
            Nothing leaves your machine. This short tour walks you through the main features —
            press <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">→</kbd> to continue.
          </>
        ),
      },
      {
        icon: <FolderOpen size={30} />,
        accent: ACCENTS.blue,
        title: "Workspaces",
        body: (
          <>
            Group your projects into <b className="text-text-primary">named workspaces</b>. Each one
            has its own folders, tags, open tabs and history. Switch from the sidebar — or use{" "}
            <b className="text-text-primary">Global</b> mode to browse any folder freely.
          </>
        ),
        visual: <WorkspacesDemo />,
      },
      {
        icon: <Tag size={30} />,
        accent: ACCENTS.amber,
        title: "Tags & smart rules",
        body: (
          <>
            Tag files manually or set <b className="text-text-primary">rules</b> that tag them
            automatically (e.g. all <code className="text-[11px] text-amber-300">.mp4</code> → “Video”).
            Combine tags to filter the list, and save any combination as a named view.
          </>
        ),
        visual: <TagsDemo />,
      },
      {
        icon: <Eye size={30} />,
        accent: ACCENTS.emerald,
        title: "Preview & content search",
        body: (
          <>
            Images, video, audio, PDFs, Word, Excel and code all open inside nxs. Text content is
            indexed — search <b className="text-text-primary">inside</b> your documents, not just
            their names. Hit <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Space</kbd> on any file for Quick Look.
          </>
        ),
        visual: <SearchDemo />,
      },
      {
        icon: <Sparkles size={30} />,
        accent: ACCENTS.violet,
        title: "AI assistant",
        body: (
          <>
            Ask nxs to find your last invoices, organize Downloads, tag screenshots, or summarize a
            PDF. The assistant has tools to read, search, tag, and reorganize — and asks for
            confirmation before anything destructive. Works with Ollama (local) or Anthropic.
          </>
        ),
        visual: <AiDemo lang="en" />,
      },
      {
        icon: <Workflow size={30} />,
        accent: ACCENTS.pink,
        title: "Automations",
        body: (
          <>
            Rules that fire on file events: <b className="text-text-primary">when a PDF lands in
            Downloads, tag it and move it to Receipts</b>. Visual builder, dry-run preview, rate
            limiting and cycle detection — Hazel-style automations, built in.
          </>
        ),
        visual: <AutomationsDemo lang="en" />,
      },
      {
        icon: <GitBranch size={30} />,
        accent: ACCENTS.orange,
        title: "Git-aware browsing",
        body: (
          <>
            When you browse a repo, nxs shows <b className="text-text-primary">live status badges</b>,
            inline diffs, branches and recent commits. Read-only — your real git client stays in
            charge. Zero cost when you're not in a repo. Toggle in Settings → Git.
          </>
        ),
        visual: <GitDemo />,
      },
      {
        icon: <Share2 size={30} />,
        accent: ACCENTS.cyan,
        title: "Network sharing",
        body: (
          <>
            Share any workspace with teammates on the same network. Set a password, share the code,
            guests browse in real time with per-folder permissions. No cloud, no account, no
            third-party server.
          </>
        ),
        visual: <SharingDemo lang="en" />,
      },
      {
        icon: <Zap size={30} />,
        accent: ACCENTS.fuchsia,
        title: "You're all set",
        body: (
          <>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">?</kbd> shows all keyboard shortcuts.{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Ctrl+K</kbd> opens the command palette.{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Ctrl+I</kbd> opens the AI.
            You can revisit this tour from Settings → About.
          </>
        ),
      },
    ],
  },
  fr: {
    skip: "Passer",
    prev: "Précédent",
    next: "Suivant",
    finish: "Commencer",
    stepOf: (n: number, total: number) => `${n} sur ${total}`,
    steps: (): Step[] => [
      {
        icon: <Zap size={30} />,
        accent: ACCENTS.indigo,
        title: "Bienvenue dans nxs",
        body: (
          <>
            Un gestionnaire de fichiers rapide et <b className="text-text-primary">local-first</b>,
            en Tauri + Rust. Rien ne quitte ta machine. Ce tour t'introduit les fonctions clés —
            appuie sur <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">→</kbd> pour avancer.
          </>
        ),
      },
      {
        icon: <FolderOpen size={30} />,
        accent: ACCENTS.blue,
        title: "Espaces de travail",
        body: (
          <>
            Regroupe tes projets dans des <b className="text-text-primary">workspaces nommés</b>.
            Chacun a ses dossiers, étiquettes, onglets et historique. Bascule depuis la barre latérale —
            ou utilise <b className="text-text-primary">Global</b> pour parcourir n'importe où.
          </>
        ),
        visual: <WorkspacesDemo />,
      },
      {
        icon: <Tag size={30} />,
        accent: ACCENTS.amber,
        title: "Étiquettes & règles",
        body: (
          <>
            Étiquette manuellement ou laisse les <b className="text-text-primary">règles</b> le
            faire (ex. tous les <code className="text-[11px] text-amber-300">.mp4</code> reçoivent
            « Vidéo »). Combine les étiquettes pour filtrer, enregistre des vues nommées.
          </>
        ),
        visual: <TagsDemo />,
      },
      {
        icon: <Eye size={30} />,
        accent: ACCENTS.emerald,
        title: "Aperçu & recherche par contenu",
        body: (
          <>
            Images, vidéo, audio, PDF, Word, Excel et code s'ouvrent dans nxs. Le texte est indexé —
            cherche <b className="text-text-primary">dans</b> tes documents, pas seulement par nom.{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Espace</kbd> sur un fichier pour Quick Look.
          </>
        ),
        visual: <SearchDemo />,
      },
      {
        icon: <Sparkles size={30} />,
        accent: ACCENTS.violet,
        title: "Assistant IA",
        body: (
          <>
            Demande à nxs de trouver tes factures de janvier, ranger Downloads, étiqueter tes
            captures, résumer un PDF. L'assistant a des outils pour lire, chercher, étiqueter,
            réorganiser — et demande confirmation avant tout acte destructif. Ollama (local) ou Anthropic.
          </>
        ),
        visual: <AiDemo lang="fr" />,
      },
      {
        icon: <Workflow size={30} />,
        accent: ACCENTS.pink,
        title: "Automatisations",
        body: (
          <>
            Des règles qui se déclenchent sur événements : <b className="text-text-primary">quand un
            PDF arrive dans Downloads, étiquette-le et déplace-le vers Reçus</b>. Constructeur
            visuel, aperçu à blanc, anti-boucle. Hazel-style, intégré.
          </>
        ),
        visual: <AutomationsDemo lang="fr" />,
      },
      {
        icon: <GitBranch size={30} />,
        accent: ACCENTS.orange,
        title: "Navigation git",
        body: (
          <>
            Dans un repo, nxs affiche des <b className="text-text-primary">badges de statut live</b>,
            diffs inline, branches et commits récents. Lecture seule — ton vrai client git reste
            maître. Aucun coût hors repo. Activer dans Paramètres → Git.
          </>
        ),
        visual: <GitDemo />,
      },
      {
        icon: <Share2 size={30} />,
        accent: ACCENTS.cyan,
        title: "Partage réseau",
        body: (
          <>
            Partage un workspace avec des collègues sur le même réseau. Mot de passe, code à envoyer,
            les invités parcourent en temps réel avec permissions par dossier. Pas de cloud, pas de
            compte, pas de serveur tiers.
          </>
        ),
        visual: <SharingDemo lang="fr" />,
      },
      {
        icon: <Zap size={30} />,
        accent: ACCENTS.fuchsia,
        title: "C'est parti !",
        body: (
          <>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">?</kbd> liste les raccourcis.{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Ctrl+K</kbd> ouvre la palette.{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-surface-3 text-text-primary text-[10px] font-mono">Ctrl+I</kbd> ouvre l'IA.
            Retrouve ce tour dans Paramètres → À propos.
          </>
        ),
      },
    ],
  },
} as const;

export function OnboardingModal({ onClose }: { onClose: () => void }) {
  const { settings } = useStore();
  const lang = settings.language === "fr" ? "fr" : "en";
  const t = T[lang];
  const steps = t.steps();
  const [step, setStep] = useState(0);
  // Track the direction of the last navigation so the new step animates in
  // from the matching side (forward = right, backward = left). Falls back to
  // forward on direct clicks on a dot (matches user expectation: arbitrary
  // jumps just feel like "another forward step").
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const total = steps.length;
  const current = steps[step];
  const isLast = step === total - 1;

  const goPrev = () => {
    setDirection("backward");
    setStep((s) => Math.max(0, s - 1));
  };
  const goNext = () => {
    if (isLast) { onClose(); return; }
    setDirection("forward");
    setStep((s) => s + 1);
  };
  const goTo = (i: number) => {
    if (i === step) return;
    setDirection(i > step ? "forward" : "backward");
    setStep(i);
  };

  // Keyboard navigation: ← prev, → next, Esc close. Only handled while the
  // modal is mounted (this effect's cleanup removes the listener).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, isLast]);

  const stepInAnim = direction === "forward" ? "onboard-in-forward" : "onboard-in-backward";

  return (
    <div className="onboard-backdrop-in fixed inset-0 z-[600] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="onboard-modal-in bg-surface-1 border border-border rounded-2xl shadow-2xl w-[580px] max-w-[96vw] flex flex-col overflow-hidden relative">

        {/* Close */}
        <div className="flex justify-end px-4 pt-4 relative z-10">
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content — keyed by step so each transition triggers a fresh mount + entrance animation. */}
        <div
          key={step}
          className={clsx(
            "px-10 pb-2 flex flex-col items-center text-center gap-5 min-h-[340px] justify-center relative",
            stepInAnim,
          )}
        >
          {/* Floating blob lives behind the icon OR the demo; either way it picks
              up the step's accent color so the framing stays consistent. The demo,
              when present, replaces the static icon — that IS the visual identity
              of the step. */}
          <div className="relative flex items-center justify-center min-h-[64px]">
            <div
              className={clsx(
                "absolute inset-[-40px] rounded-full blur-3xl onboard-blob pointer-events-none",
                current.accent.blob,
              )}
              aria-hidden
            />
            {current.visual ? (
              <div className="relative onboard-icon-pop">
                {current.visual}
              </div>
            ) : (
              <div
                className={clsx(
                  "relative w-16 h-16 rounded-2xl flex items-center justify-center onboard-icon-pop",
                  current.accent.iconText,
                  current.accent.iconBg,
                )}
              >
                {current.icon}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 relative z-10">
            <h2 className="text-[18px] font-semibold text-text-primary leading-snug tracking-tight">
              {current.title}
            </h2>
            <p className="text-[13px] text-text-secondary leading-relaxed max-w-[420px]">
              {current.body}
            </p>
          </div>

          {/* Step counter — small, low-contrast — gives a sense of length without clutter. */}
          <span className="text-[10px] text-text-muted tabular-nums tracking-wide uppercase">
            {t.stepOf(step + 1, total)}
          </span>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 py-4">
          {steps.map((s, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={clsx(
                "rounded-full transition-all duration-300 ease-out hover:scale-125",
                i === step
                  ? clsx("w-6 h-1.5", s.accent.dot)
                  : i < step
                    ? "w-1.5 h-1.5 bg-surface-5"
                    : "w-1.5 h-1.5 bg-surface-4 hover:bg-surface-5"
              )}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 pb-6 gap-3">
          <button
            onClick={onClose}
            className="text-[12px] text-text-muted hover:text-text-secondary transition-colors"
          >
            {t.skip}
          </button>

          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={goPrev}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 hover:scale-105 active:scale-95 transition-all"
              >
                <ArrowLeft size={12} /> {t.prev}
              </button>
            )}
            <button
              onClick={goNext}
              className={clsx(
                "flex items-center gap-1.5 h-8 px-4 rounded-lg text-white text-[12px] font-medium",
                "hover:scale-105 active:scale-95 shadow-lg transition-all",
                // Per-step accent on the primary button so each screen has its own identity.
                current.accent.btn,
              )}
            >
              {isLast ? t.finish : <>{t.next} <ArrowRight size={12} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
