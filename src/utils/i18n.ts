import { useStore } from "../store/useStore";

type AppStrings = {
  // ── existing ──────────────────────────────────────────────────────────────
  name: string; size: string; created: string; modified: string;
  tags: string; noTags: string; addTag: string;
  info: string; history: string;
  statistics: string; items: string;
  noActivity: string;
  loading: string;
  calculating: string;
  search: string;
  watching: string;

  // ── common actions ────────────────────────────────────────────────────────
  cancel: string;
  close: string;
  refresh: string;
  save: string;
  create: string;
  emptyVerb: string;     // "Empty" / "Vider" (action button label)

  // ── file operations ───────────────────────────────────────────────────────
  rename: string;
  duplicate: string;
  copy: string;
  cut: string;
  paste: string;
  delete: string;
  select: string;

  // ── files & folders ───────────────────────────────────────────────────────
  file: string;          // lowercase singular
  files: string;         // capitalized header ("Files" / "Fichiers")
  folder: string;        // lowercase singular
  folders: string;       // capitalized header ("Folders" / "Dossiers")
  element: string;       // status-bar singular: "item" / "élément"
  elements: string;      // status-bar plural: "items" / "éléments"
  selectedOne: string;   // "selected" / "sélectionné"
  selectedMany: string;  // "selected" / "sélectionnés"
  emptyFolder: string;
  scanning: string;
  navigateToStart: string;
  newFile: string;
  newFolder: string;

  // ── context menu ─────────────────────────────────────────────────────────
  openWithSystem: string;
  openInEditor: string;
  openInNewWindow: string;
  openFolder: string;
  openInNewTab: string;
  copyPath: string;
  revealInExplorer: string;
  pinToSidebar: string;
  unpinFromSidebar: string;
  bulkRename: string;
  compressToZip: string;
  archiveName: string;

  // ── trash ─────────────────────────────────────────────────────────────────
  trash: string;
  trashIsEmpty: string;
  trashEmptyAction: string;
  trashOriginalLocation: string;
  trashDeletedOn: string;
  trashRestore: string;
  trashDeletePermanently: string;
  trashMoveToTrash: string;
  trashCannotUndo: string;
  today: string;
  yesterday: string;

  // ── archives ──────────────────────────────────────────────────────────────
  archiveReading: string;
  archiveExtractHere: string;
  archiveExtractTo: string;
  archiveFormats: string;
  archiveUnsupported: string;
  archiveOpenWith: string;
  archiveCompressed: string;
  archiveUncompressed: string;
  archiveSaved: string;
  archiveExtracted: string;

  // ── folder picker ─────────────────────────────────────────────────────────
  chooseFolder: string;
  newFolderName: string;

  // sharing
  sharingReconnecting: string;
  sharingConnectedAsGuest: string;
  sharingManageConnection: string;
  sharingActiveShare: string;
  sharingGuest: string;
  sharingGuests: string;
  sharingShare: string;
  sharingJoin: string;

  // AI assistant
  aiTitle: string;
  aiEmptyDesc: string;
  aiSuggestion1: string;
  aiSuggestion2: string;
  aiSuggestion3: string;
  aiThinking: string;
  aiUsingTool: string;
  aiPlaceholder: string;
  aiStop: string;
  aiDisclaimer: string;
  aiDisclaimerOllama: string;
  aiShiftEnter: string;
  // Ollama
  ollamaStatus: string;
  ollamaRunning: string;
  ollamaOffline: string;
  ollamaChecking: string;
  ollamaNotInstalled: string;
  ollamaInstallDesc: string;
  ollamaDownload: string;
  ollamaInstalledModels: string;
  ollamaNoModels: string;
  ollamaDownloadModel: string;
  ollamaPull: string;
  ollamaPulling: string;
  ollamaCustomModel: string;
  ollamaModelPlaceholder: string;
  ollamaModelDone: string;
  ollamaToolWarning: string;
  ollamaRefresh: string;

  // ── Spreadsheet viewer ────────────────────────────────────────────────────
  sheetEdit: string;            // "Edit" / "Éditer"
  sheetSave: string;            // "Save" / "Sauvegarder"
  sheetHeader: string;          // "Header" / "En-tête"
  sheetHeaderToggleOn: string;  // "First row used as header (click to disable)"
  sheetHeaderToggleOff: string; // "Use first row as header"
  sheetFilter: string;          // "Filter" / "Filtrer"
  sheetFilterPlaceholder: string; // "Filter…" / "Filtrer…"
  sheetClearFilter: string;     // tooltip "Clear" / "Effacer"
  sheetCloseFilter: string;     // tooltip "Close" / "Fermer"
  sheetSortActive: string;      // pill "Sort on" / "Tri actif"
  sheetSortClear: string;       // tooltip "Clear sort" / "Annuler le tri"
  sheetSortClick: string;       // tooltip "Click to sort" / "Cliquer pour trier"
  sheetEditing: string;         // status "editing" / "édition en cours"
  sheetEditingHint: string;     // banner "Edit mode — click a cell to modify"
  sheetTruncatedTo: string;     // banner "Display limited to first {n} rows"
  sheetTruncatedStatus: string; // status "truncated to {n}"
  sheetRowSing: string;         // "row" / "ligne"
  sheetRowPlur: string;         // "rows" / "lignes"
  sheetColSing: string;         // "column" / "colonne"
  sheetColPlur: string;         // "columns" / "colonnes"
  sheetSheets: string;          // "sheets" / "feuilles"
  sheetSortedBy: string;        // "sorted by" / "trié par"
  sheetColumnFilters: string;       // toolbar button "Column filters" / "Filtres colonne"
  sheetColumnFiltersShow: string;   // tooltip when hidden
  sheetColumnFiltersHide: string;   // tooltip when shown
  sheetColumnFilterPlaceholder: string;  // input placeholder e.g. "Filter…"
  sheetColumnFiltersActive: string;     // status "{n} column filter(s) active"
  sheetColumnFiltersClearAll: string;   // tooltip on clear-all button
};

