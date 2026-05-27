import { clsx } from "clsx";
import {
  ArrowLeft, ArrowRight, Eye, FolderOpen, Share2, Tag, X, Zap,
} from "lucide-react";
import { useState } from "react";
import { useStore } from "../store/useStore";

const T = {
  en: {
    skip: "Skip",
    prev: "Previous",
    next: "Next",
    finish: "Get started",
    stepOf: (n: number, total: number) => `${n} of ${total}`,
    steps: [
      {
        icon: <Eye size={28} />,
        title: "Welcome to nxs",
        body: "A fast, local-first file manager for Windows built with Tauri & Rust. This short guide walks you through the main features — you can always revisit it from Settings.",
      },
      {
        icon: <FolderOpen size={28} />,
        title: "Workspaces",
        body: "Group your projects into named workspaces. Each workspace has its own folders, tags, open tabs, and navigation history. Switch between them from the top of the sidebar, or use Global mode to browse any folder freely.",
      },
      {
        icon: <Tag size={28} />,
        title: "Tags & Filters",
        body: "Tag files manually or let automatic rules do it for you (e.g. all .mp4 files get a \"Video\" tag). Combine tags to filter the file list, and save any combination as a named view for quick access.",
      },
      {
        icon: <Eye size={28} />,
        title: "Preview & Viewers",
        body: "Images, videos, audio, PDFs and Word documents open right inside nxs. Text and code files open in a built-in editor with syntax highlighting, word wrap, and lightweight version snapshots.",
      },
      {
        icon: <Share2 size={28} />,
        title: "Network Sharing",
        body: "Share any workspace with teammates on the same network. Set a password, share your IP and port, and guests can browse your files in real time. Changes sync automatically — no cloud needed.",
      },
      {
        icon: <Zap size={28} />,
        title: "You're all set!",
        body: "Press ? at any time to see keyboard shortcuts. Use Ctrl+K to open the command palette. You can revisit this guide from Settings → About.",
      },
    ],
  },
  fr: {
    skip: "Passer",
    prev: "Précédent",
    next: "Suivant",
    finish: "Commencer",
    stepOf: (n: number, total: number) => `${n} sur ${total}`,
    steps: [
      {
        icon: <Eye size={28} />,
        title: "Bienvenue dans nxs",
        body: "Un gestionnaire de fichiers local rapide pour Windows, construit avec Tauri & Rust. Ce guide vous présente les fonctionnalités principales — vous pouvez y revenir depuis les Paramètres.",
      },
      {
        icon: <FolderOpen size={28} />,
        title: "Espaces de travail",
        body: "Regroupez vos projets dans des espaces de travail nommés. Chacun possède ses propres dossiers, étiquettes, onglets ouverts et historique. Basculez entre eux depuis le haut de la barre latérale, ou utilisez le mode Global pour naviguer librement.",
      },
      {
        icon: <Tag size={28} />,
        title: "Étiquettes & Filtres",
        body: "Étiquetez les fichiers manuellement ou laissez les règles automatiques le faire (ex. tous les .mp4 reçoivent l'étiquette « Vidéo »). Combinez les étiquettes pour filtrer la liste et enregistrez n'importe quelle combinaison comme vue nommée.",
      },
      {
        icon: <Eye size={28} />,
        title: "Aperçu & Visionneuses",
        body: "Images, vidéos, audio, PDF et documents Word s'ouvrent directement dans nxs. Les fichiers texte et code s'ouvrent dans un éditeur intégré avec coloration syntaxique, retour à la ligne et snapshots de version.",
      },
      {
        icon: <Share2 size={28} />,
        title: "Partage réseau",
        body: "Partagez un espace de travail avec vos collègues sur le même réseau. Définissez un mot de passe, partagez votre IP et port, et les invités parcourent vos fichiers en temps réel. Les modifications se synchronisent automatiquement.",
      },
      {
        icon: <Zap size={28} />,
        title: "C'est parti !",
        body: "Appuyez sur ? pour voir les raccourcis clavier. Utilisez Ctrl+K pour ouvrir la palette de commandes. Retrouvez ce guide depuis Paramètres → À propos.",
      },
    ],
  },
} as const;

const ACCENT_COLORS = [
  "text-indigo-400 bg-indigo-400/10",
  "text-blue-400 bg-blue-400/10",
  "text-amber-400 bg-amber-400/10",
  "text-emerald-400 bg-emerald-400/10",
  "text-pink-400 bg-pink-400/10",
  "text-violet-400 bg-violet-400/10",
];

export function OnboardingModal({ onClose }: { onClose: () => void }) {
  const { settings } = useStore();
  const lang = settings.language === "fr" ? "fr" : "en";
  const t = T[lang];
  const [step, setStep] = useState(0);
  const total = t.steps.length;
  const current = t.steps[step];
  const isLast = step === total - 1;

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-1 border border-border rounded-2xl shadow-2xl w-[520px] max-w-[96vw] flex flex-col overflow-hidden">

        {/* Close */}
        <div className="flex justify-end px-4 pt-4">
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-10 pb-2 flex flex-col items-center text-center gap-5 min-h-[260px] justify-center">
          <div className={clsx(
            "w-16 h-16 rounded-2xl flex items-center justify-center shrink-0",
            ACCENT_COLORS[step % ACCENT_COLORS.length]
          )}>
            {current.icon}
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-[17px] font-semibold text-text-primary leading-snug">
              {current.title}
            </h2>
            <p className="text-[13px] text-text-secondary leading-relaxed max-w-[380px]">
              {current.body}
            </p>
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 py-4">
          {Array.from({ length: total }).map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={clsx(
                "rounded-full transition-all",
                i === step
                  ? "w-5 h-1.5 bg-accent"
                  : "w-1.5 h-1.5 bg-surface-4 hover:bg-surface-4/80"
              )}
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
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
              >
                <ArrowLeft size={12} /> {t.prev}
              </button>
            )}
            <button
              onClick={() => isLast ? onClose() : setStep((s) => s + 1)}
              className="flex items-center gap-1.5 h-8 px-4 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 transition-colors"
            >
              {isLast ? t.finish : <>{t.next} <ArrowRight size={12} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
