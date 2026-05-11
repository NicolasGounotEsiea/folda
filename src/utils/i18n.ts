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
  },
};

export function useTranslation(): AppStrings {
  const lang = useStore((s) => s.settings.language);
  return translations[lang] ?? translations.en;
}