const translations: Record<string, AppStrings> = {
  en: {
    name: "Name", size: "Size", created: "Created", modified: "Modified",
    tags: "Tags", noTags: "No tags", addTag: "+ Add",
    info: "Info", history: "History",
    statistics: "Statistics", items: "Items",
    noActivity: "No activity recorded",
    loading: "Loading…",
    calculating: "Calculating…",
    search: "Search…",
    watching: "watching",

    cancel: "Cancel",
    close: "Close",
    refresh: "Refresh",
    save: "Save",
    create: "Create",
    emptyVerb: "Empty",

    rename: "Rename",
    duplicate: "Duplicate",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    delete: "Delete",
    select: "Select",

    file: "file",
    files: "Files",
    folder: "folder",
    folders: "Folders",
    element: "item",
    elements: "items",
    selectedOne: "selected",
    selectedMany: "selected",
    emptyFolder: "Empty folder",
    scanning: "Scanning…",
    navigateToStart: "Navigate to a folder to start",
    newFile: "New file",
    newFolder: "New folder",

    openWithSystem: "Open with system app",
    openInEditor: "Open in editor",
    openInNewWindow: "Open in new window",
    openFolder: "Open folder",
    openInNewTab: "Open in new tab",
    copyPath: "Copy path",
    revealInExplorer: "Reveal in Explorer",
    pinToSidebar: "Pin to sidebar",
    unpinFromSidebar: "Unpin from sidebar",
    bulkRename: "Bulk rename",
    compressToZip: "Compress to ZIP",
    archiveName: "Archive name",

    trash: "Trash",
    trashIsEmpty: "Trash is empty",
    trashEmptyAction: "Empty Trash",
    trashOriginalLocation: "Original location",
    trashDeletedOn: "Deleted",
    trashRestore: "Restore",
    trashDeletePermanently: "Delete permanently",
    trashMoveToTrash: "Move to Trash",
    trashCannotUndo: "This action cannot be undone.",
    today: "Today",
    yesterday: "Yesterday",

    archiveReading: "Reading archive…",
    archiveExtractHere: "Extract here",
    archiveExtractTo: "Extract to…",
    archiveFormats: "Supported formats: ZIP, TAR, TAR.GZ / TGZ",
    archiveUnsupported: "Unsupported format for navigation",
    archiveOpenWith: "Use \"Open with system app\"",
    archiveCompressed: "Compressed",
    archiveUncompressed: "uncompressed",
    archiveSaved: "saved",
    archiveExtracted: "files extracted",

    chooseFolder: "Choose a folder",
    newFolderName: "New folder name",

    sharingReconnecting: "Reconnecting…",
    sharingConnectedAsGuest: "Connected as guest",
    sharingManageConnection: "Manage connection",
    sharingActiveShare: "Active share",
    sharingGuest: "guest",
    sharingGuests: "guests",
    sharingShare: "Share",
    sharingJoin: "Join",

    aiTitle: "AI Assistant",
    aiEmptyDesc: "Ask me anything about your files — I can browse folders, search, read files, and help you organize.",
    aiSuggestion1: "What's in this folder?",
    aiSuggestion2: "Find all PDF files",
    aiSuggestion3: "What are my recent files?",
    aiThinking: "Thinking…",
    aiUsingTool: "Using tool:",
    aiPlaceholder: "Ask about your files… (Enter to send)",
    aiStop: "Stop",
    aiDisclaimer: "File paths may be sent to Anthropic",
    aiDisclaimerOllama: "Everything stays local — no data leaves your machine",
    aiShiftEnter: "Shift+Enter for new line",
    ollamaStatus: "Ollama status",
    ollamaRunning: "Ollama is running",
    ollamaOffline: "Ollama not detected",
    ollamaChecking: "Checking…",
    ollamaNotInstalled: "Ollama is not installed or not running",
    ollamaInstallDesc: "Ollama lets you run AI models locally for free. Install it once, then come back here to download a model.",
    ollamaDownload: "Download Ollama (free)",
    ollamaInstalledModels: "Installed models",
    ollamaNoModels: "No models installed yet",
    ollamaDownloadModel: "Download a model",
    ollamaPull: "Download",
    ollamaPulling: "Downloading…",
    ollamaCustomModel: "Custom model name",
    ollamaModelPlaceholder: "e.g. mistral:7b",
    ollamaModelDone: "Model ready",
    ollamaToolWarning: "This model may not support tools — responses may be text-only",
    ollamaRefresh: "Refresh",

    // Spreadsheet
    sheetEdit: "Edit",
    sheetSave: "Save",
    sheetHeader: "Header",
    sheetHeaderToggleOn: "First row used as header (click to disable)",
    sheetHeaderToggleOff: "Use first row as header",
    sheetFilter: "Filter",
    sheetFilterPlaceholder: "Filter…",
    sheetClearFilter: "Clear",
    sheetCloseFilter: "Close",
    sheetSortActive: "Sort on",
    sheetSortClear: "Clear sort",
    sheetSortClick: "Click to sort",
    sheetEditing: "editing",
    sheetEditingHint: "Edit mode — click a cell to modify",
    sheetTruncatedTo: "Display limited to first {n} rows",
    sheetTruncatedStatus: "truncated to {n}",
    sheetRowSing: "row",
    sheetRowPlur: "rows",
    sheetColSing: "column",
    sheetColPlur: "columns",
    sheetSheets: "sheets",
    sheetSortedBy: "sorted by",
    sheetColumnFilters: "Column filters",
    sheetColumnFiltersShow: "Show column filters",
    sheetColumnFiltersHide: "Hide column filters",
    sheetColumnFilterPlaceholder: "Filter…",
    sheetColumnFiltersActive: "{n} column filter(s) active",
    sheetColumnFiltersClearAll: "Clear all column filters",
  },

  fr: {
    name: "Nom", size: "Taille", created: "Créé le", modified: "Modifié",
    tags: "Étiquettes", noTags: "Aucune étiquette", addTag: "+ Ajouter",
    info: "Infos", history: "Historique",
    statistics: "Statistiques", items: "Éléments",
    noActivity: "Aucune activité enregistrée",
    loading: "Chargement…",
    calculating: "Calcul…",
    search: "Rechercher…",
    watching: "surveillance",

    cancel: "Annuler",
    close: "Fermer",
    refresh: "Rafraîchir",
    save: "Enregistrer",
    create: "Créer",
    emptyVerb: "Vider",

    rename: "Renommer",
    duplicate: "Dupliquer",
    copy: "Copier",
    cut: "Couper",
    paste: "Coller",
    delete: "Supprimer",
    select: "Sélectionner",

    file: "fichier",
    files: "Fichiers",
    folder: "dossier",
    folders: "Dossiers",
    element: "élément",
    elements: "éléments",
    selectedOne: "sélectionné",
    selectedMany: "sélectionnés",
    emptyFolder: "Dossier vide",
    scanning: "Analyse en cours…",
    navigateToStart: "Naviguez vers un dossier pour commencer",
    newFile: "Nouveau fichier",
    newFolder: "Nouveau dossier",

    openWithSystem: "Ouvrir avec l'app système",
    openInEditor: "Ouvrir dans l'éditeur",
    openInNewWindow: "Ouvrir dans une nouvelle fenêtre",
    openFolder: "Ouvrir le dossier",
    openInNewTab: "Ouvrir dans un nouvel onglet",
    copyPath: "Copier le chemin",
    revealInExplorer: "Afficher dans l'Explorateur",
    pinToSidebar: "Épingler dans la barre latérale",
    unpinFromSidebar: "Détacher de la barre latérale",
    bulkRename: "Renommer en masse",
    compressToZip: "Compresser en ZIP",
    archiveName: "Nom de l'archive",

    trash: "Corbeille",
    trashIsEmpty: "La corbeille est vide",
    trashEmptyAction: "Vider la corbeille",
    trashOriginalLocation: "Emplacement d'origine",
    trashDeletedOn: "Supprimé le",
    trashRestore: "Restaurer",
    trashDeletePermanently: "Supprimer définitivement",
    trashMoveToTrash: "Déplacer à la corbeille",
    trashCannotUndo: "Cette action est irréversible.",
    today: "Aujourd'hui",
    yesterday: "Hier",

    archiveReading: "Lecture de l'archive…",
    archiveExtractHere: "Extraire ici",
    archiveExtractTo: "Extraire vers…",
    archiveFormats: "Formats supportés : ZIP, TAR, TAR.GZ / TGZ",
    archiveUnsupported: "Format non supporté pour la navigation",
    archiveOpenWith: "Utilisez « Ouvrir avec l'app système »",
    archiveCompressed: "Compressé",
    archiveUncompressed: "non compressé",
    archiveSaved: "économisé",
    archiveExtracted: "fichiers extraits",

    chooseFolder: "Choisir un dossier",
    newFolderName: "Nom du nouveau dossier",

    sharingReconnecting: "Reconnexion…",
    sharingConnectedAsGuest: "Connecté en tant qu'invité",
    sharingManageConnection: "Gérer la connexion",
    sharingActiveShare: "Partage actif",
    sharingGuest: "invité",
    sharingGuests: "invités",
    sharingShare: "Partager",
    sharingJoin: "Rejoindre",

    aiTitle: "Assistant IA",
    aiEmptyDesc: "Posez-moi des questions sur vos fichiers — je peux parcourir les dossiers, rechercher, lire des fichiers et vous aider à organiser.",
    aiSuggestion1: "Qu'est-ce qu'il y a dans ce dossier ?",
    aiSuggestion2: "Trouver tous les PDF",
    aiSuggestion3: "Quels sont mes fichiers récents ?",
    aiThinking: "Réflexion en cours…",
    aiUsingTool: "Utilisation de l'outil :",
    aiPlaceholder: "Posez une question sur vos fichiers… (Entrée pour envoyer)",
    aiStop: "Arrêter",
    aiDisclaimer: "Les chemins de fichiers peuvent être envoyés à Anthropic",
    aiDisclaimerOllama: "Tout reste local — aucune donnée ne quitte votre machine",
    aiShiftEnter: "Maj+Entrée pour nouvelle ligne",
    ollamaStatus: "Statut d'Ollama",
    ollamaRunning: "Ollama est actif",
    ollamaOffline: "Ollama non détecté",
    ollamaChecking: "Vérification…",
    ollamaNotInstalled: "Ollama n'est pas installé ou n'est pas actif",
    ollamaInstallDesc: "Ollama vous permet d'exécuter des modèles IA localement et gratuitement. Installez-le une fois, puis revenez ici pour télécharger un modèle.",
    ollamaDownload: "Télécharger Ollama (gratuit)",
    ollamaInstalledModels: "Modèles installés",
    ollamaNoModels: "Aucun modèle installé",
    ollamaDownloadModel: "Télécharger un modèle",
    ollamaPull: "Télécharger",
    ollamaPulling: "Téléchargement…",
    ollamaCustomModel: "Nom de modèle personnalisé",
    ollamaModelPlaceholder: "ex. mistral:7b",
    ollamaModelDone: "Modèle prêt",
    ollamaToolWarning: "Ce modèle ne supporte peut-être pas les outils — les réponses peuvent être en texte uniquement",
    ollamaRefresh: "Rafraîchir",

    // Spreadsheet
    sheetEdit: "Éditer",
    sheetSave: "Sauvegarder",
    sheetHeader: "En-tête",
    sheetHeaderToggleOn: "Première ligne utilisée comme en-tête (cliquer pour désactiver)",
    sheetHeaderToggleOff: "Activer la première ligne comme en-tête",
    sheetFilter: "Filtrer",
    sheetFilterPlaceholder: "Filtrer…",
    sheetClearFilter: "Effacer",
    sheetCloseFilter: "Fermer",
    sheetSortActive: "Tri actif",
    sheetSortClear: "Annuler le tri",
    sheetSortClick: "Cliquer pour trier",
    sheetEditing: "édition en cours",
    sheetEditingHint: "Mode édition — cliquez une cellule pour modifier",
    sheetTruncatedTo: "Affichage limité aux {n} premières lignes",
    sheetTruncatedStatus: "tronqué à {n}",
    sheetRowSing: "ligne",
    sheetRowPlur: "lignes",
    sheetColSing: "colonne",
    sheetColPlur: "colonnes",
    sheetSheets: "feuilles",
    sheetSortedBy: "trié par",
    sheetColumnFilters: "Filtres colonne",
    sheetColumnFiltersShow: "Afficher les filtres par colonne",
    sheetColumnFiltersHide: "Masquer les filtres par colonne",
    sheetColumnFilterPlaceholder: "Filtrer…",
    sheetColumnFiltersActive: "{n} filtre(s) colonne actif(s)",
    sheetColumnFiltersClearAll: "Effacer tous les filtres colonne",
  },
};

export function useTranslation(): AppStrings {
  const lang = useStore((s) => s.settings.language);
  return translations[lang] ?? translations.en;
}
